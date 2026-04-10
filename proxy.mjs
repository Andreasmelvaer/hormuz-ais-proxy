/**
 * AISstream WebSocket proxy for Hormuz Tracker.
 * HTTP server with WebSocket upgrade — works on Render, Fly.io, etc.
 */

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const API_KEY = process.env.AISSTREAM_API_KEY || '';
if (!API_KEY) {
  console.error('No AISSTREAM_API_KEY env var set');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '10000', 10);
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';

// Strait of Hormuz bounding box
const BBOX = [[[25.8, 55.5], [27.2, 57.2]]];

let messageCount = 0;
let upstreamConnected = false;
let upstream = null;
let reconnectDelay = 5000;
const clients = new Set();

function connectUpstream() {
  if (upstream && upstream.readyState === WebSocket.OPEN) return;

  console.log(`[proxy] Connecting to AISstream.io (retry in ${reconnectDelay/1000}s on fail)...`);

  try {
    upstream = new WebSocket(AIS_URL);
  } catch (err) {
    console.error('[proxy] Failed to create WebSocket:', err.message);
    scheduleReconnect();
    return;
  }

  upstream.on('open', () => {
    console.log('[proxy] Connected to AISstream. Subscribing...');
    upstreamConnected = true;
    reconnectDelay = 5000; // reset backoff on success
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
    console.log('[proxy] Upstream disconnected.');
    upstreamConnected = false;
    upstream = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  console.log(`[proxy] Reconnecting in ${reconnectDelay/1000}s...`);
  setTimeout(connectUpstream, reconnectDelay);
  // Exponential backoff: 5s -> 10s -> 20s -> 40s -> max 60s
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
}

// HTTP server — needed for Render health checks and WebSocket upgrade
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    upstream: upstreamConnected,
    clients: clients.size,
    messages: messageCount,
  }));
});

// WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });

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

// Start HTTP server first, THEN connect upstream
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] HTTP + WS server listening on 0.0.0.0:${PORT}`);

  // Delay upstream connect to let server fully start
  setTimeout(connectUpstream, 1000);

  // Self-ping to prevent Render free tier spin-down
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    console.log(`[proxy] Self-ping enabled: ${RENDER_URL}`);
    setInterval(() => {
      fetch(RENDER_URL).catch(() => {});
    }, 4 * 60 * 1000);
  }
});
