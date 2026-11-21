import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const CONFIG_DIR = path.join(os.homedir(), ".antigravity-chrome");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const EXTENSION_BRIDGE_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  "extension",
  "bridge.config.json",
);

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18792;

export function ensureConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let cfg = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (parsed && typeof parsed.token === "string" && parsed.token.length >= 32) {
        cfg = {
          version: 2,
          host: DEFAULT_HOST,
          port: Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT,
          token: parsed.token,
        };
      }
    } catch {
      cfg = null;
    }
  }

  if (!cfg) {
    cfg = {
      version: 2,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      token: crypto.randomBytes(32).toString("hex"),
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return cfg;
}

export function writeExtensionBridgeConfig(cfg) {
  const payload = {
    wsUrl: `ws://${cfg.host}:${cfg.port}`,
    token: cfg.token,
  };
  fs.mkdirSync(path.dirname(EXTENSION_BRIDGE_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    EXTENSION_BRIDGE_CONFIG_PATH,
    JSON.stringify(payload, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return EXTENSION_BRIDGE_CONFIG_PATH;
}

export function verifyToken(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isAllowedOrigin(originHeader) {
  // Local Node.js MCP clients omit Origin; Chrome extensions send chrome-extension://<id>
  if (!originHeader) return true;
  if (typeof originHeader !== "string") return false;
  return originHeader.startsWith("chrome-extension://");
}
