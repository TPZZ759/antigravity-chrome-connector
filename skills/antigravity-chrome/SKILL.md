---
name: antigravity-chrome
description: >-
  Ultra-fast Chrome browser automation through the Antigravity Chrome Connector
  MCP (`antigravity-chrome`, v2.0). Use when driving live Chrome tabs via
  cross-frame compact DOM snapshots, diff snapshots, Set-of-Marks visual
  annotations, targeted element search, batched actions, hover/drag, or
  on-demand CDP.
---

# Antigravity Chrome Connector v2.0 Workflow

Use the `antigravity-chrome` MCP server (`browser_*` tools) for fast, low-token, high-accuracy control of the user's real Chrome browser.

## Speed & Accuracy Playbook

1. **Orient fast with `browser_snapshot` or `browser_find`**:
   - Use `browser_snapshot` for compact, modal-first, Shadow DOM + iframe-aware element maps (`[12]` in main frame, `[f7:3]` in iframes).
   - On large pages when looking for one specific control, use `browser_find(query="...", role="button")` (`<5 ms`) instead of dumping the full page.
   - After an interaction on a complex SPA, use `browser_snapshot(diff=true)` to fetch only `+added` / `-removed` elements (70–90% fewer tokens).
2. **Collapse multi-step workflows into `browser_batch`**:
   - Send form fills, selects, clicks, hovers, assertions (`assert_text`, `assert_url`), and waits in **one** `browser_batch` call with `finalSnapshot: true` rather than separate turns.
3. **Use Set-of-Marks (`browser_screenshot(annotate=true)`) for visual/icon UIs**:
   - When buttons lack clear text labels or spatial layout matters (charts, icon toolbars, maps), capture an annotated screenshot — every visible control gets a numbered `[ref]` pill directly on the image plus a matching legend.
4. **Stay banner-free by default, elevate to CDP only on demand**:
   - Standard `browser_snapshot`, `browser_find`, `browser_read_page`, `browser_click`, `browser_hover`, `browser_type`, `browser_select`, `browser_scroll`, `browser_batch`, and viewport `browser_screenshot` never attach `chrome.debugger`.
   - Pass `trusted: true` on `click`/`type`/`hover`/`drag`/`eval` only when a site checks `event.isTrusted` or enforces strict CSP.
   - Use `browser_console`, `browser_network`, or `browser_cdp` for deep debugging, then call `browser_cdp(action="detach_all")` to hide Chrome's debugger banner.
5. **Respect user guardrails**:
   - Honor `PAUSED`, `Scope = Group Only` (open tabs via `browser_tabs(action="open", inGroup=true)`), `Active Tab Only`, `Allow JS Eval`, and `Protected Domains`.
