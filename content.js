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
  //  Clipboard capture (for "Click to copy" buttons like Stripe's
  //  publishable/secret key copy buttons, GitHub PAT copy buttons,
  //  AWS access key copy buttons, etc.)
  //
  //  Pattern: the page calls navigator.clipboard.writeText(value)
  //  when the user clicks the copy button. We monkey-patch that
  //  method to capture the value into a module-scoped variable
  //  before passing through to the real API. The extension can
  //  then read the captured value via the browser_copy_to_clipboard
  //  tool.
  //
  //  This is more reliable than chrome.tabs.executeScript or
  //  reading the clipboard from the extension (which requires
  //  the page to be focused and a user gesture).
  // ============================================================

  let lastCopiedText = null;
  let lastCopiedAt = 0;
  const CLIPBOARD_CAPTURE_TTL_MS = 60_000; // 60s — enough for any reasonable tool call gap

  (function patchClipboardWriteText() {
    if (!navigator.clipboard || navigator.clipboard.writeText.__bbmcpPatched) {
      return;
    }
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async function bbmcpPatchedWriteText(text) {
      try {
        lastCopiedText = String(text);
        lastCopiedAt = Date.now();
        // Also dispatch a DOM event so page-level handlers can see
        // that the clipboard was written. Useful for tests and for
        // any future integration that wants to react.
        try {
          window.dispatchEvent(
            new CustomEvent("bbmcp-clipboard-write", { detail: { text } }),
          );
        } catch {
          // ignore
        }
      } catch {
        // ignore capture errors — we still want to fall through to write
      }
      return original(text);
    };
    navigator.clipboard.writeText.__bbmcpPatched = true;
  })();

  function getLastCopiedText() {
    if (lastCopiedText === null) return null;
    if (Date.now() - lastCopiedAt > CLIPBOARD_CAPTURE_TTL_MS) {
      // Stale — clear so the next call returns null
      lastCopiedText = null;
      lastCopiedAt = 0;
      return null;
    }
    return lastCopiedText;
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

  /**
   * Click a "Click to copy" button and return the value the page
   * wrote to the clipboard. The page's click handler calls
   * navigator.clipboard.writeText(value) — we patched that method
   * above to capture the value into `lastCopiedText`.
   *
   * Combined click+read in one tool call so there's no race between
   * the click handler and the read.
   */
  async function clickAndReadClipboard(ref) {
    const el = resolveRef(ref);
    if (!el) {
      return { ok: false, error: `ref "${ref}" not found (re-snapshot to get fresh refs)` };
    }
    if (!isVisible(el)) {
      return { ok: false, error: `ref "${ref}" is not visible` };
    }
    // Snapshot the captured value before the click so we can detect
    // whether the click handler actually wrote something new.
    const before = lastCopiedAt;
    el.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((r) => setTimeout(r, 30));
    try {
      el.click();
    } catch (err) {
      return { ok: false, error: `click failed: ${err.message || err}` };
    }
    // Some sites defer the clipboard write slightly (e.g. via
    // requestAnimationFrame or a microtask). Wait up to 1.5s for
    // a fresh capture.
    const deadline = Date.now() + 1500;
    let value = null;
    while (Date.now() < deadline) {
      if (lastCopiedAt > before) {
        value = getLastCopiedText();
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (value === null) {
      return {
        ok: false,
        error:
          "clicked the element but no clipboard.writeText was observed within 1.5s. " +
          "The site may use a different copy mechanism (e.g. document.execCommand('copy') or " +
          "an out-of-page modal showing the value). " +
          "lastCopiedAt=" + lastCopiedAt + " before=" + before,
      };
    }
    return { ok: true, value, ref };
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
  //  v0.5.0+ extraction & SPA-state handlers
  // ============================================================

  /**
   * Paste `text` into `el`. For input/textarea uses the React-friendly
   * native-setter pattern (bypasses React's value tracker so controlled
   * inputs accept the value, then dispatches `input` + `change`).
   * For contenteditable uses `document.execCommand("insertText", ...)`
   * which most rich-text editors (TipTap, ProseMirror, Slate) accept.
   */
  async function pasteText(text, ref) {
    let el;
    if (ref) {
      el = resolveRef(ref);
      if (!el) return { ok: false, error: `ref "${ref}" not found (re-snapshot to get fresh refs)` };
      if (!isVisible(el)) return { ok: false, error: `ref "${ref}" is not visible` };
      el.focus();
    } else {
      el = document.activeElement;
      if (!el || el === document.body) {
        return {
          ok: false,
          error:
            "no element is focused and no `ref` was provided. " +
            "Call browser_snapshot to find a target, then browser_click to focus it before pasting.",
        };
      }
    }
    const tag = el.tagName;
    const isInput = tag === "INPUT";
    const isTextarea = tag === "TEXTAREA";
    const isContentEditable = el.isContentEditable;
    if (!isInput && !isTextarea && !isContentEditable) {
      return {
        ok: false,
        error:
          `target element <${tag.toLowerCase()}> is not an editable input, textarea, or contenteditable. ` +
          `Paste requires an editable target.`,
      };
    }
    try {
      if (isInput || isTextarea) {
        const proto = isInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        // Contenteditable path
        const ok = document.execCommand("insertText", false, text);
        if (!ok) {
          return {
            ok: false,
            error:
              "document.execCommand('insertText', ...) returned false. " +
              "The rich-text editor rejected the paste. " +
              "Try browser_press_key to send real keystrokes, or browser_evaluate for an editor-specific API.",
          };
        }
      }
    } catch (err) {
      return { ok: false, error: `paste failed: ${err.message || err}` };
    }
    return { ok: true, ref: ref || null, textLength: String(text).length };
  }

  /**
   * Poll `document.body.innerText` for a case-insensitive substring
   * match. Resolves on first hit; rejects on timeout. Body text is
   * cheap to compute and good enough for the "wait for X to appear"
   * use case (form submission, dashboard render completion, etc.).
   */
  async function waitForText(text, timeout) {
    const want = String(text || "").toLowerCase().trim();
    if (!want) {
      return { ok: false, error: "browser_wait_for_text requires non-empty `text`" };
    }
    const start = Date.now();
    const deadline = start + (Number(timeout) || 30) * 1000;
    let lastBody = "";
    while (Date.now() < deadline) {
      lastBody = (document.body && document.body.innerText) || "";
      if (lastBody.toLowerCase().includes(want)) {
        return { ok: true, elapsedMs: Date.now() - start };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      ok: false,
      error: `text "${text}" not found within ${timeout || 30}s`,
      elapsedMs: Date.now() - start,
      bodyTextLength: lastBody.length,
    };
  }

  /**
   * Read a single attribute from a ref'd element. Special-cases
   * `value` for input/textarea (which is a property, not an attribute,
   * so getAttribute returns the default, not the current value).
   */
  async function getAttribute(ref, attr) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref "${ref}" not found (re-snapshot to get fresh refs)` };
    if (!isVisible(el)) return { ok: false, error: `ref "${ref}" is not visible` };
    let value;
    if (attr === "value" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) {
      value = el.value;
    } else if (attr in el && typeof el[attr] !== "function") {
      // Property access (e.g. el.tagName, el.id, el.href on <a>)
      const prop = el[attr];
      value = prop === null || prop === undefined ? "" : String(prop);
    } else {
      const attrValue = el.getAttribute(attr);
      value = attrValue === null ? "" : attrValue;
    }
    return { ok: true, value, attr };
  }

  /**
   * Extract the textContent of a single ref'd element, with
   * whitespace normalized. Cheaper than a full snapshot.
   */
  async function extractText(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref "${ref}" not found (re-snapshot to get fresh refs)` };
    if (!isVisible(el)) return { ok: false, error: `ref "${ref}" is not visible` };
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    return { ok: true, text, ref };
  }

  /**
   * Run an arbitrary JS expression in the page's global scope via
   * indirect eval. Returns the JSON-serializable result. The server
   * caps the serialized output at 10KB.
   *
   * Note: indirect eval runs in the page's global scope. Side effects
   * (window.* assignments, DOM mutations) DO persist. The MCP server
   * is responsible for limiting the blast radius via input review.
   */
  async function evaluate(expression) {
    if (typeof expression !== "string" || !expression.trim()) {
      return { ok: false, error: "browser_evaluate requires non-empty `expression`" };
    }
    let value;
    try {
      // (0, eval) is indirect eval — runs in the global scope, not the
      // local function scope, so it sees window.* / document / etc.
      // eslint-disable-next-line no-eval
      value = (0, eval)(expression);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (value === undefined) {
      // JSON.stringify drops undefined. Coerce to null so the LLM
      // gets a clear "the expression returned undefined" signal.
      return { ok: true, value: null, undefined: true };
    }
    // Best-effort JSON-safety check; if it can't be serialized,
    // the server's handler will return an error and the LLM can
    // adjust the expression. We pass through anything that survives
    // JSON.stringify to keep the result useful.
    try {
      JSON.stringify(value);
    } catch (e) {
      return {
        ok: false,
        error:
          `expression returned a value that is not JSON-serializable: ${e.message}. ` +
          `Coerce to a plain object/array/string/number in the expression ` +
          `(e.g. Array.from(document.querySelectorAll('a')).map(a => a.href)).`,
      };
    }
    return { ok: true, value };
  }

  // ============================================================
  //  Message handler
  // ============================================================

  /**
   * The MCP server names tools with a "browser_" prefix
   * (browser_click, browser_snapshot, etc.). The content script's
   * switch is keyed on the un-prefixed name. This helper accepts
   * either form and returns the un-prefixed name, so the case
   * statements below stay readable.
   *
   * Unprefixed names that don't start with "browser_" pass through
   * unchanged (getUrl, getTitle, getConsoleLogs, ping, etc.).
   */
  function stripBrowserPrefix(type) {
    if (typeof type !== "string") return type;
    return type.startsWith("browser_") ? type.slice("browser_".length) : type;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        let result;
        // The MCP server sends messages with the full prefixed type
        // (browser_click, browser_snapshot, browser_press_key, etc.) but
        // the content script's switch is keyed on the un-prefixed name.
        // stripBrowserPrefix() normalizes either form to the un-prefixed
        // name so the case statements stay readable.
        const m = stripBrowserPrefix(msg.type);
        switch (m) {
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
          case "copyToClipboard":
            // Click a "Click to copy" button and return the value
            // the page wrote to the clipboard. Combined into one
            // tool call to avoid the round-trip race between
            // click and read.
            result = await clickAndReadClipboard(msg.ref);
            break;
          // ---- v0.5.0+ extraction & SPA-state handlers ----
          case "pasteText":
            result = await pasteText(msg.text, msg.ref);
            break;
          case "waitForText":
            result = await waitForText(msg.text, msg.timeout);
            break;
          case "getAttribute":
            result = await getAttribute(msg.ref, msg.attr);
            break;
          case "extractText":
            result = await extractText(msg.ref);
            break;
          case "evaluate":
            result = await evaluate(msg.expression);
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
