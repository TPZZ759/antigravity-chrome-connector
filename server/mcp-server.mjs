import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { z } from "zod";
import { ensureConfig } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_SCRIPT = path.join(__dirname, "hub.mjs");

const cfg = ensureConfig();
const HOST = cfg.host;
const PORT = Number(process.env.AG_CHROME_PORT || cfg.port);
const TOKEN = process.env.AG_CHROME_TOKEN || cfg.token;

// Accepts main-frame numeric refs (12 or "12") or subframe refs ("f42:7")
const RefSchema = z
  .union([z.number().int(), z.string()])
  .describe("Element ref from browser_snapshot or browser_find (e.g. 12 for main frame, or 'f42:7' for an iframe).");

function checkHubHealth(timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: "/health", timeout: timeoutMs },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(Boolean(parsed && parsed.ok));
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureHubRunning() {
  if (await checkHubHealth()) return true;
  const child = spawn(process.execPath, [HUB_SCRIPT], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      AG_CHROME_PORT: String(PORT),
      AG_CHROME_TOKEN: TOKEN,
    },
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await checkHubHealth(400)) return true;
  }
  return false;
}

class HubClient {
  constructor() {
    this.ws = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const ok = await ensureHubRunning();
      if (!ok) {
        throw new Error(`Failed to start local Antigravity Chrome Hub on ws://${HOST}:${PORT}`);
      }

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${HOST}:${PORT}/?role=client`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {}
          reject(new Error("Timed out connecting to local Antigravity Chrome Hub"));
        }, 5000);

        ws.once("open", () => {
          clearTimeout(timer);
          this.ws = ws;
          this.attachListeners(ws);
          resolve();
        });
        ws.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  attachListeners(ws) {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (msg.type === "response" && msg.id != null) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.ok) {
          entry.resolve({ result: msg.result, latencyMs: msg.latencyMs });
        } else {
          entry.reject(new Error(msg.error || "Unknown browser extension error"));
        }
      }
    });

    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Disconnected from local Antigravity Chrome Hub"));
        this.pending.delete(id);
      }
    });
  }

  async call(action, params = {}, timeoutMs = 35000, msgType = "request") {
    await this.connect();
    const id = `c_${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${timeoutMs}ms calling '${action}'`));
      }, timeoutMs + 2000);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({
          type: msgType,
          id,
          action,
          params,
          timeoutMs,
        }),
      );
    });
  }
}

const hub = new HubClient();

function textResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorResult(err) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  };
}

async function runExtensionTool(action, params = {}, timeoutMs = 35000) {
  try {
    const { result, latencyMs } = await hub.call(action, params, timeoutMs);
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return textResult({ ...result, _latencyMs: latencyMs });
    }
    return textResult(result);
  } catch (err) {
    return errorResult(err);
  }
}

const server = new McpServer({
  name: "antigravity-chrome",
  version: "2.0.0",
});

server.tool(
  "browser_status",
  "Check Antigravity Chrome extension connection status, hub health, pause/scope settings, active tab, and attached CDP tabs.",
  {},
  async () => {
    try {
      const hubInfo = await hub.call("hub_info", {}, 5000, "hub_info");
      if (!hubInfo.result.extensionConnected) {
        return textResult({
          connected: false,
          hub: hubInfo.result,
          setupHint:
            "Run 'npm run setup', open chrome://extensions, enable Developer Mode, and Load unpacked on the extension/ folder.",
        });
      }
      const extStatus = await hub.call("status", {}, 5000);
      return textResult({
        connected: true,
        latencyMs: extStatus.latencyMs,
        hub: {
          port: hubInfo.result.port,
          clientCount: hubInfo.result.clientCount,
        },
        extension: extStatus.result,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "browser_tabs",
  "List, open, focus, close, reload, or organize Chrome tabs (supports dedicated purple 'Antigravity' Chrome tab group).",
  {
    action: z.enum(["list", "open", "focus", "close", "reload", "group"]).default("list"),
    tabId: z.number().int().optional(),
    url: z.string().optional(),
    active: z.boolean().optional().default(true),
    inGroup: z.boolean().optional().default(true),
    bypassCache: z.boolean().optional().default(false),
  },
  async (params) => runExtensionTool("tabs", params),
);

server.tool(
  "browser_navigate",
  "Navigate a tab to a URL, go back/forward, or reload, and wait until the page finishes loading.",
  {
    url: z.string().optional(),
    direction: z.enum(["url", "back", "forward", "reload"]).optional().default("url"),
    tabId: z.number().int().optional(),
    waitUntil: z.enum(["none", "loading", "complete"]).optional().default("complete"),
    timeoutMs: z.number().int().optional().default(20000),
    includeSnapshot: z.boolean().optional().default(false),
  },
  async (params) => runExtensionTool("navigate", params, (params.timeoutMs || 20000) + 5000),
);

server.tool(
  "browser_snapshot",
  "Ultra-fast, modal-first, Shadow DOM & iframe-aware interactive snapshot ([12] or [f3:4]). Supports diff=true to return only DOM changes since the previous snapshot (70-90% fewer tokens).",
  {
    tabId: z.number().int().optional(),
    viewportOnly: z.boolean().optional().default(false),
    maxElements: z.number().int().min(10).max(500).optional().default(120),
    includeText: z.boolean().optional().default(true),
    maxTextChars: z.number().int().min(200).max(20000).optional().default(2500),
    includeFrames: z
      .boolean()
      .optional()
      .default(true)
      .describe("Also index interactive elements inside accessible iframes as [f<frameId>:<ref>]."),
    diff: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return only +added / -removed elements compared to the previous snapshot of this tab."),
    selector: z.string().optional().describe("Optional CSS selector to scope snapshot to a subtree."),
  },
  async (params) => runExtensionTool("snapshot", params),
);

server.tool(
  "browser_find",
  "Instant targeted search for interactive elements by text, role, placeholder, or CSS selector across main frame and iframes — assigns live [ref] IDs without dumping the full page.",
  {
    query: z.string().optional().describe("Case-insensitive text/label/placeholder match."),
    role: z.string().optional().describe("Optional role filter, e.g. 'button', 'link', 'textbox', 'combobox'."),
    selector: z.string().optional().describe("Optional CSS selector."),
    includeFrames: z.boolean().optional().default(true),
    limit: z.number().int().min(1).max(60).optional().default(20),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("find", params),
);

server.tool(
  "browser_read_page",
  "Extract clean readable text, links, tables, form values, or HTML from the page or a specific CSS selector.",
  {
    tabId: z.number().int().optional(),
    frameId: z.number().int().optional().default(0),
    mode: z.enum(["text", "links", "tables", "forms", "html"]).optional().default("text"),
    selector: z.string().optional(),
    maxChars: z.number().int().min(200).max(40000).optional().default(12000),
  },
  async (params) => runExtensionTool("read_page", params),
);

server.tool(
  "browser_click",
  "Click an element by ref (main frame or iframe 'f<id>:<ref>'), CSS selector, or visible text. Detects occlusion and supports trusted=true CDP hardware clicks.",
  {
    ref: RefSchema.optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    frameId: z.number().int().optional(),
    tabId: z.number().int().optional(),
    doubleClick: z.boolean().optional().default(false),
    rightClick: z.boolean().optional().default(false),
    trusted: z.boolean().optional().default(false),
    waitAfterMs: z.number().int().min(0).max(10000).optional().default(100),
    includeSnapshot: z.boolean().optional().default(false),
  },
  async (params) => runExtensionTool("click", params),
);

server.tool(
  "browser_hover",
  "Hover over an element to open hover dropdown menus, tooltips, or row actions. Supports trusted=true CDP mouse move.",
  {
    ref: RefSchema.optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    frameId: z.number().int().optional(),
    trusted: z.boolean().optional().default(false),
    waitAfterMs: z.number().int().min(0).max(5000).optional().default(150),
    includeSnapshot: z.boolean().optional().default(false),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("hover", params),
);

server.tool(
  "browser_drag",
  "Drag an element onto another element or by a pixel offset (deltaX/deltaY for sliders & Kanban boards). Supports trusted=true smooth CDP drag.",
  {
    sourceRef: RefSchema.optional(),
    sourceSelector: z.string().optional(),
    targetRef: RefSchema.optional(),
    targetSelector: z.string().optional(),
    deltaX: z.number().int().optional().describe("Horizontal pixel offset if no target element is given."),
    deltaY: z.number().int().optional().describe("Vertical pixel offset if no target element is given."),
    trusted: z.boolean().optional().default(true),
    steps: z.number().int().min(2).max(30).optional().default(10),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("drag", params),
);

server.tool(
  "browser_type",
  "Type or fill text into an input, textarea, or contenteditable element (React/Vue/Angular-safe, works inside iframes). Set trusted=true for CDP hardware keystrokes.",
  {
    ref: RefSchema.optional(),
    selector: z.string().optional(),
    frameId: z.number().int().optional(),
    text: z.string(),
    clear: z.boolean().optional().default(true),
    submit: z.boolean().optional().default(false),
    trusted: z.boolean().optional().default(false),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("type", params),
);

server.tool(
  "browser_select",
  "Select an option in a <select> dropdown by option value or visible label text (works inside iframes).",
  {
    ref: RefSchema.optional(),
    selector: z.string().optional(),
    frameId: z.number().int().optional(),
    value: z.string().optional(),
    label: z.string().optional(),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("select", params),
);

server.tool(
  "browser_press_key",
  "Press a keyboard key or shortcut (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'Control+a').",
  {
    key: z.string(),
    ref: RefSchema.optional(),
    selector: z.string().optional(),
    frameId: z.number().int().optional(),
    trusted: z.boolean().optional().default(false),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("press_key", params),
);

server.tool(
  "browser_scroll",
  "Scroll the page, a scrollable container, or bring an element [ref] into view.",
  {
    direction: z.enum(["down", "up", "top", "bottom", "to_ref"]).optional().default("down"),
    amount: z.number().int().optional().default(650),
    ref: RefSchema.optional(),
    selector: z.string().optional(),
    frameId: z.number().int().optional(),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("scroll", params),
);

server.tool(
  "browser_wait",
  "Wait for a CSS selector, visible text, URL match, DOM settle, or milliseconds.",
  {
    selector: z.string().optional(),
    text: z.string().optional(),
    urlIncludes: z.string().optional(),
    domIdleMs: z.number().int().optional(),
    ms: z.number().int().min(0).max(30000).optional(),
    timeoutMs: z.number().int().min(200).max(60000).optional().default(10000),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("wait", params, (params.timeoutMs || 10000) + 5000),
);

const BatchStepSchema = z.object({
  action: z.enum([
    "click",
    "hover",
    "drag",
    "type",
    "select",
    "press_key",
    "scroll",
    "wait",
    "navigate",
    "assert_text",
    "assert_url",
  ]),
  ref: RefSchema.optional(),
  sourceRef: RefSchema.optional(),
  targetRef: RefSchema.optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  value: z.string().optional(),
  label: z.string().optional(),
  key: z.string().optional(),
  url: z.string().optional(),
  direction: z.string().optional(),
  amount: z.number().int().optional(),
  deltaX: z.number().int().optional(),
  deltaY: z.number().int().optional(),
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
  trusted: z.boolean().optional(),
  ms: z.number().int().optional(),
  domIdleMs: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  urlIncludes: z.string().optional(),
});

server.tool(
  "browser_batch",
  "Execute up to 30 browser steps (type, click, hover, drag, select, press_key, scroll, wait, navigate, assert_text, assert_url) in a SINGLE round-trip, with an optional compact final snapshot.",
  {
    steps: z.array(BatchStepSchema).min(1).max(30),
    tabId: z.number().int().optional(),
    stopOnError: z.boolean().optional().default(true),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .default(40)
      .describe("Brief pause between interactive steps so SPA frameworks flush state."),
    finalSnapshot: z.boolean().optional().default(true),
    finalSnapshotDiff: z.boolean().optional().default(false),
    finalSnapshotViewportOnly: z.boolean().optional().default(true),
    finalSnapshotMaxElements: z.number().int().min(10).max(300).optional().default(80),
  },
  async (params) => runExtensionTool("batch", params, 60000),
);

server.tool(
  "browser_screenshot",
  "Capture a fast banner-free viewport screenshot (~45ms). Set annotate=true for Set-of-Marks numbered [ref] overlays directly on the image! Set fullPage=true for full scrollable page capture via on-demand CDP.",
  {
    tabId: z.number().int().optional(),
    format: z.enum(["jpeg", "png"]).optional().default("jpeg"),
    quality: z.number().int().min(20).max(100).optional().default(80),
    annotate: z
      .boolean()
      .optional()
      .default(false)
      .describe("Temporarily draw numbered [ref] Set-of-Marks pills over visible interactive elements and return their legend."),
    fullPage: z.boolean().optional().default(false),
    keepDebugger: z.boolean().optional().default(false),
    savePath: z.string().optional(),
  },
  async (params) => {
    try {
      const { result, latencyMs } = await hub.call("screenshot", params, 30000);
      if (!result || !result.base64) {
        return errorResult("Extension returned empty screenshot data");
      }
      if (params.savePath) {
        fs.mkdirSync(path.dirname(params.savePath), { recursive: true });
        fs.writeFileSync(params.savePath, Buffer.from(result.base64, "base64"));
      }
      const mimeType = result.mimeType || (params.format === "png" ? "image/png" : "image/jpeg");
      return {
        content: [
          {
            type: "image",
            data: result.base64,
            mimeType,
          },
          {
            type: "text",
            text: JSON.stringify({
              url: result.url,
              title: result.title,
              tabId: result.tabId,
              annotated: Boolean(result.annotated),
              legend: result.legend || undefined,
              savedTo: params.savePath || null,
              latencyMs,
            }),
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "browser_eval",
  "Evaluate JavaScript in the page's MAIN world and return JSON-serialized result. Controlled by the 'Allow JS Eval' toggle in the extension panel. Set trusted=true for CDP evaluation on strict-CSP pages.",
  {
    expression: z.string(),
    tabId: z.number().int().optional(),
    frameId: z.number().int().optional().default(0),
    trusted: z.boolean().optional().default(false),
  },
  async (params) => runExtensionTool("eval", params),
);

server.tool(
  "browser_storage",
  "Inspect cookies, localStorage, and sessionStorage for the target tab.",
  {
    tabId: z.number().int().optional(),
    includeCookies: z.boolean().optional().default(true),
    includeLocalStorage: z.boolean().optional().default(true),
    includeSessionStorage: z.boolean().optional().default(false),
  },
  async (params) => runExtensionTool("storage", params),
);

server.tool(
  "browser_console",
  "Capture and read console logs, warnings, and page exceptions via on-demand CDP (chrome.debugger).",
  {
    action: z.enum(["start", "read", "clear"]).optional().default("read"),
    tabId: z.number().int().optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  },
  async (params) => runExtensionTool("console", params),
);

server.tool(
  "browser_network",
  "Monitor XHR/Fetch/document network requests, status codes, headers, and response bodies via on-demand CDP (chrome.debugger).",
  {
    action: z.enum(["start", "list", "body", "clear"]).optional().default("list"),
    tabId: z.number().int().optional(),
    requestId: z.string().optional(),
    urlFilter: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  },
  async (params) => runExtensionTool("network", params),
);

server.tool(
  "browser_cdp",
  "Send a raw Chrome DevTools Protocol (CDP) command via on-demand chrome.debugger, handle JS alert/confirm dialogs, or detach the debugger cleanly to dismiss Chrome's debugging banner.",
  {
    action: z.enum(["send", "detach", "detach_all"]).default("send"),
    method: z.string().optional(),
    params: z.record(z.any()).optional(),
    tabId: z.number().int().optional(),
  },
  async (params) => runExtensionTool("cdp", params),
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Eagerly start/connect to the local Hub on MCP startup so the Chrome extension badge turns green immediately.
hub.connect().catch(() => {});
