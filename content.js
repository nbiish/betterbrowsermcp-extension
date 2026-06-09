/**
 * Better Browser MCP — content script
 *
 * Runs in every page (matches all URLs via manifest.json). Receives
 * tool-call messages from the background script, executes DOM
 * operations, and returns results.
 *
 * ARIA snapshot format:
 *   The snapshot is a YAML tree of accessibility-tree-relevant nodes.
 *   Each interactive element gets a `ref` attribute — a stable string
 *   (e.g. "e1", "e2") that the LLM can use in subsequent tool calls
 *   (browser_click, browser_type, etc.) to reference the element
 *   without re-querying the DOM.
 *
 *   The ref map is stored in a closure variable; refs are stable for
 *   the lifetime of the page. A re-snapshot reassigns refs (the LLM
 *   should re-snapshot periodically to get fresh refs).
 *
 *   refs are intentionally simple: e1, e2, e3, ... up to e999. The
 *   limit is generous for any real page.
 */

(function () {
  "use strict";

  // Don't run in iframes (they get their own content script instance,
  // which complicates the ref map). Bail out early.
  if (window.top !== window) {
    return;
  }

  // ============================================================
  //  Ref management
  // ============================================================

  let nextRefId = 1;
  let refToElement = new Map();

  function resetRefs() {
    nextRefId = 1;
    refToElement = new Map();
  }

  function assignRef(el) {
    if (el.__bbmcpRef) return el.__bbmcpRef;
    const ref = `e${nextRefId++}`;
    el.__bbmcpRef = ref;
    refToElement.set(ref, el);
    return ref;
  }

  function clearRef(el) {
    if (el.__bbmcpRef) {
      refToElement.delete(el.__bbmcpRef);
      el.__bbmcpRef = null;
    }
  }

  // ============================================================
  //  ARIA snapshot
  // ============================================================

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "option",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
  ]);

  // Roles implied by tag, used when ARIA role isn't set
  const TAG_ROLE_HINT = {
    A: el => (el.hasAttribute("href") ? "link" : null),
    BUTTON: () => "button",
    INPUT: el => {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    },
    SELECT: () => "combobox",
    TEXTAREA: () => "textbox",
    SUMMARY: () => "button",
    DETAILS: () => "group",
  };

  function effectiveRole(el) {
    const ariaRole = el.getAttribute("role");
    if (ariaRole) return ariaRole;
    const tag = el.tagName;
    if (TAG_ROLE_HINT[tag]) {
      const r = TAG_ROLE_HINT[tag](el);
      if (r) return r;
    }
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) {
      return "button";
    }
    return null;
  }

  function isInteractive(el) {
    if (el.disabled) return false;
    const role = effectiveRole(el);
    return role !== null && INTERACTIVE_ROLES.has(role);
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function accessibleName(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) ||
      el.getAttribute("alt") ||
      el.getAttribute("value") ||
      ""
    );
  }

  function renderNode(el, depth) {
    if (!isVisible(el)) return null;
    // Skip pure-script/style/meta
    if (["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) {
      return null;
    }

    const role = effectiveRole(el);
    const name = accessibleName(el);
    const indent = "  ".repeat(depth);

    let line = "";
    if (role) {
      const ref = isInteractive(el) ? assignRef(el) : null;
      line = `${indent}- ${role}`;
      if (name) line += ` "${name.replace(/"/g, '\\"').slice(0, 120)}"`;
      if (ref) line += ` [ref=${ref}]`;
    } else {
      line = `${indent}- ${el.tagName.toLowerCase()}`;
      if (name && name.length < 60) line += `: ${name}`;
    }

    const children = [];
    for (const child of el.children) {
      const r = renderNode(child, depth + 1);
      if (r) children.push(r);
    }
    // Also include ARIA-labelled text-only nodes for headings etc.
    if (["H1", "H2", "H3", "H4", "H5", "H6", "P", "LABEL", "LI", "SPAN", "DIV"].includes(el.tagName) && children.length === 0) {
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (text && text.length < 100) {
        children.push(`${indent}  - text: "${text.replace(/"/g, '\\"')}"`);
      }
    }

    return children.length > 0 ? [line, ...children].join("\n") : line;
  }

  function captureSnapshot() {
    resetRefs();
    return renderNode(document.body, 0) || "(empty page)";
  }

  // ============================================================
  //  Element resolution (by ref)
  // ============================================================

  function resolveRef(ref) {
    return refToElement.get(ref) || null;
  }

  // ============================================================
  //  DOM operations
  // ============================================================

  async function clickByRef(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref "${ref}" not found (re-snapshot to get fresh refs)` };
    if (!isVisible(el)) return { ok: false, error: `ref "${ref}" is not visible` };
    el.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((r) => setTimeout(r, 50));
    el.click();
    return { ok: true };
  }

  async function hoverByRef(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref "${ref}" not found` };
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const rect = el.getBoundingClientRect();
    const ev = new MouseEvent("mousemove", {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    el.dispatchEvent(ev);
    return { ok: true };
  }

  async function typeByRef(ref, text, submit) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref "${ref}" not found` };
    el.focus();
    // Set value via the native setter so React/etc. pick it up
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) {
      const form = el.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
        );
      }
    }
    return { ok: true };
  }

  async function selectOptionByRef(ref, values) {
    const el = resolveRef(ref);
    if (!el || el.tagName !== "SELECT") {
      return { ok: false, error: `ref "${ref}" is not a <select>` };
    }
    const valueArr = Array.isArray(values) ? values : [values];
    for (const opt of Array.from(el.options)) {
      opt.selected = valueArr.includes(opt.value);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: valueArr };
  }

  function pressKey(key) {
    // Map common key names to KeyboardEvent properties
    const keyMap = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      Delete: { key: "Delete", code: "Delete", keyCode: 46 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    };
    const k = keyMap[key] || { key, code: key, keyCode: 0 };
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { ...k, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keypress", { ...k, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { ...k, bubbles: true }));
    return { ok: true };
  }

  function getUrl() {
    return window.location.href;
  }

  function getTitle() {
    return document.title;
  }

  function getConsoleLogs() {
    // Console logs are collected by the background via chrome.devtools
    // or chrome.scripting; from the content script side we can only
    // return an empty array (would need a hook installed at the start
    // of the page to capture logs — future enhancement).
    return [];
  }

  // ============================================================
  //  Message handler
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        let result;
        switch (msg.type) {
          case "snapshot":
            result = { snapshot: captureSnapshot() };
            break;
          case "click":
            result = await clickByRef(msg.ref);
            break;
          case "hover":
            result = await hoverByRef(msg.ref);
            break;
          case "type":
            result = await typeByRef(msg.ref, msg.text, !!msg.submit);
            break;
          case "selectOption":
            result = await selectOptionByRef(msg.ref, msg.values);
            break;
          case "pressKey":
            result = pressKey(msg.key);
            break;
          case "getUrl":
            result = { url: getUrl() };
            break;
          case "getTitle":
            result = { title: getTitle() };
            break;
          case "getConsoleLogs":
            result = { logs: getConsoleLogs() };
            break;
          case "ping":
            result = { pong: true, tabId: msg.tabId, url: getUrl() };
            break;
          default:
            result = { error: `Unknown content-script message type: ${msg.type}` };
        }
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true; // async response
  });

  // Tag the page so the background can detect the content script is alive
  document.documentElement.setAttribute("data-bbmcp-content-script", "1");
})();
