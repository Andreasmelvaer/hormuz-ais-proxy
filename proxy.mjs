/**
 * AISstream WebSocket proxy for Hormuz Tracker.
 * Deployed on Fly.io — connects to AISstream server-side,
 * relays AIS messages to browser clients via WebSocket.
 */

import { WebSocketServer, WebSocket } from 'ws';

const API_KEY = process.env.AISSTREAM_API_KEY || '';
if (!API_KEY) {
  console.error('No AISSTREAM_API_KEY env var set');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '8080', 10);
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';

// Strait of Hormuz bounding box
const BBOX = [[[25.8, 55.5], [27.2, 57.2]]];

let messageCount = 0;
let upstreamConnected = false;
let upstream = null;
const clients = new Set();

function connectUpstream() {
  if (upstream && upstream.readyState === WebSocket.OPEN) return;

  console.log('[proxy] Connecting to AISstream.io...');
  upstream = new WebSocket(AIS_URL);

  upstream.on('open', () => {
    console.log('[proxy] Connected to AISstream. Subscribing...');
    upstreamConnected = true;
    upstream.send(JSON.stringify({
      APIKey: API_KEY,
      BoundingBoxes: BBOX,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
  });

  upstream.on('message', (data) => {
    messageCount++;
    const msg = data.toString();
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
    if (messageCount % 100 === 0) {
      console.log(`[proxy] ${messageCount} msgs -> ${clients.size} client(s)`);
    }
  });

  upstream.on('error', (err) => {
    console.error('[proxy] Upstream error:', err.message);
    upstreamConnected = false;
  });

  upstream.on('close', () => {
    console.log('[proxy] Upstream disconnected. Reconnecting in 5s...');
    upstreamConnected = false;
    upstream = null;
    setTimeout(connectUpstream, 5000);
  });
}

// WebSocket server
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[proxy] Client connected (${clients.size} total)`);

  ws.send(JSON.stringify({
    type: 'proxy_status',
    connected: upstreamConnected,
    messageCount,
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[proxy] Client disconnected (${clients.size} total)`);
  });
});

connectUpstream();
console.log(`[proxy] Listening on port ${PORT}`);
