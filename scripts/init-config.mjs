import { CONFIG_PATH, ensureConfig, writeExtensionBridgeConfig } from "../server/config.mjs";

const cfg = ensureConfig();
const extPath = writeExtensionBridgeConfig(cfg);
console.log(`Config ready: ${CONFIG_PATH}`);
console.log(`Extension bridge config written: ${extPath}`);
console.log(`Bridge endpoint: ws://${cfg.host}:${cfg.port}`);
