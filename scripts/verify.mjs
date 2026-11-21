import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("=== 1. Syntax, Manifest & Secret Hygiene Checks ===");
const jsFiles = [
  "server/config.mjs",
  "server/hub.mjs",
  "server/mcp-server.mjs",
  "scripts/init-config.mjs",
  "scripts/generate-icons.mjs",
  "scripts/setup.mjs",
  "extension/content-engine.js",
  "extension/background.js",
  "extension/panel.js",
];
for (const rel of jsFiles) {
  const full = path.join(ROOT, rel);
  assert.ok(fs.existsSync(full), `Missing file: ${rel}`);
  const chk = spawnSync(process.execPath, ["--check", full], { encoding: "utf8" });
  assert.equal(chk.status, 0, `Syntax error in ${rel}: ${chk.stderr}`);
}

const manifestPath = path.join(ROOT, "extension", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "2.0.0");
for (const sz of ["16", "32", "48", "128"]) {
  const iconFile = path.join(ROOT, "extension", manifest.icons[sz]);
  assert.ok(fs.existsSync(iconFile), `Missing icon: ${iconFile}`);
  assert.ok(fs.statSync(iconFile).size > 100, `Icon too small: ${iconFile}`);
}
const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
assert.ok(gitignore.includes("extension/bridge.config.json"), ".gitignore must exclude bridge.config.json");
console.log("PASS: All JS files, MV3 manifest, icons, and .gitignore verified.");

console.log("=== 2. Starting Test Hub & Checking CSWSH / Auth Security ===");
const TEST_PORT = 18892;
const TEST_TOKEN = crypto.randomBytes(32).toString("hex");
const hubProc = spawn(process.execPath, [path.join(ROOT, "server", "hub.mjs")], {
  env: {
    ...process.env,
    AG_CHROME_PORT: String(TEST_PORT),
    AG_CHROME_TOKEN: TEST_TOKEN,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Test hub failed to start");
}

function expectWsRejected(url, headers, expectedStatus) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => {
      ws.close();
      reject(new Error(`Expected HTTP ${expectedStatus} rejection, but WS opened`));
    });
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === expectedStatus) resolve();
      else reject(new Error(`Expected HTTP ${expectedStatus}, got ${res.statusCode}`));
    });
    ws.on("error", () => {});
  });
}

function spawnMcpClient() {
  const p = spawn(process.execPath, [path.join(ROOT, "server", "mcp-server.mjs")], {
    env: {
      ...process.env,
      AG_CHROME_PORT: String(TEST_PORT),
      AG_CHROME_TOKEN: TEST_TOKEN,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = new Map();
  p.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && waiters.has(msg.id)) {
        const fn = waiters.get(msg.id);
        waiters.delete(msg.id);
        fn(msg);
      }
    }
  });
  let reqId = 1;
  return {
    proc: p,
    call(method, params = {}) {
      const id = reqId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 10000);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method, params = {}) {
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    close() {
      p.kill();
    },
  };
}

try {
  const health = await waitForHealth();
  assert.equal(health.ok, true);

  await expectWsRejected(
    `ws://127.0.0.1:${TEST_PORT}/?role=extension&token=${TEST_TOKEN}`,
    { Origin: "https://evil.example" },
    403,
  );
  await expectWsRejected(
    `ws://127.0.0.1:${TEST_PORT}/?role=extension&token=wrong_token`,
    { Origin: "chrome-extension://abcdefghijklmnop" },
    401,
  );
  console.log("PASS: Hub blocks untrusted web origins (403) and invalid tokens (401).");

  console.log("=== 3. Simulating v2 Extension + Two Concurrent MCP Stdio Clients ===");
  const mockExt = new WebSocket(
    `ws://127.0.0.1:${TEST_PORT}/?role=extension&token=${TEST_TOKEN}`,
    { headers: { Origin: "chrome-extension://testextensionid" } },
  );
  await new Promise((res, rej) => {
    mockExt.once("open", res);
    mockExt.once("error", rej);
  });

  mockExt.on("message", (raw) => {
    const msg = JSON.parse(raw.toString("utf8"));
    if (msg.type !== "request") return;
    const handlers = {
      status: () => ({ version: "2.0.0", paused: false, scope: "all" }),
      snapshot: () => ({
        tabId: 42,
        url: "https://example.com",
        title: "Example",
        frameCount: 2,
        elementCount: 3,
        elements: '[1] link "Docs"\n--- iframe [f7] https://embed.example ---\n[f7:1] button "Pay"',
      }),
      find: () => ({ tabId: 42, count: 1, matches: '[f7:1] button "Pay"' }),
      hover: () => ({ tabId: 42, hovered: true, ref: msg.params.ref }),
      drag: () => ({ tabId: 42, dragged: true, from: { x: 10, y: 10 }, to: { x: 110, y: 10 } }),
      batch: () => ({
        tabId: 42,
        completed: true,
        results: msg.params.steps.map((s, i) => ({ step: i + 1, action: s.action, ok: true })),
      }),
    };
    const fn = handlers[msg.action];
    if (fn) {
      mockExt.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: fn() }));
    }
  });

  const c1 = spawnMcpClient();
  const c2 = spawnMcpClient();
  try {
    const [init1, init2] = await Promise.all([
      c1.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-1", version: "2.0" },
      }),
      c2.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-2", version: "2.0" },
      }),
    ]);
    assert.equal(init1.result.serverInfo.name, "antigravity-chrome");
    assert.equal(init1.result.serverInfo.version, "2.0.0");
    assert.equal(init2.result.serverInfo.name, "antigravity-chrome");
    c1.notify("notifications/initialized");
    c2.notify("notifications/initialized");

    const listResp = await c1.call("tools/list");
    const toolNames = listResp.result.tools.map((t) => t.name);
    assert.equal(toolNames.length, 21, `Expected 21 tools, got ${toolNames.length}`);
    for (const required of ["browser_find", "browser_hover", "browser_drag", "browser_batch", "browser_snapshot"]) {
      assert.ok(toolNames.includes(required), `Missing tool: ${required}`);
    }

    const t0 = Date.now();
    const [r1, r2, r3, r4, r5] = await Promise.all([
      c1.call("tools/call", { name: "browser_status", arguments: {} }),
      c2.call("tools/call", { name: "browser_snapshot", arguments: { includeFrames: true } }),
      c1.call("tools/call", { name: "browser_find", arguments: { query: "Pay" } }),
      c2.call("tools/call", { name: "browser_hover", arguments: { ref: "f7:1" } }),
      c1.call("tools/call", {
        name: "browser_batch",
        arguments: {
          steps: [
            { action: "hover", ref: 1 },
            { action: "click", ref: "f7:1" },
            { action: "assert_url", urlIncludes: "example.com" },
          ],
        },
      }),
    ]);
    const elapsed = Date.now() - t0;

    assert.equal(JSON.parse(r1.result.content[0].text).connected, true);
    assert.equal(JSON.parse(r2.result.content[0].text).frameCount, 2);
    assert.equal(JSON.parse(r3.result.content[0].text).count, 1);
    assert.equal(JSON.parse(r4.result.content[0].text).hovered, true);
    assert.equal(JSON.parse(r5.result.content[0].text).completed, true);

    console.log(
      `PASS: 2 concurrent MCP clients verified (${toolNames.length} tools, 5 parallel round-trips incl. iframe refs in ${elapsed}ms).`,
    );
  } finally {
    c1.close();
    c2.close();
    mockExt.close();
  }
} finally {
  hubProc.kill();
}
console.log("=== ALL v2.0.0 CHECKS PASSED ===");
