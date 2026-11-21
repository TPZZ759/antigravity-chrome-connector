const els = {
  statusDot: document.getElementById("statusDot"),
  statusSubtitle: document.getElementById("statusSubtitle"),
  connText: document.getElementById("connText"),
  latencyText: document.getElementById("latencyText"),
  clientsText: document.getElementById("clientsText"),
  pauseBtn: document.getElementById("pauseBtn"),
  detachCdpBtn: document.getElementById("detachCdpBtn"),
  cdpCount: document.getElementById("cdpCount"),
  openSidePanelBtn: document.getElementById("openSidePanelBtn"),
  reconnectBtn: document.getElementById("reconnectBtn"),
  scopeControl: document.getElementById("scopeControl"),
  highlightToggle: document.getElementById("highlightToggle"),
  evalToggle: document.getElementById("evalToggle"),
  domainForm: document.getElementById("domainForm"),
  domainInput: document.getElementById("domainInput"),
  domainList: document.getElementById("domainList"),
  actionLog: document.getElementById("actionLog"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  wsUrlInput: document.getElementById("wsUrlInput"),
  tokenInput: document.getElementById("tokenInput"),
  saveConnBtn: document.getElementById("saveConnBtn"),
  toggleTokenBtn: document.getElementById("toggleTokenBtn"),
};

let currentState = null;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function render(state) {
  if (!state) return;
  currentState = state;

  els.statusDot.className = "logo-dot";
  if (state.connected && state.paused) {
    els.statusDot.classList.add("paused");
    els.connText.textContent = "Paused";
    els.statusSubtitle.textContent = "Automation paused by user";
  } else if (state.connected) {
    els.statusDot.classList.add("online");
    els.connText.textContent = "Online";
    els.statusSubtitle.textContent = "Connected to Antigravity Hub";
  } else {
    els.connText.textContent = "Offline";
    els.statusSubtitle.textContent = "Waiting for Antigravity Hub…";
  }

  els.latencyText.textContent =
    state.connected && state.lastPingLatencyMs != null ? `${state.lastPingLatencyMs} ms` : "—";
  els.clientsText.textContent = String(state.hubClientCount || 0);

  els.pauseBtn.textContent = state.paused ? "Resume Agent" : "Pause Agent";
  els.pauseBtn.className = state.paused ? "btn btn-warn" : "btn btn-primary";

  const cdpTabs = state.attachedDebuggerTabs || [];
  if (cdpTabs.length > 0) {
    els.detachCdpBtn.classList.remove("hidden");
    els.cdpCount.textContent = String(cdpTabs.length);
  } else {
    els.detachCdpBtn.classList.add("hidden");
  }

  for (const btn of els.scopeControl.querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.scope === state.scope);
  }

  els.highlightToggle.checked = Boolean(state.highlight);
  els.evalToggle.checked = Boolean(state.allowEval);

  if (document.activeElement !== els.wsUrlInput) {
    els.wsUrlInput.value = state.wsUrl || "";
  }

  // Protected domains
  els.domainList.innerHTML = "";
  const domains = state.blockedDomains || [];
  for (const domain of domains) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const text = document.createElement("span");
    text.textContent = domain;
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.title = `Remove ${domain}`;
    rm.addEventListener("click", () => {
      const next = domains.filter((d) => d !== domain);
      updateSettings({ blockedDomains: next });
    });
    chip.append(text, rm);
    els.domainList.appendChild(chip);
  }

  // Action log
  const logs = state.actionLog || [];
  els.actionLog.innerHTML = "";
  if (logs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No browser actions yet.";
    els.actionLog.appendChild(empty);
  } else {
    for (const item of logs) {
      const row = document.createElement("div");
      row.className = item.ok ? "log-item" : "log-item err";
      const top = document.createElement("div");
      top.className = "log-top";
      const left = document.createElement("span");
      left.textContent = `${item.action}${item.detail ? ` · ${item.detail}` : ""}`;
      const right = document.createElement("span");
      right.className = "muted";
      right.textContent = `${item.latencyMs ?? 0}ms · ${formatTime(item.ts)}`;
      top.append(left, right);
      row.appendChild(top);
      if (!item.ok && item.error) {
        const errEl = document.createElement("div");
        errEl.className = "log-detail";
        errEl.textContent = item.error;
        row.appendChild(errEl);
      }
      els.actionLog.appendChild(row);
    }
  }
}

function updateSettings(patch) {
  chrome.runtime.sendMessage({ type: "ag_update_settings", patch }, (res) => {
    if (res?.state) render(res.state);
  });
}

// Event bindings
els.pauseBtn.addEventListener("click", () => {
  if (!currentState) return;
  updateSettings({ paused: !currentState.paused });
});

els.detachCdpBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ag_detach_all_cdp" }, (res) => {
    if (res?.state) render(res.state);
  });
});

els.reconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ag_reconnect" }, (res) => {
    if (res?.state) render(res.state);
  });
});

els.openSidePanelBtn.addEventListener("click", async () => {
  try {
    const win = await chrome.windows.getCurrent();
    if (chrome.sidePanel?.open && win?.id != null) {
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    }
  } catch {}
});

els.scopeControl.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  updateSettings({ scope: btn.dataset.scope });
});

els.highlightToggle.addEventListener("change", () => {
  updateSettings({ highlight: els.highlightToggle.checked });
});

els.evalToggle.addEventListener("change", () => {
  updateSettings({ allowEval: els.evalToggle.checked });
});

els.domainForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = els.domainInput.value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!raw || !currentState) return;
  const list = Array.from(new Set([...(currentState.blockedDomains || []), raw]));
  els.domainInput.value = "";
  updateSettings({ blockedDomains: list });
});

els.clearLogBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ag_clear_log" }, (res) => {
    if (res?.state) render(res.state);
  });
});

els.saveConnBtn.addEventListener("click", () => {
  const wsUrl = els.wsUrlInput.value.trim();
  const token = els.tokenInput.value.trim();
  if (!wsUrl || !token) return;
  updateSettings({ wsUrl, token });
});

els.toggleTokenBtn.addEventListener("click", () => {
  const isPass = els.tokenInput.type === "password";
  els.tokenInput.type = isPass ? "text" : "password";
  els.toggleTokenBtn.textContent = isPass ? "Hide Token" : "Show Token";
});

// Hide "Side Panel" button when already running in a tall side panel
if (window.innerHeight > 650) {
  els.openSidePanelBtn.classList.add("hidden");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ag_state" && msg.state) {
    render(msg.state);
  }
});

chrome.runtime.sendMessage({ type: "ag_get_state" }, (res) => {
  if (res?.ok) {
    if (res.token) els.tokenInput.value = res.token;
    render(res.state);
  }
});
