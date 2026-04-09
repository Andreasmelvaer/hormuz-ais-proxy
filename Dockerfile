FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY proxy.mjs .
EXPOSE 8080
CMD ["node", "proxy.mjs"]
