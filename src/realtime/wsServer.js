// src/realtime/wsServer.js
const WebSocket = require("ws");
let wss = null;

/**
 * Start a WebSocket server mounted on the provided HTTP server at path /ws.
 * Returns the wss instance.
 */
function startWs(httpServer) {
  if (wss) return wss;
  wss = new WebSocket.Server({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws, req) => {
    ws.send(JSON.stringify({ type: "welcome", ts: Date.now() }));
  });
  console.log("WebSocket server started at /ws");
  return wss;
}

/**
 * Broadcast an object to all connected clients (JSON-stringified).
 */
function broadcast(obj) {
  if (!wss) return;
  const payload = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(payload); } catch (e) { /* ignore per-client errors */ }
    }
  });
}

module.exports = { startWs, broadcast };
