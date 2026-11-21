import http from "node:http";
import { WebSocketServer } from "ws";
import { ensureConfig, isAllowedOrigin, verifyToken } from "./config.mjs";

const cfg = ensureConfig();
const PORT = Number(process.env.AG_CHROME_PORT || cfg.port);
const HOST = cfg.host; // Strictly 127.0.0.1
const TOKEN = process.env.AG_CHROME_TOKEN || cfg.token;

let extensionSocket = null;
let extensionMeta = {
  connected: false,
  connectedAt: null,
  lastHeartbeatAt: null,
  extensionId: null,
  extensionVersion: null,
  state: null,
};

const mcpClients = new Set();
let nextHubReqId = 1;
const pendingRequests = new Map(); // hubReqId -> { client, originalId, timer, action, startedAt }
const recentEvents = [];

function recordEvent(entry) {
  recentEvents.push({ ts: Date.now(), ...entry });
  if (recentEvents.length > 50) recentEvents.shift();
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function failAllPending(reason) {
  for (const [hubId, req] of pendingRequests.entries()) {
    clearTimeout(req.timer);
    safeSend(req.client, {
      type: "response",
      id: req.originalId,
      ok: false,
      error: reason,
    });
    pendingRequests.delete(hubId);
  }
}

function broadcastHubStatus() {
  const payload = {
    type: "hub_status",
    extensionConnected: Boolean(extensionSocket && extensionSocket.readyState === extensionSocket.OPEN),
    extensionMeta,
    clientCount: mcpClients.size,
  };
  for (const c of mcpClients) {
    safeSend(c, payload);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    const extConnected = Boolean(
      extensionSocket && extensionSocket.readyState === extensionSocket.OPEN,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        port: PORT,
        extensionConnected: extConnected,
        clientCount: mcpClients.size,
        uptimeSec: Math.round(process.uptime()),
      }),
    );
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024 * 1024, // 32 MiB for high-res fullPage screenshots / network bodies
});

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const queryToken = url.searchParams.get("token") || "";
  const providedToken = bearer || queryToken;

  if (!verifyToken(providedToken, TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const role = url.searchParams.get("role") || "client";
  if (role !== "extension" && role !== "client") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, role, origin || null);
  });
});

wss.on("connection", (ws, _req, role, origin) => {
  if (role === "extension") {
    if (extensionSocket && extensionSocket !== ws) {
      try {
        extensionSocket.close(4000, "Replaced by newer extension connection");
      } catch {}
    }
    extensionSocket = ws;
    extensionMeta = {
      connected: true,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      extensionId: origin ? origin.replace("chrome-extension://", "") : null,
      extensionVersion: null,
      state: null,
    };
    recordEvent({ kind: "extension_connected", extensionId: extensionMeta.extensionId });
    safeSend(ws, { type: "welcome", hubPid: process.pid, clientCount: mcpClients.size });
    broadcastHubStatus();

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.type === "ping") {
        extensionMeta.lastHeartbeatAt = Date.now();
        safeSend(ws, { type: "pong", ts: Date.now(), clientCount: mcpClients.size });
        return;
      }

      if (msg.type === "hello") {
        extensionMeta.extensionVersion = msg.version || null;
        extensionMeta.state = msg.state || null;
        extensionMeta.lastHeartbeatAt = Date.now();
        broadcastHubStatus();
        return;
      }

      if (msg.type === "state_update") {
        extensionMeta.state = msg.state || null;
        broadcastHubStatus();
        return;
      }

      if (msg.type === "response" && msg.id != null) {
        const reqEntry = pendingRequests.get(msg.id);
        if (!reqEntry) return;
        clearTimeout(reqEntry.timer);
        pendingRequests.delete(msg.id);
        const latencyMs = Date.now() - reqEntry.startedAt;
        safeSend(reqEntry.client, {
          type: "response",
          id: reqEntry.originalId,
          ok: Boolean(msg.ok),
          result: msg.result,
          error: msg.error,
          latencyMs,
        });
      }
    });

    ws.on("close", () => {
      if (extensionSocket === ws) {
        extensionSocket = null;
        extensionMeta.connected = false;
        recordEvent({ kind: "extension_disconnected" });
        failAllPending("Chrome extension disconnected while executing command");
        broadcastHubStatus();
      }
    });

    ws.on("error", () => {
      // handled by close
    });
    return;
  }

  // role === "client" (Antigravity MCP stdio server instance)
  mcpClients.add(ws);
  safeSend(ws, {
    type: "hub_status",
    extensionConnected: Boolean(
      extensionSocket && extensionSocket.readyState === extensionSocket.OPEN,
    ),
    extensionMeta,
    clientCount: mcpClients.size,
  });
  if (extensionSocket) {
    safeSend(extensionSocket, { type: "client_count", count: mcpClients.size });
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", ts: Date.now() });
      return;
    }

    if (msg.type === "hub_info") {
      safeSend(ws, {
        type: "response",
        id: msg.id,
        ok: true,
        result: {
          hubPid: process.pid,
          host: HOST,
          port: PORT,
          extensionConnected: Boolean(
            extensionSocket && extensionSocket.readyState === extensionSocket.OPEN,
          ),
          extensionMeta,
          clientCount: mcpClients.size,
          recentEvents: recentEvents.slice(-15),
        },
      });
      return;
    }

    if (msg.type === "request") {
      if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
        safeSend(ws, {
          type: "response",
          id: msg.id,
          ok: false,
          error:
            "Antigravity Chrome extension is not connected. Run 'npm run setup', load the unpacked extension/ folder in chrome://extensions, and verify the badge shows ON.",
        });
        return;
      }

      const hubId = `h_${nextHubReqId++}`;
      const timeoutMs = Math.min(Math.max(Number(msg.timeoutMs) || 35000, 1000), 180000);
      const timer = setTimeout(() => {
        pendingRequests.delete(hubId);
        safeSend(ws, {
          type: "response",
          id: msg.id,
          ok: false,
          error: `Timed out after ${timeoutMs}ms waiting for Chrome extension on action '${msg.action}'`,
        });
      }, timeoutMs);

      pendingRequests.set(hubId, {
        client: ws,
        originalId: msg.id,
        timer,
        action: msg.action,
        startedAt: Date.now(),
      });

      safeSend(extensionSocket, {
        type: "request",
        id: hubId,
        action: msg.action,
        params: msg.params || {},
      });
    }
  });

  ws.on("close", () => {
    mcpClients.delete(ws);
    for (const [hubId, req] of pendingRequests.entries()) {
      if (req.client === ws) {
        clearTimeout(req.timer);
        pendingRequests.delete(hubId);
      }
    }
    if (extensionSocket) {
      safeSend(extensionSocket, { type: "client_count", count: mcpClients.size });
    }
  });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    // Another hub is already running on this port — exit cleanly.
    process.exit(0);
  }
  console.error("[antigravity-chrome-hub] error:", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.error(`[antigravity-chrome-hub] listening on ws://${HOST}:${PORT} (pid=${process.pid})`);
});

function shutdown() {
  failAllPending("Hub shutting down");
  try {
    wss.close();
    server.close();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
