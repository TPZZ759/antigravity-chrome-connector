(() => {
  if (window.__AG_ENGINE_VERSION__ === "2.0.0") return;
  window.__AG_ENGINE_VERSION__ = "2.0.0";

  const state = {
    refs: new Map(), // number -> WeakRef<Element>
    nextTempRef: 10000,
    generation: 0,
  };

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "checkbox",
    "radio",
    "slider",
    "spinbutton",
    "option",
    "treeitem",
  ]);

  const INTERACTIVE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "SUMMARY",
    "OPTION",
  ]);

  const SOM_CONTAINER_ID = "__ag_som_overlay__";

  function cleanText(str, maxLen = 90) {
    if (!str) return "";
    const s = String(str).replace(/\s+/g, " ").trim();
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + "…";
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity) === 0
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    return true;
  }

  function isInViewport(rect) {
    const pad = 120;
    return (
      rect.bottom >= -pad &&
      rect.right >= -pad &&
      rect.top <= (window.innerHeight || 900) + pad &&
      rect.left <= (window.innerWidth || 1440) + pad
    );
  }

  function isStrictlyInViewport(rect) {
    return (
      rect.width >= 6 &&
      rect.height >= 6 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < (window.innerHeight || 900) &&
      rect.left < (window.innerWidth || 1440)
    );
  }

  function isOccluded(el, rect) {
    if (!isStrictlyInViewport(rect)) return false;
    const cx = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 2);
    const cy = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 2);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return false;
    return hit !== el && !el.contains(hit) && !hit.contains(el);
  }

  function isNativeOrAriaInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "INPUT" && el.type === "hidden") return false;
    if (tag === "A" && !el.hasAttribute("href") && !el.getAttribute("role") && !el.onclick) {
      return false;
    }
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    const tabIdx = el.getAttribute("tabindex");
    if (tabIdx !== null && tabIdx !== "-1") return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("data-action")) return true;
    return false;
  }

  function isSpaClickable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (["HTML", "BODY", "MAIN", "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "UL", "OL", "TABLE", "TBODY", "THEAD", "FORM", "SVG", "PATH"].includes(tag)) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.cursor !== "pointer") return false;
    // Avoid tagging child spans inside an already-interactive ancestor
    const parent = el.parentElement;
    if (parent && (isNativeOrAriaInteractive(parent) || window.getComputedStyle(parent).cursor === "pointer")) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width > window.innerWidth * 0.85 && rect.height > window.innerHeight * 0.5) {
      return false; // Skip giant clickable backdrop wrappers
    }
    const txt = cleanText(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "", 80);
    return txt.length > 0 && txt.length <= 80;
  }

  function isInteractive(el) {
    return isNativeOrAriaInteractive(el) || isSpaClickable(el);
  }

  function getAccessibleLabel(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return cleanText(ariaLabel);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .filter(Boolean);
      if (parts.length) return cleanText(parts.join(" "));
    }

    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl && lbl.innerText) return cleanText(lbl.innerText);
      } catch {}
    }
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel !== el) {
      const txt = cleanText(parentLabel.innerText);
      if (txt) return txt;
    }

    if (el.getAttribute("title")) return cleanText(el.getAttribute("title"));
    if (el.getAttribute("placeholder")) return cleanText(el.getAttribute("placeholder"));
    if (el.getAttribute("alt")) return cleanText(el.getAttribute("alt"));

    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) {
      return cleanText(el.value || el.type);
    }

    const inner = cleanText(el.innerText || el.textContent || "");
    if (inner) return inner;
    if (el.getAttribute("name")) return cleanText(el.getAttribute("name"));
    return "";
  }

  function getRole(el) {
    const explicit = (el.getAttribute("role") || "").toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON") return "button";
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "SELECT") return "combobox";
    if (tag === "SUMMARY") return "summary";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (["submit", "button", "reset"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      return `input[${t}]`;
    }
    if (el.isContentEditable) return "textbox";
    if (isSpaClickable(el)) return "clickable";
    return tag.toLowerCase();
  }

  function* walkElements(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 1) {
        if (node.id === SOM_CONTAINER_ID) continue;
        yield node;
        if (node.shadowRoot) {
          stack.push(node.shadowRoot);
        }
      }
      const children = node.children;
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i]);
        }
      }
    }
  }

  function findActiveModals(root) {
    const modals = [];
    for (const el of root.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
      if (isVisible(el)) modals.push(el);
    }
    return modals;
  }

  function highlightElement(el, color = "#6366f1") {
    try {
      const rect = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText = [
        "position:fixed",
        `left:${Math.max(0, rect.left - 2)}px`,
        `top:${Math.max(0, rect.top - 2)}px`,
        `width:${Math.max(8, rect.width + 4)}px`,
        `height:${Math.max(8, rect.height + 4)}px`,
        `border:2px solid ${color}`,
        "border-radius:6px",
        "background:rgba(99,102,241,0.14)",
        "box-shadow:0 0 0 3px rgba(99,102,241,0.22)",
        "pointer-events:none",
        "z-index:2147483647",
        "transition:opacity 240ms ease",
      ].join(";");
      document.documentElement.appendChild(box);
      setTimeout(() => {
        box.style.opacity = "0";
      }, 320);
      setTimeout(() => {
        box.remove();
      }, 600);
    } catch {}
  }

  function formatElementLine(refTag, el, rect, checkOcclusion) {
    const role = getRole(el);
    const label = getAccessibleLabel(el);
    const extras = [];

    if (el.disabled || el.getAttribute("aria-disabled") === "true") extras.push("disabled");
    if (el.getAttribute("aria-expanded") === "true") extras.push("expanded");
    if (el.getAttribute("aria-selected") === "true") extras.push("selected");
    if (checkOcclusion && isOccluded(el, rect)) extras.push("covered");

    if (el.tagName === "INPUT") {
      if (el.type === "checkbox" || el.type === "radio") {
        extras.push(el.checked ? "checked" : "unchecked");
      } else if (el.type === "password") {
        extras.push(el.value ? "value=••••" : 'value=""');
      } else if (el.value) {
        extras.push(`value=${JSON.stringify(cleanText(el.value, 60))}`);
      }
      if (el.placeholder && label !== cleanText(el.placeholder)) {
        extras.push(`placeholder=${JSON.stringify(cleanText(el.placeholder, 50))}`);
      }
    } else if (el.tagName === "TEXTAREA") {
      if (el.value) extras.push(`value=${JSON.stringify(cleanText(el.value, 60))}`);
    } else if (el.tagName === "SELECT") {
      const opt = el.options?.[el.selectedIndex];
      if (opt) extras.push(`selected=${JSON.stringify(cleanText(opt.text, 50))}`);
    } else if (el.tagName === "A" && el.getAttribute("href")) {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) {
        extras.push(`href=${JSON.stringify(cleanText(href, 70))}`);
      }
    }

    if (!label && !extras.length && !["input", "textarea", "select"].includes(el.tagName.toLowerCase())) {
      return null;
    }

    const labelPart = label ? ` ${JSON.stringify(label)}` : "";
    const extraPart = extras.length ? ` (${extras.join(", ")})` : "";
    return `[${refTag}] ${role}${labelPart}${extraPart}`;
  }

  function resolveElement({ ref, selector, text }) {
    if (ref != null) {
      const num = typeof ref === "string" ? Number(ref.replace(/^f\d+:/, "")) : Number(ref);
      const weak = state.refs.get(num);
      const el = weak ? weak.deref() : null;
      if (el && el.isConnected) return el;
      throw new Error(
        `Element ref [${ref}] is stale or not found. Call browser_snapshot or browser_find to refresh refs.`,
      );
    }
    if (selector) {
      let found = document.querySelector(selector);
      if (!found) {
        for (const node of walkElements(document.documentElement)) {
          if (node.shadowRoot) {
            const inner = node.shadowRoot.querySelector(selector);
            if (inner) {
              found = inner;
              break;
            }
          }
        }
      }
      if (!found) throw new Error(`No element matched selector: ${selector}`);
      return found;
    }
    if (text) {
      const needle = text.trim().toLowerCase();
      let best = null;
      for (const el of walkElements(document.body || document.documentElement)) {
        if (!isInteractive(el) || !isVisible(el)) continue;
        const lbl = getAccessibleLabel(el).toLowerCase();
        if (lbl === needle) return el;
        if (!best && lbl.includes(needle)) best = el;
      }
      if (best) return best;
      throw new Error(`No interactive element matched text: "${text}"`);
    }
    throw new Error("Provide one of: ref, selector, or text.");
  }

  function extractReadableText(rootEl, maxChars) {
    const raw = (rootEl && rootEl.innerText) || "";
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const compact = [];
    for (const line of lines) {
      if (compact[compact.length - 1] !== line) compact.push(line);
    }
    const joined = compact.join("\n");
    if (joined.length <= maxChars) return joined;
    return joined.slice(0, maxChars) + "\n...[truncated]";
  }

  function snapshot(opts = {}) {
    const viewportOnly = Boolean(opts.viewportOnly);
    const maxElements = Math.min(Math.max(Number(opts.maxElements) || 120, 10), 500);
    const includeText = opts.includeText !== false;
    const maxTextChars = Math.min(Math.max(Number(opts.maxTextChars) || 2500, 200), 20000);
    const refPrefix = opts.refPrefix || "";

    const root = opts.selector
      ? document.querySelector(opts.selector)
      : document.body || document.documentElement;
    if (!root) throw new Error(`Snapshot root not found: ${opts.selector}`);

    state.generation += 1;
    state.refs.clear();

    const seenEls = new Set();
    const seenLinkSigs = new Map(); // collapse repetitive identical links (e.g. footnote spam)
    const lines = [];
    let refId = 1;
    let truncated = false;

    const addFromRoot = (scanRoot, sectionHeader) => {
      let headerAdded = false;
      for (const el of walkElements(scanRoot)) {
        if (seenEls.has(el)) continue;
        if (!isInteractive(el)) continue;
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (viewportOnly && !isInViewport(rect)) continue;

        if (refId > maxElements) {
          truncated = true;
          return;
        }

        const refTag = `${refPrefix}${refId}`;
        const line = formatElementLine(refTag, el, rect, lines.length < 60);
        if (!line) continue;

        // Deduplicate repetitive identical links (allow at most 2 occurrences of exact same role+label+href)
        if (el.tagName === "A") {
          const sig = `${getAccessibleLabel(el)}|${el.getAttribute("href") || ""}`;
          const count = seenLinkSigs.get(sig) || 0;
          if (count >= 2) continue;
          seenLinkSigs.set(sig, count + 1);
        }

        if (sectionHeader && !headerAdded) {
          lines.push(sectionHeader);
          headerAdded = true;
        }
        seenEls.add(el);
        state.refs.set(refId, new WeakRef(el));
        lines.push(line);
        refId += 1;
      }
    };

    // Modal-first ordering so popups, dialogs, and cookie banners always appear at the very top
    const modals = !opts.selector ? findActiveModals(root) : [];
    for (const modal of modals) {
      addFromRoot(modal, "--- [Modal / Dialog] ---");
    }
    addFromRoot(root, modals.length ? "--- [Page] ---" : null);

    const res = {
      url: window.location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement.scrollHeight,
      },
      hasModal: modals.length > 0,
      elementCount: state.refs.size,
      truncated,
      lines,
      elements: lines.join("\n"),
    };

    if (includeText) {
      res.text = extractReadableText(root, maxTextChars);
    }
    return res;
  }

  function find(opts = {}) {
    const query = (opts.query || "").trim().toLowerCase();
    const roleFilter = (opts.role || "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 60);
    const refPrefix = opts.refPrefix || "";
    const root = document.body || document.documentElement;

    const matches = [];
    const candidates = opts.selector
      ? Array.from(document.querySelectorAll(opts.selector))
      : walkElements(root);

    for (const el of candidates) {
      if (matches.length >= limit) break;
      if (!opts.selector && !isInteractive(el)) continue;
      if (!isVisible(el)) continue;

      const role = getRole(el).toLowerCase();
      if (roleFilter && !role.includes(roleFilter)) continue;

      const label = getAccessibleLabel(el);
      const placeholder = el.getAttribute("placeholder") || "";
      const href = el.getAttribute("href") || "";
      const haystack = `${label} ${placeholder} ${href}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;

      // Reuse existing ref if already indexed, else allocate a high temp ref
      let assigned = null;
      for (const [k, weak] of state.refs.entries()) {
        if (weak.deref() === el) {
          assigned = k;
          break;
        }
      }
      if (assigned == null) {
        assigned = state.nextTempRef++;
        state.refs.set(assigned, new WeakRef(el));
      }

      const rect = el.getBoundingClientRect();
      const line = formatElementLine(`${refPrefix}${assigned}`, el, rect, true);
      if (line) matches.push(line);
    }

    return {
      url: window.location.href,
      count: matches.length,
      matches,
    };
  }

  function showAnnotations(opts = {}) {
    clearAnnotations();
    // Refresh viewport snapshot first if refs map is empty
    if (state.refs.size === 0 || opts.refresh !== false) {
      snapshot({ viewportOnly: true, maxElements: 90, includeText: false });
    }

    const container = document.createElement("div");
    container.id = SOM_CONTAINER_ID;
    container.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;";

    const legend = [];
    for (const [refId, weak] of state.refs.entries()) {
      const el = weak.deref();
      if (!el || !el.isConnected || !isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (!isStrictlyInViewport(rect)) continue;

      const badge = document.createElement("div");
      const top = Math.max(0, Math.min(rect.top, window.innerHeight - 18));
      const left = Math.max(0, Math.min(rect.left, window.innerWidth - 26));
      badge.textContent = String(refId);
      badge.style.cssText = [
        "position:fixed",
        `top:${Math.round(top)}px`,
        `left:${Math.round(left)}px`,
        "background:#4f46e5",
        "color:#ffffff",
        "font:700 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace",
        "padding:2px 5px",
        "border-radius:4px",
        "border:1px solid #e0e7ff",
        "box-shadow:0 1px 4px rgba(0,0,0,0.45)",
      ].join(";");
      container.appendChild(badge);

      const outline = document.createElement("div");
      outline.style.cssText = [
        "position:fixed",
        `top:${Math.round(rect.top)}px`,
        `left:${Math.round(rect.left)}px`,
        `width:${Math.round(rect.width)}px`,
        `height:${Math.round(rect.height)}px`,
        "border:1.5px solid rgba(79,70,229,0.75)",
        "border-radius:3px",
      ].join(";");
      container.appendChild(outline);

      const line = formatElementLine(String(refId), el, rect, false);
      if (line) legend.push(line);
      if (legend.length >= 80) break;
    }

    document.documentElement.appendChild(container);
    return { count: legend.length, legend: legend.join("\n") };
  }

  function clearAnnotations() {
    const existing = document.getElementById(SOM_CONTAINER_ID);
    if (existing) existing.remove();
    return { cleared: true };
  }

  function readPage(opts = {}) {
    const mode = opts.mode || "text";
    const maxChars = Math.min(Math.max(Number(opts.maxChars) || 12000, 200), 40000);
    const root = opts.selector
      ? document.querySelector(opts.selector)
      : document.body || document.documentElement;
    if (!root) throw new Error(`Selector not found: ${opts.selector}`);

    if (mode === "text") {
      return {
        url: window.location.href,
        title: document.title,
        text: extractReadableText(root, maxChars),
      };
    }
    if (mode === "links") {
      const links = [];
      const seen = new Set();
      for (const a of root.querySelectorAll("a[href]")) {
        if (!isVisible(a)) continue;
        const href = a.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        links.push({ text: cleanText(a.innerText || a.getAttribute("aria-label") || "", 80), href });
        if (links.length >= 250) break;
      }
      return { url: window.location.href, count: links.length, links };
    }
    if (mode === "tables") {
      const tables = [];
      for (const tbl of root.querySelectorAll("table")) {
        if (!isVisible(tbl)) continue;
        const rows = [];
        for (const tr of tbl.querySelectorAll("tr")) {
          const cells = Array.from(tr.querySelectorAll("th,td")).map((c) =>
            cleanText(c.innerText, 120),
          );
          if (cells.some(Boolean)) rows.push(cells);
          if (rows.length >= 100) break;
        }
        if (rows.length) tables.push(rows);
        if (tables.length >= 15) break;
      }
      return { url: window.location.href, tableCount: tables.length, tables };
    }
    if (mode === "forms") {
      const fields = [];
      for (const el of root.querySelectorAll("input,textarea,select")) {
        if (el.tagName === "INPUT" && el.type === "hidden") continue;
        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          name: el.name || null,
          id: el.id || null,
          label: getAccessibleLabel(el),
          value: el.type === "password" ? (el.value ? "••••" : "") : cleanText(el.value, 120),
          checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined,
        });
      }
      return { url: window.location.href, fieldCount: fields.length, fields };
    }
    if (mode === "html") {
      const html = root.outerHTML || "";
      return {
        url: window.location.href,
        html: html.length <= maxChars ? html : html.slice(0, maxChars) + "\n<!-- truncated -->",
      };
    }
    throw new Error(`Unsupported read mode: ${mode}`);
  }

  function getElementPoint(opts = {}) {
    const el = resolveElement(opts);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    if (opts.highlight !== false) highlightElement(el);
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      tag: el.tagName.toLowerCase(),
      label: getAccessibleLabel(el),
      occluded: isOccluded(el, rect),
    };
  }

  function hover(opts = {}) {
    const el = resolveElement(opts);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (opts.highlight !== false) highlightElement(el, "#06b6d4");
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    el.dispatchEvent(new PointerEvent("pointerover", init));
    el.dispatchEvent(new MouseEvent("mouseover", init));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...init, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }));
    el.dispatchEvent(new PointerEvent("pointermove", init));
    el.dispatchEvent(new MouseEvent("mousemove", init));
    return {
      hovered: true,
      tag: el.tagName.toLowerCase(),
      label: getAccessibleLabel(el),
    };
  }

  function dragSynthetic(opts = {}) {
    const src = resolveElement({ ref: opts.sourceRef, selector: opts.sourceSelector });
    src.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const sRect = src.getBoundingClientRect();
    const sx = sRect.left + sRect.width / 2;
    const sy = sRect.top + sRect.height / 2;

    let dst = null;
    let tx = sx + (Number(opts.deltaX) || 0);
    let ty = sy + (Number(opts.deltaY) || 0);
    if (opts.targetRef != null || opts.targetSelector) {
      dst = resolveElement({ ref: opts.targetRef, selector: opts.targetSelector });
      dst.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const tRect = dst.getBoundingClientRect();
      tx = tRect.left + tRect.width / 2;
      ty = tRect.top + tRect.height / 2;
    }

    const dt = new DataTransfer();
    src.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: sx, clientY: sy }));
    src.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: sx, clientY: sy }));
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));

    const dropTarget = dst || document.elementFromPoint(tx, ty) || document.body;
    dropTarget.dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: dt }),
    );
    dropTarget.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: dt }),
    );
    dropTarget.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: dt }),
    );
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    dropTarget.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: tx, clientY: ty }));
    dropTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: tx, clientY: ty }));
    return { dragged: true, from: { x: Math.round(sx), y: Math.round(sy) }, to: { x: Math.round(tx), y: Math.round(ty) } };
  }

  function click(opts = {}) {
    const el = resolveElement(opts);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (opts.highlight !== false) highlightElement(el);
    const rect = el.getBoundingClientRect();
    const occluded = isOccluded(el, rect);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const evtInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: opts.rightClick ? 2 : 0,
    };

    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerdown", evtInit));
    el.dispatchEvent(new MouseEvent("mousedown", evtInit));
    el.dispatchEvent(new PointerEvent("pointerup", evtInit));
    el.dispatchEvent(new MouseEvent("mouseup", evtInit));

    if (opts.rightClick) {
      el.dispatchEvent(new MouseEvent("contextmenu", evtInit));
    } else if (opts.doubleClick) {
      el.click();
      el.click();
      el.dispatchEvent(new MouseEvent("dblclick", evtInit));
    } else {
      el.click();
    }

    return {
      clicked: true,
      occluded,
      tag: el.tagName.toLowerCase(),
      label: getAccessibleLabel(el),
      url: window.location.href,
    };
  }

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function typeText(opts = {}) {
    const el = resolveElement(opts);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (opts.highlight !== false) highlightElement(el, "#10b981");
    if (typeof el.focus === "function") el.focus({ preventScroll: true });

    const text = String(opts.text ?? "");
    const clear = opts.clear !== false;

    if (el.isContentEditable) {
      if (clear) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("delete", false);
      }
      if (!document.execCommand("insertText", false, text)) {
        el.textContent = clear ? text : (el.textContent || "") + text;
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            composed: true,
            data: text,
            inputType: "insertText",
          }),
        );
      }
    } else {
      const nextVal = clear ? text : (el.value || "") + text;
      setNativeValue(el, nextVal);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          data: text,
          inputType: "insertText",
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    if (opts.submit) {
      pressKey({ key: "Enter", _target: el });
      if (el.form && typeof el.form.requestSubmit === "function") {
        try {
          el.form.requestSubmit();
        } catch {}
      }
    }

    return {
      typed: true,
      tag: el.tagName.toLowerCase(),
      label: getAccessibleLabel(el),
      length: text.length,
    };
  }

  function selectOption(opts = {}) {
    const el = resolveElement(opts);
    if (el.tagName !== "SELECT") {
      throw new Error(`Target element is <${el.tagName.toLowerCase()}>, not <select>.`);
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (opts.highlight !== false) highlightElement(el, "#10b981");

    const options = Array.from(el.options || []);
    let matched = null;
    if (opts.value !== undefined) matched = options.find((o) => o.value === opts.value);
    if (!matched && opts.label !== undefined) {
      const needle = opts.label.trim().toLowerCase();
      matched =
        options.find((o) => o.text.trim().toLowerCase() === needle) ||
        options.find((o) => o.text.trim().toLowerCase().includes(needle));
    }
    if (!matched) {
      throw new Error(
        `No matching option found. Available: ${options
          .slice(0, 20)
          .map((o) => `${o.text} (${o.value})`)
          .join(", ")}`,
      );
    }

    setNativeValue(el, matched.value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { selected: true, value: matched.value, label: matched.text };
  }

  function pressKey(opts = {}) {
    let target = opts._target || document.activeElement || document.body;
    if (!opts._target && (opts.ref != null || opts.selector)) {
      target = resolveElement(opts);
      if (typeof target.focus === "function") target.focus({ preventScroll: true });
    }
    const raw = String(opts.key || "Enter");
    const parts = raw.split("+").map((p) => p.trim());
    const mainKey = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));

    const init = {
      key: mainKey,
      code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt"),
      metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
    };

    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { pressed: raw, target: target?.tagName?.toLowerCase() || "document" };
  }

  function scroll(opts = {}) {
    const dir = opts.direction || "down";
    const amount = Number(opts.amount) || 650;

    if (dir === "to_ref" && opts.ref != null) {
      const el = resolveElement({ ref: opts.ref });
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return { scrolled: "to_ref", ref: opts.ref, scrollY: Math.round(window.scrollY) };
    }

    const container = opts.selector ? document.querySelector(opts.selector) : null;
    if (container) {
      if (dir === "top") container.scrollTop = 0;
      else if (dir === "bottom") container.scrollTop = container.scrollHeight;
      else if (dir === "up") container.scrollTop -= amount;
      else container.scrollTop += amount;
      return { scrolled: dir, container: opts.selector, scrollTop: Math.round(container.scrollTop) };
    }

    if (dir === "top") window.scrollTo(0, 0);
    else if (dir === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
    else if (dir === "up") window.scrollBy(0, -amount);
    else window.scrollBy(0, amount);

    return {
      scrolled: dir,
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
    };
  }

  function assertText(opts = {}) {
    const needle = String(opts.text || "").trim();
    if (!needle) throw new Error("assert_text requires text");
    const bodyText = (document.body?.innerText || "").toLowerCase();
    if (!bodyText.includes(needle.toLowerCase())) {
      throw new Error(`Assertion failed: page does not contain text "${needle}"`);
    }
    return { asserted: true, text: needle };
  }

  function wait(opts = {}) {
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 10000, 100), 60000);
    if (opts.ms != null && !opts.selector && !opts.text && !opts.domIdleMs) {
      return new Promise((resolve) =>
        setTimeout(() => resolve({ waited: true, ms: opts.ms }), opts.ms),
      );
    }

    if (opts.domIdleMs) {
      const idleTarget = Math.min(Math.max(Number(opts.domIdleMs), 100), 5000);
      return new Promise((resolve) => {
        let idleTimer = null;
        let maxTimer = null;
        const done = (timedOut) => {
          observer.disconnect();
          clearTimeout(idleTimer);
          clearTimeout(maxTimer);
          resolve({ waited: true, domIdleMs: idleTarget, timedOut });
        };
        const bump = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => done(false), idleTarget);
        };
        const observer = new MutationObserver(bump);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
        bump();
        maxTimer = setTimeout(() => done(true), timeoutMs);
      });
    }

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (opts.selector) {
          const el = document.querySelector(opts.selector);
          if (el && isVisible(el)) return { matched: "selector", selector: opts.selector };
        }
        if (opts.text) {
          const bodyText = (document.body?.innerText || "").toLowerCase();
          if (bodyText.includes(opts.text.toLowerCase())) {
            return { matched: "text", text: opts.text };
          }
        }
        return null;
      };

      const initial = check();
      if (initial) return resolve({ waited: true, elapsedMs: 0, ...initial });

      const interval = setInterval(() => {
        const hit = check();
        if (hit) {
          clearInterval(interval);
          resolve({ waited: true, elapsedMs: Date.now() - started, ...hit });
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(interval);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for ${
                opts.selector ? `selector '${opts.selector}'` : `text '${opts.text}'`
              }`,
            ),
          );
        }
      }, 100);
    });
  }

  function readStorage(opts = {}) {
    const out = {};
    if (opts.includeLocalStorage !== false) {
      const ls = {};
      for (let i = 0; i < Math.min(window.localStorage.length, 150); i++) {
        const k = window.localStorage.key(i);
        const v = window.localStorage.getItem(k);
        ls[k] = v && v.length > 500 ? v.slice(0, 500) + "…[truncated]" : v;
      }
      out.localStorage = ls;
    }
    if (opts.includeSessionStorage) {
      const ss = {};
      for (let i = 0; i < Math.min(window.sessionStorage.length, 150); i++) {
        const k = window.sessionStorage.key(i);
        const v = window.sessionStorage.getItem(k);
        ss[k] = v && v.length > 500 ? v.slice(0, 500) + "…[truncated]" : v;
      }
      out.sessionStorage = ss;
    }
    return out;
  }

  window.__AG_ENGINE__ = {
    snapshot,
    find,
    showAnnotations,
    clearAnnotations,
    readPage,
    getElementPoint,
    hover,
    dragSynthetic,
    click,
    typeText,
    selectOption,
    pressKey,
    scroll,
    assertText,
    wait,
    readStorage,
  };
})();
