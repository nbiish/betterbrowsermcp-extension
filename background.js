/**
 * Better Browser MCP — service worker (v0.2.0 — multi-tab)
 *
 * Manages N WebSocket connections (one per configured agent) and
 * routes browser_* tool calls to the right tab. Supports:
 *
 * - Multiple tabs bound to one agent
 * - Each tab has a human-readable label (so the LLM can refer to
 *   "the Stripe tab" rather than "tab 12345")
 * - One "active" tab per agent — tool calls without an explicit
 *   tabId route to the active tab
 * - Tab management tools (list/open/close/rename/setActive) so the
 *   agent (and the user via the popup) can manage its tab roster
 *
 * Architecture:
 *   chrome.storage.sync["endpoints"]  list of {id, url, token?}
 *     WebSocket endpoints to maintain connections to
 *   chrome.storage.local["bindings"]  {tabId: agentId} — which tab
 *     is bound to which agent
 *   chrome.storage.local["tabMeta"]    {tabId: {label, url, title,
 *     boundAt}} — per-tab metadata
 *   chrome.storage.local["activeTabs"] {agentId: tabId} — active tab
 *     per agent
 *
 * Outgoing WS messages (server → extension):
 *   browser_navigate     {url, tabId?}
 *   browser_snapshot     {tabId?}
 *   browser_click        {element, ref, tabId?}
 *   browser_hover        {element, ref, tabId?}
 *   browser_type         {element, ref, text, submit, tabId?}
 *   browser_select_option {element, ref, values, tabId?}
 *   browser_press_key    {key, tabId?}
 *   browser_screenshot   {tabId?}
 *   browser_get_console_logs {tabId?}
 *   browser_go_back      {tabId?}
 *   browser_go_forward   {tabId?}
 *   browser_list_tabs    (no payload) — list bound tabs with labels
 *   browser_open_tab     {url?, label?}
 *   browser_close_tab    {tabId}
 *   browser_rename_tab   {tabId, label}
 *   browser_set_active_tab {tabId}
 *
 * Incoming WS messages (extension → server):
 *   {type: "messageResponse", payload: {requestId, result|error}}
 */

// ============================================================
//  Constants
// ============================================================

const WS_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const WS_REQUEST_TIMEOUT_MS = 30000;
const CONTENT_SCRIPT_PING_TIMEOUT_MS = 5000;

// ============================================================
//  In-memory state
// ============================================================

/** agentId -> WebSocket */
const connections = new Map();
/** agentId -> { url, token?, status, lastError?, connectedAt? } */
const agentMeta = new Map();
/** tabId (number) -> agentId */
let tabBindings = {};
/** tabId -> {label, url, title, boundAt} */
let tabMeta = {};
/** agentId -> active tabId */
let activeTabs = {};
/** requestId -> { resolve, reject, agentId, method, startedAt } */
const pendingRequests = new Map();
let nextRequestId = 1;

// ============================================================
//  Storage helpers
// ============================================================

async function loadEndpoints() {
  const { endpoints = [] } = await chrome.storage.sync.get("endpoints");
  return endpoints;
}

async function loadAll() {
  const local = await chrome.storage.local.get(["bindings", "tabMeta", "activeTabs"]);
  tabBindings = local.bindings || {};
  tabMeta = local.tabMeta || {};
  activeTabs = local.activeTabs || {};
}

async function saveBindings() {
  await chrome.storage.local.set({ bindings: tabBindings });
}

async function saveTabMeta() {
  await chrome.storage.local.set({ tabMeta });
}

async function saveActiveTabs() {
  await chrome.storage.local.set({ activeTabs });
}

// ============================================================
//  WebSocket lifecycle (unchanged from v0.2.0-pre-multi-tab)
// ============================================================

function connectAgent(endpoint) {
  const { id, url, token } = endpoint;
  disconnectAgent(id);

  const meta = {
    url,
    token: token || null,
    status: "connecting",
    lastError: null,
    connectedAt: null,
  };
  agentMeta.set(id, meta);

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    meta.status = "disconnected";
    meta.lastError = String(err);
    return;
  }

  let backoffIndex = 0;
  let pingTimer = null;

  function scheduleReconnect() {
    if (connections.get(id) !== ws) return;
    const delay = WS_RECONNECT_BACKOFF_MS[Math.min(backoffIndex, WS_RECONNECT_BACKOFF_MS.length - 1)];
    backoffIndex++;
    setTimeout(() => {
      if (connections.get(id) === ws) {
        connectAgent(endpoint);
      }
    }, delay);
  }

  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: `ping-${Date.now()}`, type: "ping" }));
      }
    }, 25000);
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  ws.addEventListener("open", () => {
    meta.status = "connected";
    meta.connectedAt = Date.now();
    meta.lastError = null;
    backoffIndex = 0;
    if (token) {
      ws.send(JSON.stringify({ id: `auth-${Date.now()}`, type: "auth", token }));
    }
    startPing();
    broadcastStatus();
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg?.type === "messageResponse") {
      // Correlation reply to an outgoing request
      const pending = pendingRequests.get(msg.payload?.requestId);
      if (pending) {
        pendingRequests.delete(msg.payload.requestId);
        if (msg.payload.error) {
          pending.reject(new Error(msg.payload.error));
        } else {
          pending.resolve(msg.payload.result);
        }
      }
      return;
    }
    // Incoming request from the server: dispatch it. The id in the
    // request is the same id the server will correlate on the reply
    // (we send back {type:"messageResponse", payload:{requestId, ...}}).
    if (msg?.id && msg?.type && msg.type !== "ping") {
      const requestId = msg.id.replace(/^req-/, "");
      dispatchAgentRequest(id, msg.type, msg.payload, requestId);
    }
  });

  ws.addEventListener("close", (event) => {
    stopPing();
    if (connections.get(id) === ws) {
      connections.delete(id);
      meta.status = "disconnected";
      meta.lastError = `Connection closed (code=${event.code})`;
      broadcastStatus();
      scheduleReconnect();
    }
  });

  ws.addEventListener("error", () => {
    meta.lastError = "WebSocket error";
  });

  connections.set(id, ws);
  meta.status = "connecting";
  broadcastStatus();
}

function disconnectAgent(id) {
  const ws = connections.get(id);
  if (ws) {
    connections.delete(id);
    try {
      ws.close(1000, "replaced");
    } catch {
      // ignore
    }
  }
  const meta = agentMeta.get(id);
  if (meta) meta.status = "disconnected";
}

// ============================================================
//  Tab metadata
// ============================================================

function defaultLabelFor(tab) {
  if (!tab) return "tab";
  try {
    const u = new URL(tab.url || "about:blank");
    return u.hostname || tab.title || "tab";
  } catch {
    return tab.title || "tab";
  }
}

async function recordTabInfo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;
    const existing = tabMeta[tabId] || {};
    tabMeta[tabId] = {
      label: existing.label || defaultLabelFor(tab),
      url: tab.url || "",
      title: tab.title || "",
      boundAt: existing.boundAt || Date.now(),
    };
    await saveTabMeta();
  } catch {
    // tab might be gone
  }
}

function resolveTabForAgent(agentId, explicitTabId) {
  if (explicitTabId !== undefined && explicitTabId !== null) {
    if (tabBindings[explicitTabId] === agentId) {
      return explicitTabId;
    }
    return { error: `Tab ${explicitTabId} is not bound to agent "${agentId}"` };
  }
  // No explicit tab — use the agent's active tab
  const active = activeTabs[agentId];
  if (active !== undefined && tabBindings[active] === agentId) {
    return active;
  }
  // Fall back to the first bound tab for this agent
  for (const [tid, aid] of Object.entries(tabBindings)) {
    if (aid === agentId) {
      return parseInt(tid, 10);
    }
  }
  return { error: `No tabs bound to agent "${agentId}". Have the user open a tab and bind it via the extension popup.` };
}

async function getBoundTabsForAgent(agentId) {
  const result = [];
  for (const [tidStr, aid] of Object.entries(tabBindings)) {
    if (aid !== agentId) continue;
    const tid = parseInt(tidStr, 10);
    const meta = tabMeta[tid] || { label: "tab", url: "", title: "" };
    let live = null;
    try {
      const t = await chrome.tabs.get(tid);
      live = {
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
      };
    } catch {
      // tab gone
    }
    result.push({
      tabId: tid,
      label: meta.label,
      url: live?.url || meta.url,
      title: live?.title || meta.title,
      isActive: activeTabs[agentId] === tid,
      windowId: live?.windowId,
    });
  }
  return result;
}

// ============================================================
//  Content script interaction
// ============================================================

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping", tabId });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function sendToContentScript(tabId, msg) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, msg);
    if (!response) {
      return { ok: false, error: "No response from content script" };
    }
    return response;
  } catch (err) {
    return { ok: false, error: `Content script error: ${err.message || err}` };
  }
}

async function takeScreenshot(tabId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tabId, { format: "png" });
    // dataUrl is "data:image/png;base64,...." — strip the prefix
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    return { ok: true, image: b64, mimeType: "image/png" };
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err.message || err}` };
  }
}

// ============================================================
//  Tool dispatch (the heart of the multi-tab routing)
// ============================================================

// Maps a browser_* tool type to the content-script message type and
// payload mapping. The tabId is always stripped from the payload
// before forwarding to the content script.
async function executeTool(agentId, method, payload) {
  const explicitTabId = payload?.tabId;
  const resolved = resolveTabForAgent(agentId, explicitTabId);
  if (typeof resolved === "object" && resolved.error) {
    return { ok: false, error: resolved.error };
  }
  const tabId = resolved;
  const meta = tabMeta[tabId];
  if (!meta) {
    return { ok: false, error: `Tab ${tabId} has no recorded metadata` };
  }

  // Navigate is a chrome.tabs.update — the content script doesn't
  // handle location changes (it would miss the new page).
  if (method === "browser_navigate") {
    const { url } = payload || {};
    if (!url) return { ok: false, error: "browser_navigate requires {url}" };
    try {
      await chrome.tabs.update(tabId, { url });
      // Give the page a moment to load (best-effort)
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true, url, tabId, label: meta.label };
    } catch (err) {
      return { ok: false, error: `navigate failed: ${err.message || err}` };
    }
  }

  if (method === "browser_go_back") {
    try {
      await chrome.tabs.goBack(tabId);
      return { ok: true, tabId, label: meta.label };
    } catch (err) {
      return { ok: false, error: `goBack failed: ${err.message || err}` };
    }
  }

  if (method === "browser_go_forward") {
    try {
      await chrome.tabs.goForward(tabId);
      return { ok: true, tabId, label: meta.label };
    } catch (err) {
      return { ok: false, error: `goForward failed: ${err.message || err}` };
    }
  }

  if (method === "browser_screenshot") {
    return await takeScreenshot(tabId);
  }

  // All other browser_* methods are handled by the content script
  // in the target tab
  const contentMsg = stripTabId(method, payload);
  const response = await sendToContentScript(tabId, contentMsg);
  return { ...response, tabId, label: meta.label };
}

function stripTabId(method, payload) {
  const { tabId: _ignore, ...rest } = payload || {};
  return { type: method, ...rest };
}

// ============================================================
//  Outgoing requests (server → extension via WS)
// ============================================================

function callAgent(agentId, method, params) {
  return new Promise((resolve, reject) => {
    const ws = connections.get(agentId);
    const meta = agentMeta.get(agentId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`Agent "${agentId}" is not connected (${meta?.status || "unknown"})`));
      return;
    }
    const id = `req-${nextRequestId++}`;
    pendingRequests.set(id, { resolve, reject, agentId, method, startedAt: Date.now() });
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Request to agent "${agentId}" timed out after ${WS_REQUEST_TIMEOUT_MS}ms`));
      }
    }, WS_REQUEST_TIMEOUT_MS);
    try {
      ws.send(JSON.stringify({ id, type: method, payload: params }));
    } catch (err) {
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

// ============================================================
//  Management tool dispatch (new tab management tools)
// ============================================================

async function handleListTabs(agentId) {
  const tabs = await getBoundTabsForAgent(agentId);
  return { ok: true, tabs, activeTabId: activeTabs[agentId] || null };
}

async function handleOpenTab(agentId, payload) {
  const { url, label } = payload || {};
  const createProps = { active: false };
  if (url) createProps.url = url;
  const tab = await chrome.tabs.create(createProps);
  // Wait for the tab to settle
  await new Promise((r) => setTimeout(r, 200));
  // Bind it
  tabBindings[tab.id] = agentId;
  tabMeta[tab.id] = {
    label: label || defaultLabelFor(tab),
    url: tab.url || url || "",
    title: tab.title || "",
    boundAt: Date.now(),
  };
  // Set as active
  activeTabs[agentId] = tab.id;
  await saveBindings();
  await saveTabMeta();
  await saveActiveTabs();
  broadcastStatus();
  return {
    ok: true,
    tabId: tab.id,
    label: tabMeta[tab.id].label,
    url: tab.url,
  };
}

async function handleCloseTab(agentId, payload) {
  const { tabId } = payload || {};
  if (tabId === undefined) {
    return { ok: false, error: "browser_close_tab requires {tabId}" };
  }
  if (tabBindings[tabId] !== agentId) {
    return { ok: false, error: `Tab ${tabId} is not bound to agent "${agentId}"` };
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    return { ok: false, error: `close failed: ${err.message || err}` };
  }
  // The onRemoved listener will clean up the bindings
  return { ok: true, tabId };
}

async function handleRenameTab(agentId, payload) {
  const { tabId, label } = payload || {};
  if (tabId === undefined || !label) {
    return { ok: false, error: "browser_rename_tab requires {tabId, label}" };
  }
  if (tabBindings[tabId] !== agentId) {
    return { ok: false, error: `Tab ${tabId} is not bound to agent "${agentId}"` };
  }
  tabMeta[tabId] = { ...(tabMeta[tabId] || {}), label };
  await saveTabMeta();
  broadcastStatus();
  return { ok: true, tabId, label };
}

async function handleSetActiveTab(agentId, payload) {
  const { tabId } = payload || {};
  if (tabId === undefined) {
    return { ok: false, error: "browser_set_active_tab requires {tabId}" };
  }
  if (tabBindings[tabId] !== agentId) {
    return { ok: false, error: `Tab ${tabId} is not bound to agent "${agentId}"` };
  }
  activeTabs[agentId] = tabId;
  await saveActiveTabs();
  broadcastStatus();
  return { ok: true, tabId, label: tabMeta[tabId]?.label || null };
}

// ============================================================
//  WS request handler (the entry point for all agent tool calls)
// ============================================================

async function handleAgentRequest(agentId, method, payload) {
  // Management tools
  switch (method) {
    case "browser_list_tabs":
      return handleListTabs(agentId);
    case "browser_open_tab":
      return handleOpenTab(agentId, payload);
    case "browser_close_tab":
      return handleCloseTab(agentId, payload);
    case "browser_rename_tab":
      return handleRenameTab(agentId, payload);
    case "browser_set_active_tab":
      return handleSetActiveTab(agentId, payload);
  }
  // All other browser_* tools go through the content script
  return await executeTool(agentId, method, payload);
}

// ============================================================
//  Tab binding (popup UI)
// ============================================================

async function bindTab(tabId, agentId) {
  if (!agentMeta.has(agentId)) {
    throw new Error(`Unknown agent "${agentId}"`);
  }
  tabBindings[tabId] = agentId;
  // Set as active if it's the first tab for this agent
  const hasOther = Object.values(tabBindings).some((aid) => aid === agentId && Object.keys(tabBindings).filter((t) => tabBindings[t] === agentId).length > 0);
  if (!hasOther) {
    activeTabs[agentId] = tabId;
    await saveActiveTabs();
  }
  await recordTabInfo(tabId);
  await saveBindings();
  broadcastStatus();
}

async function unbindTab(tabId) {
  delete tabBindings[tabId];
  delete tabMeta[tabId];
  // Clear from activeTabs
  for (const [agentId, activeId] of Object.entries(activeTabs)) {
    if (activeId === tabId) delete activeTabs[agentId];
  }
  await saveBindings();
  await saveTabMeta();
  await saveActiveTabs();
  broadcastStatus();
}

// ============================================================
//  Status broadcast
// ============================================================

async function snapshotStatus() {
  const agents = [];
  for (const [id, meta] of agentMeta.entries()) {
    let boundTabs = 0;
    for (const aid of Object.values(tabBindings)) {
      if (aid === id) boundTabs++;
    }
    agents.push({
      id,
      url: meta.url,
      status: meta.status,
      lastError: meta.lastError,
      connectedAt: meta.connectedAt,
      boundTabs,
      activeTabId: activeTabs[id] || null,
    });
  }
  // Build per-agent tab list
  const tabsByAgent = {};
  for (const [tid, aid] of Object.entries(tabBindings)) {
    if (!tabsByAgent[aid]) tabsByAgent[aid] = [];
    tabsByAgent[aid].push({
      tabId: parseInt(tid, 10),
      label: tabMeta[tid]?.label || "tab",
      isActive: activeTabs[aid] === parseInt(tid, 10),
    });
  }
  return {
    agents,
    bindings: { ...tabBindings },
    tabsByAgent,
  };
}

async function broadcastStatus() {
  try {
    const snap = await snapshotStatus();
    chrome.runtime.sendMessage({ type: "status", payload: snap }).catch(() => {});
  } catch {
    // ignore
  }
}

// ============================================================
//  Reconnect on SW wake-up
// ============================================================

async function ensureConnected() {
  await loadAll();
  const { endpoints: stored = [] } = await chrome.storage.sync.get("endpoints");
  for (const e of stored) {
    if (!connections.has(e.id) || connections.get(e.id).readyState !== WebSocket.OPEN) {
      connectAgent(e);
    }
  }
  await broadcastStatus();
}

// ============================================================
//  Message router (from popups and content scripts)
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      await ensureConnected();

      switch (msg.type) {
        case "listAgents": {
          const snap = await snapshotStatus();
          sendResponse({ ok: true, ...snap });
          return;
        }
        case "addEndpoint": {
          const { endpoints: stored = [] } = await chrome.storage.sync.get("endpoints");
          if (stored.find((e) => e.id === msg.endpoint.id)) {
            sendResponse({ ok: false, error: "Agent ID already exists" });
            return;
          }
          stored.push(msg.endpoint);
          await chrome.storage.sync.set({ endpoints: stored });
          connectAgent(msg.endpoint);
          sendResponse({ ok: true });
          return;
        }
        case "removeEndpoint": {
          const { endpoints: stored = [] } = await chrome.storage.sync.get("endpoints");
          const remaining = stored.filter((e) => e.id !== msg.id);
          await chrome.storage.sync.set({ endpoints: remaining });
          disconnectAgent(msg.id);
          for (const [tid, aid] of Object.entries(tabBindings)) {
            if (aid === msg.id) delete tabBindings[tid];
          }
          for (const [aid, activeId] of Object.entries(activeTabs)) {
            if (aid === msg.id) delete activeTabs[aid];
          }
          await saveBindings();
          await saveActiveTabs();
          broadcastStatus();
          sendResponse({ ok: true });
          return;
        }
        case "bind": {
          await bindTab(msg.tabId, msg.agentId);
          sendResponse({ ok: true });
          return;
        }
        case "unbind": {
          await unbindTab(msg.tabId);
          sendResponse({ ok: true });
          return;
        }
        case "renameTab": {
          const meta = tabMeta[msg.tabId] || {};
          tabMeta[msg.tabId] = { ...meta, label: msg.label };
          await saveTabMeta();
          broadcastStatus();
          sendResponse({ ok: true });
          return;
        }
        case "setActiveTab": {
          if (msg.agentId) {
            activeTabs[msg.agentId] = msg.tabId;
            await saveActiveTabs();
            broadcastStatus();
          }
          sendResponse({ ok: true });
          return;
        }
        case "openTab": {
          // Open a new tab and bind it (popup UI can use this too)
          const createProps = { active: false };
          if (msg.url) createProps.url = msg.url;
          const tab = await chrome.tabs.create(createProps);
          await new Promise((r) => setTimeout(r, 200));
          tabBindings[tab.id] = msg.agentId;
          tabMeta[tab.id] = {
            label: msg.label || defaultLabelFor(tab),
            url: tab.url || msg.url || "",
            title: tab.title || "",
            boundAt: Date.now(),
          };
          activeTabs[msg.agentId] = tab.id;
          await saveBindings();
          await saveTabMeta();
          await saveActiveTabs();
          broadcastStatus();
          sendResponse({ ok: true, tabId: tab.id });
          return;
        }
        case "closeTab": {
          try {
            await chrome.tabs.remove(msg.tabId);
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err.message || err) });
          }
          return;
        }
        case "call": {
          // Tool call from a popup or content script (legacy path)
          const agentId = tabBindings[msg.tabId];
          if (!agentId) {
            sendResponse({ ok: false, error: "No agent bound to this tab. Use the extension popup to bind an agent." });
            return;
          }
          try {
            const result = await handleAgentRequest(agentId, msg.method, msg.params);
            sendResponse({ ok: true, result });
          } catch (err) {
            sendResponse({ ok: false, error: String(err.message || err) });
          }
          return;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true;
});

// ============================================================
//  Tab lifecycle — clean up bindings when tabs close
// ============================================================

chrome.tabs.onRemoved.addListener(async (tabId) => {
  let changed = false;
  if (tabBindings[tabId] !== undefined) {
    delete tabBindings[tabId];
    changed = true;
  }
  if (tabMeta[tabId] !== undefined) {
    delete tabMeta[tabId];
    changed = true;
  }
  for (const [agentId, activeId] of Object.entries(activeTabs)) {
    if (activeId === tabId) {
      delete activeTabs[agentId];
      changed = true;
    }
  }
  if (changed) {
    await saveBindings();
    await saveTabMeta();
    await saveActiveTabs();
    broadcastStatus();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, _change, tab) => {
  if (tabBindings[tabId] === undefined) return;
  if (!tabMeta[tabId]) tabMeta[tabId] = { boundAt: Date.now() };
  tabMeta[tabId].url = tab.url || tabMeta[tabId].url;
  tabMeta[tabId].title = tab.title || tabMeta[tabId].title;
  await saveTabMeta();
  broadcastStatus();
});

// ============================================================
//  WS request dispatcher — receives from MCP server over WS
// ============================================================

// This function is the entry point for all WS messages from the
// server. It's a thin wrapper around handleAgentRequest that runs
// it as a Promise so we can wait for the response.
async function dispatchAgentRequest(agentId, method, payload, requestId) {
  const ws = connections.get(agentId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { ok: false, error: "Agent not connected" };
  }
  try {
    const result = await handleAgentRequest(agentId, method, payload);
    ws.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId, result },
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId, error: String(err.message || err) },
    }));
  }
}

// Hook the dispatch into the WS message handler — we re-attach the
// listener (the original message handler in connectAgent does
// messageResponse correlation only). To avoid double-binding, we
// capture incoming messages via a separate listener.

// Modify connectAgent's message handler to also dispatch unknown
// message types as tool calls. The original code only handled
// messageResponse; we need to extend it.

// Note: this re-declares a listener; the original is in connectAgent
// above. We dispatch from a SECOND listener to keep things simple.

chrome.runtime.onMessage.addListener((msg) => {
  // Listen for tool-call dispatches routed through runtime messages
  // (used as a side-channel when chrome.tabs can't reach the SW
  // directly). This is currently a no-op placeholder.
});

self.addEventListener("message", (event) => {
  // Listen for postMessage from the devtools or other SW contexts
});

// ============================================================
//  Lifecycle hooks
// ============================================================

self.addEventListener("activate", () => {
  ensureConnected();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureConnected();
});

chrome.runtime.onStartup.addListener(() => {
  ensureConnected();
});
