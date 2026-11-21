const EXTENSION_VERSION = "2.0.0";
const KEEPALIVE_ALARM = "ag-ws-watchdog";
const ANTIGRAVITY_GROUP_TITLE = "Antigravity";
const ANTIGRAVITY_GROUP_COLOR = "purple";

const DEFAULT_SETTINGS = {
  wsUrl: "ws://127.0.0.1:18792",
  token: "",
  paused: false,
  scope: "all", // "all" | "group" | "active"
  allowEval: true,
  highlight: true,
  blockedDomains: [],
};

let settings = { ...DEFAULT_SETTINGS };
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempt = 0;
let connected = false;
let lastPingLatencyMs = null;
let lastPingSentAt = null;
let hubClientCount = 0;
let antigravityGroupId = null;

const actionLog = [];
const attachedTabs = new Set();
const consoleBuffers = new Map();
const networkBuffers = new Map();
const lastSnapshots = new Map(); // tabId -> { url, title, lines: string[] }

function parseRefTarget(ref, explicitFrameId) {
  if (typeof ref === "string") {
    const m = /^f(\d+):(\d+)$/.exec(ref.trim());
    if (m) {
      return { frameId: Number(m[1]), localRef: Number(m[2]) };
    }
    const n = Number(ref);
    if (Number.isFinite(n)) {
      return { frameId: explicitFrameId ?? 0, localRef: n };
    }
  }
  if (typeof ref === "number") {
    return { frameId: explicitFrameId ?? 0, localRef: ref };
  }
  return { frameId: explicitFrameId ?? 0, localRef: undefined };
}

function pushLog(entry) {
  actionLog.unshift({ ts: Date.now(), ...entry });
  if (actionLog.length > 60) actionLog.length = 60;
  broadcastPanelUpdate();
}

function getPublicState() {
  return {
    version: EXTENSION_VERSION,
    connected,
    paused: settings.paused,
    scope: settings.scope,
    allowEval: settings.allowEval,
    highlight: settings.highlight,
    blockedDomains: settings.blockedDomains,
    wsUrl: settings.wsUrl,
    tokenSet: Boolean(settings.token),
    lastPingLatencyMs,
    hubClientCount,
    attachedDebuggerTabs: Array.from(attachedTabs),
    antigravityGroupId,
    actionLog: actionLog.slice(0, 30),
  };
}

function broadcastPanelUpdate() {
  chrome.runtime.sendMessage({ type: "ag_state", state: getPublicState() }).catch(() => {});
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "state_update", state: getPublicState() }));
    } catch {}
  }
}

async function updateBadge() {
  try {
    if (!connected) {
      await chrome.action.setBadgeText({ text: "OFF" });
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    } else if (settings.paused) {
      await chrome.action.setBadgeText({ text: "II" });
      await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    } else if (attachedTabs.size > 0) {
      await chrome.action.setBadgeText({ text: "CDP" });
      await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
    } else {
      await chrome.action.setBadgeText({ text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    }
  } catch {}
}

async function readBundledBridgeConfig() {
  try {
    const resp = await fetch(chrome.runtime.getURL("bridge.config.json"));
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && typeof data.token === "string" && data.token.length >= 32) {
      return data;
    }
  } catch {}
  return null;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const localCfg = await readBundledBridgeConfig();

  settings = {
    ...DEFAULT_SETTINGS,
    ...(localCfg ? { wsUrl: localCfg.wsUrl || DEFAULT_SETTINGS.wsUrl, token: localCfg.token } : {}),
    ...stored,
  };

  if (!settings.token && localCfg?.token) {
    settings.token = localCfg.token;
    settings.wsUrl = localCfg.wsUrl || settings.wsUrl;
    await chrome.storage.local.set({ token: settings.token, wsUrl: settings.wsUrl });
  }
  await updateBadge();
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set(patch);
  await updateBadge();
  broadcastPanelUpdate();
}

// ---------------- WebSocket Connection & MV3 Keepalive ----------------

function clearTimers() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(1.6, reconnectAttempt), 8000);
  reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, delay);
}

function connectWs(force = false) {
  if (force && ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (!settings.wsUrl || !settings.token) {
    connected = false;
    updateBadge();
    return;
  }

  clearTimers();
  const sep = settings.wsUrl.includes("?") ? "&" : "?";
  const fullUrl = `${settings.wsUrl}${sep}role=extension&token=${encodeURIComponent(settings.token)}`;

  try {
    const socket = new WebSocket(fullUrl);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      connected = true;
      reconnectAttempt = 0;
      updateBadge();
      socket.send(
        JSON.stringify({
          type: "hello",
          version: EXTENSION_VERSION,
          state: getPublicState(),
        }),
      );
      broadcastPanelUpdate();

      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          lastPingSentAt = Date.now();
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 15000);
    };

    socket.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "pong") {
        if (lastPingSentAt) lastPingLatencyMs = Date.now() - lastPingSentAt;
        if (typeof msg.clientCount === "number") hubClientCount = msg.clientCount;
        broadcastPanelUpdate();
        return;
      }

      if (msg.type === "welcome" || msg.type === "client_count") {
        if (typeof msg.clientCount === "number") hubClientCount = msg.clientCount;
        if (typeof msg.count === "number") hubClientCount = msg.count;
        broadcastPanelUpdate();
        return;
      }

      if (msg.type === "request" && msg.id != null) {
        const started = Date.now();
        try {
          const result = await handleAction(msg.action, msg.params || {});
          const latencyMs = Date.now() - started;
          if (msg.action !== "status") {
            pushLog({
              action: msg.action,
              detail: summarizeAction(msg.action, msg.params || {}),
              ok: true,
              latencyMs,
            });
          }
          socket.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          pushLog({
            action: msg.action,
            detail: summarizeAction(msg.action, msg.params || {}),
            ok: false,
            latencyMs: Date.now() - started,
            error: errMsg,
          });
          socket.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: errMsg }));
        }
      }
    };

    socket.onclose = () => {
      if (ws === socket) {
        ws = null;
        connected = false;
        clearTimers();
        updateBadge();
        broadcastPanelUpdate();
        scheduleReconnect();
      }
    };

    socket.onerror = () => {};
  } catch {
    connected = false;
    updateBadge();
    scheduleReconnect();
  }
}

function summarizeAction(action, params) {
  if (action === "navigate") return params.url || params.direction || "";
  if (action === "click" || action === "hover") {
    return params.ref != null ? `[${params.ref}]` : params.text || params.selector || "";
  }
  if (action === "type") {
    return `${params.ref != null ? `[${params.ref}]` : params.selector || ""} (${(params.text || "").length} chars)`;
  }
  if (action === "find") return params.query || params.role || params.selector || "";
  if (action === "batch") return `${(params.steps || []).length} steps`;
  if (action === "tabs") return `${params.action || "list"}${params.url ? " " + params.url : ""}`;
  if (action === "screenshot") return params.annotate ? "annotated SoM" : params.fullPage ? "fullPage" : "viewport";
  if (action === "cdp") return `${params.action} ${params.method || ""}`.trim();
  return params.selector || params.mode || params.action || "";
}

// ---------------- Tab Group & Guardrail Helpers ----------------

async function findAntigravityGroupId() {
  try {
    const groups = await chrome.tabGroups.query({ title: ANTIGRAVITY_GROUP_TITLE });
    if (groups.length > 0) {
      antigravityGroupId = groups[0].id;
      return antigravityGroupId;
    }
  } catch {}
  antigravityGroupId = null;
  return null;
}

async function addTabToAntigravityGroup(tabId) {
  try {
    let groupId = await findAntigravityGroupId();
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, {
        title: ANTIGRAVITY_GROUP_TITLE,
        color: ANTIGRAVITY_GROUP_COLOR,
      });
      antigravityGroupId = groupId;
    }
    return groupId;
  } catch {
    return null;
  }
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("https://chrome.google.com/webstore")
  );
}

function isBlockedDomain(url) {
  if (!url || !settings.blockedDomains?.length) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return settings.blockedDomains.some((raw) => {
      const d = String(raw || "").trim().toLowerCase();
      if (!d) return false;
      return host === d || host.endsWith("." + d);
    });
  } catch {
    return false;
  }
}

async function resolveTargetTab(tabId, { allowRestricted = false } = {}) {
  if (settings.paused) {
    throw new Error("Automation is PAUSED in the Antigravity Chrome extension panel. Click Resume to continue.");
  }

  let tab = null;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId);
  } else {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active || (await chrome.tabs.query({ active: true }))[0];
  }
  if (!tab) throw new Error("No active Chrome tab found.");

  if (settings.scope === "group") {
    const gid = await findAntigravityGroupId();
    if (gid == null || tab.groupId !== gid) {
      throw new Error(
        `Tab ${tab.id} is outside the 'Antigravity' tab group (Scope = Group Only). Open a tab with browser_tabs(action="open", inGroup=true) or switch scope in the extension panel.`,
      );
    }
  } else if (settings.scope === "active") {
    if (!tab.active) {
      throw new Error(
        `Tab ${tab.id} is not the active tab (Scope = Active Tab Only). Focus it or switch scope in the extension panel.`,
      );
    }
  }

  if (isBlockedDomain(tab.url)) {
    throw new Error(`Access blocked by user's Protected Domains list for URL: ${tab.url}`);
  }
  if (!allowRestricted && isRestrictedUrl(tab.url)) {
    throw new Error(
      `Chrome forbids scripting on internal/protected page: ${tab.url || "(empty)"}. Navigate to a regular http(s) page first.`,
    );
  }
  return tab;
}

// ---------------- Cross-Frame Content Engine Helpers ----------------

async function ensureContentEngine(tabId, { frameId = 0, allFrames = false } = {}) {
  const target = allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  const checks = await chrome.scripting.executeScript({
    target,
    func: () => window.__AG_ENGINE_VERSION__ === "2.0.0",
  });
  const missingFrameIds = checks.filter((c) => c.result !== true).map((c) => c.frameId);
  if (missingFrameIds.length > 0) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: missingFrameIds },
      files: ["content-engine.js"],
    });
  }
}

async function callEngine(tabId, method, args = {}, frameId = 0) {
  await ensureContentEngine(tabId, { frameId });
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: async (m, a) => {
      try {
        const res = await window.__AG_ENGINE__[m](a);
        return { ok: true, res };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    args: [method, args],
  });
  const payload = results?.[0]?.result;
  if (!payload) throw new Error(`Content engine returned no result for '${method}' (frame ${frameId})`);
  if (!payload.ok) throw new Error(payload.error || `Content engine error in '${method}'`);
  return payload.res;
}

async function callEngineAllFrames(tabId, method, argsBuilder) {
  await ensureContentEngine(tabId, { allFrames: true });
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async (m, baseArgs) => {
      try {
        const isTop = window === window.top;
        return { ok: true, isTop, url: window.location.href };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    args: [method, {}],
  });

  const frameOutputs = [];
  for (const r of results) {
    if (!r?.result?.ok) continue;
    const fId = r.frameId;
    const frameArgs = argsBuilder(fId, r.result.url);
    try {
      const out = await callEngine(tabId, method, frameArgs, fId);
      frameOutputs.push({ frameId: fId, url: r.result.url, data: out });
    } catch {
      // Skip inaccessible/blank sandboxed iframes gracefully
    }
  }
  return frameOutputs;
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve({ timedOut });
    };
    const onUpdated = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") finish(false);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => finish(true), timeoutMs);

    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") finish(false);
      })
      .catch(() => finish(true));
  });
}

// ---------------- On-Demand chrome.debugger (CDP) Manager ----------------

async function attachCdp(tabId) {
  if (attachedTabs.has(tabId)) return false;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
  await updateBadge();
  broadcastPanelUpdate();
  return true;
}

async function detachCdp(tabId) {
  if (!attachedTabs.has(tabId)) return false;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  attachedTabs.delete(tabId);
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  await updateBadge();
  broadcastPanelUpdate();
  return true;
}

async function detachAllCdp() {
  const ids = Array.from(attachedTabs);
  for (const id of ids) await detachCdp(id);
  return ids;
}

async function sendCdp(tabId, method, params = {}) {
  await attachCdp(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attachedTabs.delete(source.tabId);
    updateBadge();
    broadcastPanelUpdate();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  lastSnapshots.delete(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;

  if (method === "Runtime.consoleAPICalled") {
    if (!consoleBuffers.has(tabId)) consoleBuffers.set(tabId, []);
    const buf = consoleBuffers.get(tabId);
    const args = (params.args || []).map((a) =>
      a.value !== undefined ? a.value : a.description || a.type,
    );
    buf.push({
      ts: Date.now(),
      level: params.type || "log",
      text: args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "),
    });
    if (buf.length > 300) buf.shift();
  } else if (method === "Runtime.exceptionThrown") {
    if (!consoleBuffers.has(tabId)) consoleBuffers.set(tabId, []);
    const buf = consoleBuffers.get(tabId);
    const ex = params.exceptionDetails || {};
    buf.push({
      ts: Date.now(),
      level: "exception",
      text: ex.exception?.description || ex.text || "Uncaught exception",
    });
    if (buf.length > 300) buf.shift();
  } else if (method === "Network.requestWillBeSent") {
    if (!networkBuffers.has(tabId)) networkBuffers.set(tabId, new Map());
    const map = networkBuffers.get(tabId);
    map.set(params.requestId, {
      requestId: params.requestId,
      url: params.request?.url,
      method: params.request?.method,
      type: params.type,
      ts: Date.now(),
      status: null,
      mimeType: null,
      failed: false,
    });
    if (map.size > 300) map.delete(map.keys().next().value);
  } else if (method === "Network.responseReceived") {
    const rec = networkBuffers.get(tabId)?.get(params.requestId);
    if (rec) {
      rec.status = params.response?.status;
      rec.statusText = params.response?.statusText;
      rec.mimeType = params.response?.mimeType;
    }
  } else if (method === "Network.loadingFailed") {
    const rec = networkBuffers.get(tabId)?.get(params.requestId);
    if (rec) {
      rec.failed = true;
      rec.errorText = params.errorText;
    }
  }
});

// ---------------- Snapshot Diff Helper ----------------

function stripRefPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "");
}

function buildSnapshotDiff(prev, curr) {
  if (!prev) return null;
  const prevSet = new Set(prev.lines.map(stripRefPrefix));
  const currSet = new Set(curr.lines.map(stripRefPrefix));

  const added = curr.lines.filter((l) => !prevSet.has(stripRefPrefix(l)));
  const removed = prev.lines.filter((l) => !currSet.has(stripRefPrefix(l)));
  return {
    urlChanged: prev.url !== curr.url,
    titleChanged: prev.title !== curr.title,
    addedCount: added.length,
    removedCount: removed.length,
    unchangedCount: curr.lines.length - added.length,
    added: added.join("\n"),
    removed: removed.slice(0, 60).join("\n"),
  };
}

// ---------------- Core Action Router ----------------

async function runSnapshot(tab, params = {}) {
  const includeFrames = params.includeFrames !== false && !params.selector;
  const maxElements = params.maxElements ?? 120;

  let mainSnap = null;
  const allLines = [];
  let totalElements = 0;
  let frameCount = 1;

  if (includeFrames) {
    const frameResults = await callEngineAllFrames(tab.id, "snapshot", (frameId) => ({
      ...params,
      includeText: frameId === 0 ? params.includeText !== false : false,
      maxElements: frameId === 0 ? maxElements : Math.min(40, maxElements),
      refPrefix: frameId === 0 ? "" : `f${frameId}:`,
    }));

    const top = frameResults.find((f) => f.frameId === 0);
    if (!top) throw new Error("Failed to snapshot main frame");
    mainSnap = top.data;
    allLines.push(...(mainSnap.lines || []));
    totalElements += mainSnap.elementCount || 0;

    const subframes = frameResults.filter(
      (f) => f.frameId !== 0 && f.data && f.data.elementCount > 0,
    );
    frameCount = 1 + subframes.length;
    for (const sf of subframes) {
      allLines.push(`--- iframe [f${sf.frameId}] ${sf.url} ---`);
      allLines.push(...(sf.data.lines || []));
      totalElements += sf.data.elementCount || 0;
    }
  } else {
    mainSnap = await callEngine(tab.id, "snapshot", { ...params, refPrefix: "" }, 0);
    allLines.push(...(mainSnap.lines || []));
    totalElements = mainSnap.elementCount || 0;
  }

  const prev = lastSnapshots.get(tab.id);
  const currRecord = { url: mainSnap.url, title: mainSnap.title, lines: allLines };
  lastSnapshots.set(tab.id, currRecord);

  if (params.diff && prev) {
    const diff = buildSnapshotDiff(prev, currRecord);
    return {
      tabId: tab.id,
      mode: "diff",
      url: mainSnap.url,
      title: mainSnap.title,
      hasModal: mainSnap.hasModal,
      frameCount,
      elementCount: totalElements,
      diff,
    };
  }

  return {
    tabId: tab.id,
    url: mainSnap.url,
    title: mainSnap.title,
    viewport: mainSnap.viewport,
    hasModal: mainSnap.hasModal,
    frameCount,
    elementCount: totalElements,
    truncated: mainSnap.truncated,
    elements: allLines.join("\n"),
    text: mainSnap.text,
  };
}

async function handleAction(action, params) {
  if (action === "status") {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return {
      ...getPublicState(),
      activeTab: active
        ? { id: active.id, title: active.title, url: active.url, groupId: active.groupId }
        : null,
    };
  }

  if (action === "tabs") {
    if (settings.paused && params.action !== "list") {
      throw new Error("Automation is PAUSED in the Antigravity Chrome extension panel.");
    }
    const op = params.action || "list";
    if (op === "list") {
      const gid = await findAntigravityGroupId();
      const tabs = await chrome.tabs.query({});
      return {
        antigravityGroupId: gid,
        tabs: tabs.map((t) => ({
          id: t.id,
          windowId: t.windowId,
          active: t.active,
          title: t.title,
          url: t.url,
          inAntigravityGroup: gid != null && t.groupId === gid,
          cdpAttached: attachedTabs.has(t.id),
        })),
      };
    }
    if (op === "open") {
      const url = params.url || "about:blank";
      if (isBlockedDomain(url)) throw new Error(`Opening blocked domain is not allowed: ${url}`);
      const created = await chrome.tabs.create({ url, active: params.active !== false });
      let groupId = null;
      if (params.inGroup !== false) groupId = await addTabToAntigravityGroup(created.id);
      if (url !== "about:blank") await waitForTabComplete(created.id, 15000);
      const latest = await chrome.tabs.get(created.id);
      return { tabId: latest.id, url: latest.url, title: latest.title, groupId };
    }
    if (op === "focus") {
      const tab = await chrome.tabs.get(params.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return { focused: true, tabId: tab.id, url: tab.url, title: tab.title };
    }
    if (op === "close") {
      await detachCdp(params.tabId);
      await chrome.tabs.remove(params.tabId);
      return { closed: true, tabId: params.tabId };
    }
    if (op === "reload") {
      const tab = await resolveTargetTab(params.tabId, { allowRestricted: true });
      await chrome.tabs.reload(tab.id, { bypassCache: Boolean(params.bypassCache) });
      await waitForTabComplete(tab.id, 15000);
      const updated = await chrome.tabs.get(tab.id);
      return { reloaded: true, tabId: updated.id, url: updated.url, title: updated.title };
    }
    if (op === "group") {
      const tab = await resolveTargetTab(params.tabId, { allowRestricted: true });
      const groupId = await addTabToAntigravityGroup(tab.id);
      return { grouped: true, tabId: tab.id, groupId };
    }
    throw new Error(`Unknown tabs action: ${op}`);
  }

  if (action === "navigate") {
    const tab = await resolveTargetTab(params.tabId, { allowRestricted: true });
    const dir = params.direction || "url";
    if (dir === "back") await chrome.tabs.goBack(tab.id);
    else if (dir === "forward") await chrome.tabs.goForward(tab.id);
    else if (dir === "reload") await chrome.tabs.reload(tab.id);
    else {
      if (!params.url) throw new Error("url is required for navigate");
      if (isBlockedDomain(params.url)) {
        throw new Error(`Navigation blocked by Protected Domains list: ${params.url}`);
      }
      await chrome.tabs.update(tab.id, { url: params.url });
    }

    if (params.waitUntil !== "none") {
      await new Promise((r) => setTimeout(r, 150));
      await waitForTabComplete(tab.id, params.timeoutMs || 20000);
    }
    const updated = await chrome.tabs.get(tab.id);
    const out = { tabId: updated.id, url: updated.url, title: updated.title, status: updated.status };
    if (params.includeSnapshot && !isRestrictedUrl(updated.url)) {
      out.snapshot = await runSnapshot(updated, { viewportOnly: true, maxElements: 90, includeText: true });
    }
    return out;
  }

  if (action === "snapshot") {
    const tab = await resolveTargetTab(params.tabId);
    return runSnapshot(tab, params);
  }

  if (action === "find") {
    const tab = await resolveTargetTab(params.tabId);
    if (params.includeFrames !== false) {
      const all = await callEngineAllFrames(tab.id, "find", (frameId) => ({
        ...params,
        refPrefix: frameId === 0 ? "" : `f${frameId}:`,
      }));
      const matches = [];
      for (const f of all) {
        if (f.data?.matches?.length) matches.push(...f.data.matches);
      }
      return { tabId: tab.id, count: matches.length, matches: matches.join("\n") };
    }
    const res = await callEngine(tab.id, "find", { ...params, refPrefix: "" }, 0);
    return { tabId: tab.id, count: res.count, matches: res.matches.join("\n") };
  }

  if (action === "read_page") {
    const tab = await resolveTargetTab(params.tabId);
    const data = await callEngine(tab.id, "readPage", params, params.frameId ?? 0);
    return { tabId: tab.id, ...data };
  }

  if (action === "click") {
    const tab = await resolveTargetTab(params.tabId);
    const { frameId, localRef } = parseRefTarget(params.ref, params.frameId);
    const targetOpts = { ...params, ref: localRef, highlight: settings.highlight };
    let res;
    if (params.trusted && frameId === 0) {
      const pt = await callEngine(tab.id, "getElementPoint", targetOpts, 0);
      const btn = params.rightClick ? "right" : "left";
      const clickCount = params.doubleClick ? 2 : 1;
      await sendCdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      await sendCdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: pt.x,
        y: pt.y,
        button: btn,
        clickCount,
      });
      await sendCdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: pt.x,
        y: pt.y,
        button: btn,
        clickCount,
      });
      res = { clicked: true, trusted: true, ...pt };
    } else {
      res = await callEngine(tab.id, "click", targetOpts, frameId);
    }
    if (params.waitAfterMs) await new Promise((r) => setTimeout(r, params.waitAfterMs));
    if (params.includeSnapshot) {
      const latest = await chrome.tabs.get(tab.id);
      if (!isRestrictedUrl(latest.url)) {
        res.snapshot = await runSnapshot(latest, { viewportOnly: true, maxElements: 80, includeText: false });
      }
    }
    return { tabId: tab.id, frameId, ...res };
  }

  if (action === "hover") {
    const tab = await resolveTargetTab(params.tabId);
    const { frameId, localRef } = parseRefTarget(params.ref, params.frameId);
    const targetOpts = { ...params, ref: localRef, highlight: settings.highlight };
    let res;
    if (params.trusted && frameId === 0) {
      const pt = await callEngine(tab.id, "getElementPoint", targetOpts, 0);
      await sendCdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      res = { hovered: true, trusted: true, ...pt };
    } else {
      res = await callEngine(tab.id, "hover", targetOpts, frameId);
    }
    if (params.waitAfterMs) await new Promise((r) => setTimeout(r, params.waitAfterMs));
    if (params.includeSnapshot) {
      res.snapshot = await runSnapshot(tab, { viewportOnly: true, maxElements: 80, includeText: false });
    }
    return { tabId: tab.id, frameId, ...res };
  }

  if (action === "drag") {
    const tab = await resolveTargetTab(params.tabId);
    const src = parseRefTarget(params.sourceRef, 0);
    const dst = parseRefTarget(params.targetRef, src.frameId);
    if (params.trusted !== false && src.frameId === 0 && dst.frameId === 0) {
      const p1 = await callEngine(
        tab.id,
        "getElementPoint",
        { ref: src.localRef, selector: params.sourceSelector, highlight: settings.highlight },
        0,
      );
      let x2 = p1.x + (Number(params.deltaX) || 0);
      let y2 = p1.y + (Number(params.deltaY) || 0);
      if (dst.localRef != null || params.targetSelector) {
        const p2 = await callEngine(
          tab.id,
          "getElementPoint",
          { ref: dst.localRef, selector: params.targetSelector, highlight: settings.highlight },
          0,
        );
        x2 = p2.x;
        y2 = p2.y;
      }
      const steps = Math.min(Math.max(Number(params.steps) || 10, 2), 30);
      await sendCdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p1.x, y: p1.y });
      await sendCdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: p1.x,
        y: p1.y,
        button: "left",
        clickCount: 1,
      });
      for (let i = 1; i <= steps; i++) {
        const cx = Math.round(p1.x + ((x2 - p1.x) * i) / steps);
        const cy = Math.round(p1.y + ((y2 - p1.y) * i) / steps);
        await sendCdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: cx,
          y: cy,
          buttons: 1,
        });
        await new Promise((r) => setTimeout(r, 12));
      }
      await sendCdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x2,
        y: y2,
        button: "left",
        clickCount: 1,
      });
      return { tabId: tab.id, dragged: true, trusted: true, from: { x: p1.x, y: p1.y }, to: { x: x2, y: y2 } };
    }
    const res = await callEngine(
      tab.id,
      "dragSynthetic",
      { ...params, sourceRef: src.localRef, targetRef: dst.localRef },
      src.frameId,
    );
    return { tabId: tab.id, ...res };
  }

  if (action === "type") {
    const tab = await resolveTargetTab(params.tabId);
    const { frameId, localRef } = parseRefTarget(params.ref, params.frameId);
    const targetOpts = { ...params, ref: localRef, highlight: settings.highlight };
    if (params.trusted && frameId === 0) {
      const pt = await callEngine(tab.id, "getElementPoint", targetOpts, 0);
      await sendCdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: pt.x,
        y: pt.y,
        button: "left",
        clickCount: 1,
      });
      await sendCdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: pt.x,
        y: pt.y,
        button: "left",
        clickCount: 1,
      });
      if (params.clear !== false) {
        await sendCdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyDown",
          modifiers: 2,
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
        });
        await sendCdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers: 2,
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
        });
        await sendCdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await sendCdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
      }
      await sendCdp(tab.id, "Input.insertText", { text: params.text });
      if (params.submit) {
        await sendCdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await sendCdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      }
      return { tabId: tab.id, frameId, typed: true, trusted: true, length: (params.text || "").length };
    }
    const res = await callEngine(tab.id, "typeText", targetOpts, frameId);
    return { tabId: tab.id, frameId, ...res };
  }

  if (action === "select") {
    const tab = await resolveTargetTab(params.tabId);
    const { frameId, localRef } = parseRefTarget(params.ref, params.frameId);
    const res = await callEngine(
      tab.id,
      "selectOption",
      { ...params, ref: localRef, highlight: settings.highlight },
      frameId,
    );
    return { tabId: tab.id, frameId, ...res };
  }

  if (action === "press_key") {
    const tab = await resolveTargetTab(params.tabId);
    const { frameId, localRef } = parseRefTarget(params.ref, params.frameId);
    if (params.trusted && frameId === 0) {
      if (localRef != null || params.selector) {
        const pt = await callEngine(
          tab.id,
          "getElementPoint",
          { ref: localRef, selector: params.selector, highlight: false },
          0,
        );
        await sendCdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: pt.x,
          y: pt.y,
          button: "left",
          clickCount: 1,
        });
        await sendCdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: pt.x,
          y: pt.y,
          button: "left",
          clickCount: 1,
        });
      }
      const keyName = String(params.key || "Enter").split("+").pop();
      await sendCdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: keyName });
      await sendCdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: keyName });
      return { tabId: tab.id, pressed: params.key, trusted: true };
    }
    const res = await callEngine(tab.id, "pressKey", { ...params, ref: localRef }, frameId);
    return { tabId: tab.id, frameId, ...res };
  }

  if (action === "scroll") {
    const tab = await resolveTargetTab(params.tabId);
    const { frameId, localRef } = parseRefTarget(params.ref, params.frameId);
    const res = await callEngine(tab.id, "scroll", { ...params, ref: localRef }, frameId);
    return { tabId: tab.id, frameId, ...res };
  }

  if (action === "assert_text") {
    const tab = await resolveTargetTab(params.tabId);
    return callEngine(tab.id, "assertText", params, 0);
  }

  if (action === "assert_url") {
    const tab = await resolveTargetTab(params.tabId, { allowRestricted: true });
    const needle = String(params.urlIncludes || params.url || "");
    if (!tab.url || !tab.url.includes(needle)) {
      throw new Error(`URL assertion failed: expected '${tab.url}' to include '${needle}'`);
    }
    return { asserted: true, url: tab.url };
  }

  if (action === "wait") {
    const tab = await resolveTargetTab(params.tabId, {
      allowRestricted: Boolean(params.urlIncludes || params.ms),
    });
    if (params.urlIncludes) {
      const timeoutMs = params.timeoutMs || 10000;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const cur = await chrome.tabs.get(tab.id);
        if (cur.url && cur.url.includes(params.urlIncludes)) {
          return { tabId: tab.id, waited: true, url: cur.url, elapsedMs: Date.now() - started };
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error(`Timed out waiting for URL to include '${params.urlIncludes}'`);
    }
    const res = await callEngine(tab.id, "wait", params, 0);
    return { tabId: tab.id, ...res };
  }

  if (action === "batch") {
    const steps = params.steps || [];
    const results = [];
    const settleMs = params.settleMs ?? 40;
    const tab = await resolveTargetTab(params.tabId, { allowRestricted: true });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        const stepRes = await handleAction(step.action, { ...step, tabId: tab.id });
        results.push({ step: i + 1, action: step.action, ok: true, result: stepRes });
        if (settleMs > 0 && i < steps.length - 1 && step.action !== "wait") {
          await new Promise((r) => setTimeout(r, settleMs));
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.push({ step: i + 1, action: step.action, ok: false, error: errMsg });
        if (params.stopOnError !== false) {
          return { tabId: tab.id, completed: false, stoppedAtStep: i + 1, results };
        }
      }
    }

    const out = { tabId: tab.id, completed: true, results };
    if (params.finalSnapshot !== false) {
      const latest = await chrome.tabs.get(tab.id);
      if (!isRestrictedUrl(latest.url)) {
        out.snapshot = await runSnapshot(latest, {
          viewportOnly: params.finalSnapshotViewportOnly !== false,
          maxElements: params.finalSnapshotMaxElements ?? 80,
          maxTextChars: 1500,
          diff: Boolean(params.finalSnapshotDiff),
        });
      }
    }
    return out;
  }

  if (action === "screenshot") {
    const tab = await resolveTargetTab(params.tabId, { allowRestricted: true });
    const format = params.format === "png" ? "png" : "jpeg";
    const quality = Math.min(Math.max(Number(params.quality) || 80, 20), 100);
    const annotate = Boolean(params.annotate) && !isRestrictedUrl(tab.url);

    let legend = null;
    try {
      if (annotate) {
        const ann = await callEngine(tab.id, "showAnnotations", { refresh: true }, 0);
        legend = ann.legend;
        await new Promise((r) => setTimeout(r, 40)); // let compositor paint overlay
      }

      if (params.fullPage) {
        const newlyAttached = await attachCdp(tab.id);
        try {
          const cdpRes = await chrome.debugger.sendCommand(
            { tabId: tab.id },
            "Page.captureScreenshot",
            {
              format,
              quality: format === "jpeg" ? quality : undefined,
              captureBeyondViewport: true,
            },
          );
          return {
            tabId: tab.id,
            url: tab.url,
            title: tab.title,
            mimeType: format === "png" ? "image/png" : "image/jpeg",
            base64: cdpRes.data,
            fullPage: true,
            annotated: annotate,
            legend,
          };
        } finally {
          if (newlyAttached && !params.keepDebugger) await detachCdp(tab.id);
        }
      }

      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 80));
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format,
        quality: format === "jpeg" ? quality : undefined,
      });
      const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");
      return {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
        base64,
        fullPage: false,
        annotated: annotate,
        legend,
      };
    } finally {
      if (annotate) {
        await callEngine(tab.id, "clearAnnotations", {}, 0).catch(() => {});
      }
    }
  }

  if (action === "eval") {
    if (!settings.allowEval) {
      throw new Error(
        "JavaScript evaluation is disabled in the Antigravity Chrome extension panel. Enable 'Allow JS Eval' to use browser_eval.",
      );
    }
    const tab = await resolveTargetTab(params.tabId);
    if (params.trusted) {
      const res = await sendCdp(tab.id, "Runtime.evaluate", {
        expression: params.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description ||
            res.exceptionDetails.text ||
            "Evaluation exception",
        );
      }
      return { tabId: tab.id, trusted: true, value: res.result?.value };
    }
    const execRes = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [params.frameId ?? 0] },
      world: "MAIN",
      func: async (expr) => {
        try {
          const fn = new Function(`return (${expr});`);
          const val = await fn();
          return { ok: true, value: val === undefined ? null : JSON.parse(JSON.stringify(val)) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      args: [params.expression],
    });
    const r = execRes?.[0]?.result;
    if (!r) throw new Error("Eval returned empty result");
    if (!r.ok) {
      throw new Error(
        `${r.error} (Hint: if blocked by page Content-Security-Policy, retry browser_eval with trusted: true)`,
      );
    }
    return { tabId: tab.id, value: r.value };
  }

  if (action === "storage") {
    const tab = await resolveTargetTab(params.tabId);
    const out = await callEngine(tab.id, "readStorage", params, 0);
    if (params.includeCookies !== false && tab.url) {
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      out.cookies = cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        valuePreview: c.value.length > 60 ? c.value.slice(0, 60) + "…" : c.value,
      }));
    }
    return { tabId: tab.id, url: tab.url, ...out };
  }

  if (action === "console") {
    const tab = await resolveTargetTab(params.tabId);
    const op = params.action || "read";
    if (op === "start") {
      await sendCdp(tab.id, "Runtime.enable");
      if (!consoleBuffers.has(tab.id)) consoleBuffers.set(tab.id, []);
      return { tabId: tab.id, consoleCapture: "started" };
    }
    if (op === "clear") {
      consoleBuffers.set(tab.id, []);
      return { tabId: tab.id, cleared: true };
    }
    if (!attachedTabs.has(tab.id)) await sendCdp(tab.id, "Runtime.enable");
    const buf = consoleBuffers.get(tab.id) || [];
    return { tabId: tab.id, count: buf.length, messages: buf.slice(-(params.limit || 50)) };
  }

  if (action === "network") {
    const tab = await resolveTargetTab(params.tabId);
    const op = params.action || "list";
    if (op === "start") {
      await sendCdp(tab.id, "Network.enable");
      if (!networkBuffers.has(tab.id)) networkBuffers.set(tab.id, new Map());
      return { tabId: tab.id, networkCapture: "started" };
    }
    if (op === "clear") {
      networkBuffers.set(tab.id, new Map());
      return { tabId: tab.id, cleared: true };
    }
    if (op === "body") {
      if (!params.requestId) throw new Error("requestId is required for network action='body'");
      const bodyRes = await sendCdp(tab.id, "Network.getResponseBody", {
        requestId: params.requestId,
      });
      const txt = bodyRes.body || "";
      return {
        tabId: tab.id,
        requestId: params.requestId,
        base64Encoded: Boolean(bodyRes.base64Encoded),
        body: txt.length > 25000 ? txt.slice(0, 25000) + "\n...[truncated]" : txt,
      };
    }
    if (!attachedTabs.has(tab.id)) await sendCdp(tab.id, "Network.enable");
    const map = networkBuffers.get(tab.id) || new Map();
    let list = Array.from(map.values());
    if (params.urlFilter) {
      const f = params.urlFilter.toLowerCase();
      list = list.filter((r) => (r.url || "").toLowerCase().includes(f));
    }
    return { tabId: tab.id, count: list.length, requests: list.slice(-(params.limit || 50)) };
  }

  if (action === "cdp") {
    const op = params.action || "send";
    if (op === "detach_all") {
      const detached = await detachAllCdp();
      return { detachedTabs: detached };
    }
    if (op === "detach") {
      const tab = await resolveTargetTab(params.tabId, { allowRestricted: true });
      const detached = await detachCdp(tab.id);
      return { tabId: tab.id, detached };
    }
    if (!params.method) throw new Error("CDP method is required when action='send'");
    const tab = await resolveTargetTab(params.tabId);
    const res = await sendCdp(tab.id, params.method, params.params || {});
    return { tabId: tab.id, method: params.method, result: res };
  }

  throw new Error(`Unknown action: ${action}`);
}

// ---------------- Popup & Side Panel IPC ----------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "ag_get_state") {
      sendResponse({ ok: true, state: getPublicState(), token: settings.token });
      return;
    }
    if (msg.type === "ag_update_settings") {
      const reconnectNeeded =
        (msg.patch.wsUrl && msg.patch.wsUrl !== settings.wsUrl) ||
        (msg.patch.token && msg.patch.token !== settings.token);
      await saveSettings(msg.patch);
      if (reconnectNeeded) connectWs(true);
      sendResponse({ ok: true, state: getPublicState() });
      return;
    }
    if (msg.type === "ag_reconnect") {
      connectWs(true);
      sendResponse({ ok: true, state: getPublicState() });
      return;
    }
    if (msg.type === "ag_detach_all_cdp") {
      await detachAllCdp();
      sendResponse({ ok: true, state: getPublicState() });
      return;
    }
    if (msg.type === "ag_clear_log") {
      actionLog.length = 0;
      broadcastPanelUpdate();
      sendResponse({ ok: true, state: getPublicState() });
      return;
    }
    sendResponse({ ok: false, error: "Unknown panel message" });
  })();
  return true;
});

// ---------------- Lifecycle & Watchdog ----------------

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connectWs();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  connectWs(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  connectWs(true);
});

loadSettings().then(() => connectWs());
