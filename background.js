/**
 * Better Browser MCP — service worker
 *
 * Manages N WebSocket connections (one per configured agent) and
 * routes messages between them and browser tabs based on per-tab
 * agent bindings.
 *
 * Architecture:
 *   - chrome.storage.sync["endpoints"]: list of {id, url, token?}
 *     WebSocket endpoints to maintain connections to
 *   - chrome.storage.local["bindings"]: { tabId: agentId } map of
 *     which tab is bound to which agent
 *   - agentConnections: Map<agentId, WebSocket> in-memory connection
 *     pool, rebuilt from storage on startup
 *   - messageId: monotonically increasing id for request/response
 *     correlation across all WS connections
 *
 * Message flow:
 *   Popup (UI):
 *     - chrome.runtime.sendMessage({type: "listAgents"}) → list of
 *       {id, url, status: "connected"|"disconnected", boundTabs: N}
 *     - chrome.runtime.sendMessage({type: "bind", tabId, agentId}) →
 *       sets the binding, sends a "selectTab" message to the WS to
 *       tell the extension which tab to control
 *
 *   Tool call (from a tab, via the popup or page action):
 *     - chrome.runtime.sendMessage({type: "call", tabId, method, params})
 *     - Worker looks up binding[tabId] = agentId, sends to that WS,
 *       returns the response
 *
 *   Page-driven tool calls (e.g. console logs, snapshots):
 *     - Content script sends via chrome.runtime.sendMessage
 *     - Worker routes to bound agent's WS
 */

// ============================================================
//  Constants
// ============================================================

const WS_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const WS_REQUEST_TIMEOUT_MS = 30000;

// ============================================================
//  In-memory state
// ============================================================

/** agentId -> WebSocket */
const connections = new Map();
/** agentId -> { url, token?, status, lastError?, connectedAt? } */
const agentMeta = new Map();
/** tabId -> agentId */
let tabBindings = {};
/** requestId -> { resolve, reject, agentId, method, startedAt } */
const pendingRequests = new Map();
/** monotonically increasing id for outgoing requests */
let nextRequestId = 1;

// ============================================================
//  Storage helpers
// ============================================================

async function loadEndpoints() {
  const { endpoints = [] } = await chrome.storage.sync.get("endpoints");
  return endpoints;
}

async function loadBindings() {
  const { bindings = {} } = await chrome.storage.local.get("bindings");
  return bindings;
}

async function saveBindings() {
  await chrome.storage.local.set({ bindings: tabBindings });
}

// ============================================================
//  WebSocket lifecycle
// ============================================================

function connectAgent(endpoint) {
  const { id, url, token } = endpoint;
  // Disconnect any existing connection for this agent
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
  let authSent = false;
  let pingTimer = null;

  function scheduleReconnect() {
    if (connections.get(id) !== ws) return; // replaced; don't reconnect the old one
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
    // Send auth handshake if a token is configured
    if (token) {
      authSent = true;
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
      const pending = pendingRequests.get(msg.payload?.requestId);
      if (pending) {
        pendingRequests.delete(msg.payload.requestId);
        if (msg.payload.error) {
          pending.reject(new Error(msg.payload.error));
        } else {
          pending.resolve(msg.payload.result);
        }
      }
    }
    // Other message types (browser events) could be handled here
  });

  ws.addEventListener("close", (event) => {
    stopPing();
    if (connections.get(id) === ws) {
      connections.delete(id);
      meta.status = "disconnected";
      meta.lastError = `Connection closed (code=${event.code}, reason=${event.reason || "none"})`;
      broadcastStatus();
      scheduleReconnect();
    }
  });

  ws.addEventListener("error", (event) => {
    meta.lastError = "WebSocket error";
    // close event will fire after, which handles reconnect
  });

  connections.set(id, ws);
  meta.status = "connecting";
  broadcastStatus();
}

function disconnectAgent(id) {
  const ws = connections.get(id);
  if (ws) {
    // Mark the connection as replaced so its close handler doesn't
    // reschedule a reconnect
    connections.delete(id);
    try {
      ws.close(1000, "replaced");
    } catch {
      // ignore
    }
  }
  const meta = agentMeta.get(id);
  if (meta) {
    meta.status = "disconnected";
  }
}

// ============================================================
//  Outgoing requests
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
//  Tab binding (the per-tab agent picker)
// ============================================================

async function bindTab(tabId, agentId) {
  if (!agentMeta.has(agentId)) {
    throw new Error(`Unknown agent "${agentId}"`);
  }
  tabBindings[tabId] = agentId;
  await saveBindings();
  // Tell the MCP server that the agent's WS should focus this tab.
  // The MCP server forwards this to the extension via a "selectTab"
  // message, which the extension handles by setting focus to the
  // bound tab in the browser. This keeps the browser-side state in
  // sync with the server-side view.
  try {
    await callAgent(agentId, "selectTab", { tabId });
  } catch {
    // The server may not support selectTab yet — that's fine, the
    // binding is still recorded locally.
  }
  broadcastStatus();
}

async function unbindTab(tabId) {
  delete tabBindings[tabId];
  await saveBindings();
  broadcastStatus();
}

async function rebindAllAfterRestart() {
  // After a browser restart, tabIds from the previous session are
  // stale. We clear the bindings — the user re-binds when they need.
  tabBindings = {};
  await saveBindings();
}

// ============================================================
//  Status broadcast to popups
// ============================================================

function snapshotStatus() {
  const agents = [];
  for (const [id, meta] of agentMeta.entries()) {
    let boundTabs = 0;
    for (const tid of Object.keys(tabBindings)) {
      if (tabBindings[tid] === id) boundTabs++;
    }
    agents.push({
      id,
      url: meta.url,
      status: meta.status,
      lastError: meta.lastError,
      connectedAt: meta.connectedAt,
      boundTabs,
    });
  }
  return {
    agents,
    bindings: { ...tabBindings },
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: "status", payload: snapshotStatus() }).catch(() => {
    // Popup may not be open; that's fine
  });
}

// ============================================================
//  Message router (from popups and content scripts)
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "listAgents": {
          sendResponse({ ok: true, ...snapshotStatus() });
          return;
        }
        case "addEndpoint": {
          const endpoints = await loadEndpoints();
          if (endpoints.find((e) => e.id === msg.endpoint.id)) {
            sendResponse({ ok: false, error: "Agent ID already exists" });
            return;
          }
          endpoints.push(msg.endpoint);
          await chrome.storage.sync.set({ endpoints });
          connectAgent(msg.endpoint);
          sendResponse({ ok: true });
          return;
        }
        case "removeEndpoint": {
          const endpoints = await loadEndpoints();
          const remaining = endpoints.filter((e) => e.id !== msg.id);
          await chrome.storage.sync.set({ endpoints: remaining });
          disconnectAgent(msg.id);
          // Unbind any tabs that were bound to this agent
          for (const [tid, aid] of Object.entries(tabBindings)) {
            if (aid === msg.id) delete tabBindings[tid];
          }
          await saveBindings();
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
        case "call": {
          // Tool call from a popup or content script
          const agentId = tabBindings[msg.tabId];
          if (!agentId) {
            sendResponse({ ok: false, error: "No agent bound to this tab. Use the extension popup to bind an agent." });
            return;
          }
          try {
            const result = await callAgent(agentId, msg.method, msg.params);
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
  return true; // keep the message channel open for async response
});

// ============================================================
//  Tab lifecycle — clean up bindings when tabs close
// ============================================================

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabBindings[tabId] !== undefined) {
    delete tabBindings[tabId];
    await saveBindings();
    broadcastStatus();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await rebindAllAfterRestart();
  const endpoints = await loadEndpoints();
  for (const e of endpoints) connectAgent(e);
});

chrome.runtime.onInstalled.addListener(async () => {
  await rebindAllAfterRestart();
  const endpoints = await loadEndpoints();
  for (const e of endpoints) connectAgent(e);
});

// Reconnect all agents on service worker wake-up (MV3 SW can be torn
// down at any time; we need to re-establish connections on next event)
self.addEventListener("activate", async () => {
  const endpoints = await loadEndpoints();
  for (const e of endpoints) {
    if (!connections.has(e.id) || connections.get(e.id).readyState !== WebSocket.OPEN) {
      connectAgent(e);
    }
  }
});
