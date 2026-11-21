import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig, PROJECT_ROOT, writeExtensionBridgeConfig } from "../server/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(PROJECT_ROOT, "server", "mcp-server.mjs");
const EXTENSION_DIR = path.join(PROJECT_ROOT, "extension");
const BUNDLED_SKILL_DIR = path.join(PROJECT_ROOT, "skills", "antigravity-chrome");

function parseClients(argv) {
  const idx = argv.indexOf("--client");
  if (idx >= 0 && argv[idx + 1]) {
    return argv[idx + 1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return ["antigravity"];
}

function updateJsonMcpConfig(configPath, serverEntry) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let data = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(`${configPath}.bak`, raw, "utf8");
    data = JSON.parse(raw);
    if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
  }
  data.mcpServers["antigravity-chrome"] = serverEntry;
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return configPath;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log("=== Antigravity Chrome Connector Setup ===");
const cfg = ensureConfig();
const bridgeCfgPath = writeExtensionBridgeConfig(cfg);
console.log(`✓ Local auth token & bridge config ready: ${bridgeCfgPath}`);

execFileSync(process.execPath, [path.join(__dirname, "generate-icons.mjs")], {
  stdio: "inherit",
});

const serverEntry = {
  command: process.execPath,
  args: [MCP_ENTRY],
};

const clients = parseClients(process.argv.slice(2));
const home = os.homedir();

for (const client of clients) {
  if (client === "antigravity") {
    const mcpPath = path.join(home, ".gemini", "config", "mcp_config.json");
    updateJsonMcpConfig(mcpPath, serverEntry);
    console.log(`✓ Registered MCP server in Antigravity: ${mcpPath}`);

    const skillDst = path.join(home, ".gemini", "config", "skills", "antigravity-chrome");
    if (fs.existsSync(BUNDLED_SKILL_DIR)) {
      copyDir(BUNDLED_SKILL_DIR, skillDst);
      console.log(`✓ Installed Antigravity skill: ${skillDst}`);
    }
  } else if (client === "claude") {
    const mcpPath = path.join(home, ".claude.json");
    updateJsonMcpConfig(mcpPath, serverEntry);
    console.log(`✓ Registered MCP server in Claude Code: ${mcpPath}`);
  } else if (client === "cursor") {
    const mcpPath = path.join(home, ".cursor", "mcp.json");
    updateJsonMcpConfig(mcpPath, serverEntry);
    console.log(`✓ Registered MCP server in Cursor: ${mcpPath}`);
  } else {
    console.warn(`! Unknown client '${client}' (supported: antigravity, claude, cursor)`);
  }
}

console.log("\nNext steps:");
console.log("  1. Open chrome://extensions in Google Chrome and enable Developer mode.");
console.log(`  2. Click 'Load unpacked' and select: ${EXTENSION_DIR}`);
console.log("  3. Restart or refresh MCP servers in your AI client — the badge turns green ON automatically.");
