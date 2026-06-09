/**
 * Better Browser MCP — popup UI (v0.2.0 — multi-tab)
 *
 * Renders:
 *   - Configured agents (with connection status, bound tab count)
 *   - Add-agent form
 *   - Per-tab binding picker
 *   - Bound tabs list for the agent that owns the current tab, with
 *     rename + set-active controls
 */

const els = {
  agents: document.getElementById("agents"),
  thisTab: document.getElementById("this-tab"),
  addId: document.getElementById("add-id"),
  addPort: document.getElementById("add-port"),
  addUrl: document.getElementById("add-url"),
  addToken: document.getElementById("add-token"),
  addSubmit: document.getElementById("add-submit"),
  agentTabs: document.getElementById("agent-tabs"),
  agentTabsHeader: document.getElementById("agent-tabs-header"),
};

let currentTabId = null;
let currentSnapshot = { agents: [], bindings: {}, tabsByAgent: {} };

// ============================================================
//  Helpers
// ============================================================

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => resolve(response));
  });
}

function defaultUrlFromInputs() {
  const port = els.addPort.value.trim();
  const explicit = els.addUrl.value.trim();
  if (explicit) return explicit;
  if (!port) return null;
  return `ws://127.0.0.1:${port}/ws/${encodeURIComponent(els.addId.value.trim()) || "default"}`;
}

function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status ${status}`;
  span.textContent = status;
  return span;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ============================================================
//  Rendering
// ============================================================

function renderAgents() {
  els.agents.innerHTML = "";
  if (currentSnapshot.agents.length === 0) {
    els.agents.appendChild(el("div", { class: "empty", text: "No agents configured. Add one below." }));
    return;
  }
  for (const a of currentSnapshot.agents) {
    const card = el("div", { class: `agent ${a.status}` });
    const head = el("div", { class: "agent-head" },
      el("div", {},
        el("div", { class: "agent-id", text: a.id }),
        el("div", { class: "agent-url", text: a.url }),
      ),
      statusBadge(a.status),
    );
    const meta = el("div", { class: "agent-meta" });
    if (a.lastError) meta.appendChild(el("div", { text: `Error: ${a.lastError}` }));
    if (a.connectedAt) {
      const ago = Math.round((Date.now() - a.connectedAt) / 1000);
      meta.appendChild(el("div", { text: `Connected ${ago}s ago` }));
    }
    meta.appendChild(el("div", { class: "bindings", text: `${a.boundTabs} tab${a.boundTabs === 1 ? "" : "s"} bound` }));

    const removeBtn = el("button", { class: "danger", text: "Remove", onclick: async () => {
      if (!confirm(`Remove agent "${a.id}"? Tabs bound to it will be unbound.`)) return;
      await sendMessage({ type: "removeEndpoint", id: a.id });
      await refresh();
    } });
    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(removeBtn);
    els.agents.appendChild(card);
  }
}

function renderThisTab() {
  els.thisTab.innerHTML = "";
  if (currentTabId === null) {
    els.thisTab.appendChild(el("div", { class: "empty", text: "No active tab." }));
    els.agentTabsHeader.style.display = "none";
    els.agentTabs.innerHTML = "";
    return;
  }
  const boundAgentId = currentSnapshot.bindings[currentTabId];
  const connectedAgents = currentSnapshot.agents.filter((a) => a.status === "connected");

  if (boundAgentId) {
    const agent = currentSnapshot.agents.find((a) => a.id === boundAgentId);
    if (agent) {
      const card = el("div", { class: `agent ${agent.status}` },
        el("div", { class: "agent-head" },
          el("div", {},
            el("div", { class: "agent-id", text: `Bound to: ${agent.id}` }),
            el("div", { class: "agent-url", text: agent.url }),
          ),
          statusBadge(agent.status),
        ),
        el("button", { class: "danger", text: "Unbind this tab", onclick: async () => {
          await sendMessage({ type: "unbind", tabId: currentTabId });
          await refresh();
        } }),
      );
      els.thisTab.appendChild(card);
    } else {
      els.thisTab.appendChild(el("div", { class: "empty", text: `Bound to "${boundAgentId}" but that agent is no longer configured.` }));
    }
  } else if (connectedAgents.length === 0) {
    els.thisTab.appendChild(el("div", { class: "empty", text: "No connected agents. Add one and wait for it to connect." }));
  } else {
    const card = el("div", { class: "agent" },
      el("div", { class: "agent-head" },
        el("div", { class: "agent-id", text: "Not bound — pick an agent:" }),
      ),
    );
    for (const a of connectedAgents) {
      card.appendChild(el("button", { text: `Bind to ${a.id}`, onclick: async () => {
        await sendMessage({ type: "bind", tabId: currentTabId, agentId: a.id });
        await refresh();
      } }));
    }
    els.thisTab.appendChild(card);
  }

  // Render the agent's bound tabs list
  renderAgentTabs(boundAgentId);
}

function renderAgentTabs(agentId) {
  els.agentTabs.innerHTML = "";
  if (!agentId) {
    els.agentTabsHeader.style.display = "none";
    return;
  }
  const tabs = currentSnapshot.tabsByAgent[agentId] || [];
  if (tabs.length === 0) {
    els.agentTabsHeader.style.display = "none";
    return;
  }
  els.agentTabsHeader.style.display = "";
  els.agentTabsHeader.textContent = `Agent "${agentId}" — bound tabs`;
  for (const t of tabs) {
    const row = el("div", { class: `tab-row${t.isActive ? " active" : ""}` });
    const labelInput = el("input", {
      class: "tab-label-input",
      type: "text",
      value: t.label,
    });
    labelInput.addEventListener("change", async () => {
      const newLabel = labelInput.value.trim() || "tab";
      await sendMessage({ type: "renameTab", tabId: t.tabId, label: newLabel });
      await refresh();
    });
    labelInput.addEventListener("click", (e) => e.stopPropagation());
    const labelCell = el("div", { class: "tab-label" }, labelInput);
    row.appendChild(labelCell);

    if (!t.isActive) {
      const activateBtn = el("button", { class: "ghost", text: "Set active", onclick: async (e) => {
        e.stopPropagation();
        await sendMessage({ type: "setActiveTab", agentId, tabId: t.tabId });
        await refresh();
      } });
      row.appendChild(activateBtn);
    } else {
      row.appendChild(el("span", { class: "tab-meta", text: "active" }));
    }

    const unbindBtn = el("button", { class: "danger", text: "Unbind", onclick: async (e) => {
      e.stopPropagation();
      await sendMessage({ type: "unbind", tabId: t.tabId });
      await refresh();
    } });
    row.appendChild(unbindBtn);

    els.agentTabs.appendChild(row);
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab ? tab.id : null;
  const status = await sendMessage({ type: "listAgents" });
  if (status?.ok) {
    currentSnapshot = {
      agents: status.agents,
      bindings: status.bindings,
      tabsByAgent: status.tabsByAgent || {},
    };
  } else {
    currentSnapshot = { agents: [], bindings: {}, tabsByAgent: {} };
  }
  renderAgents();
  renderThisTab();
}

// ============================================================
//  Event wiring
// ============================================================

els.addSubmit.addEventListener("click", async () => {
  const id = els.addId.value.trim();
  if (!id) {
    alert("Agent ID is required");
    return;
  }
  const url = defaultUrlFromInputs();
  if (!url) {
    alert("Either port or full ws:// URL is required");
    return;
  }
  const token = els.addToken.value.trim();
  const res = await sendMessage({
    type: "addEndpoint",
    endpoint: { id, url, token: token || null },
  });
  if (!res?.ok) {
    alert(`Failed to add: ${res?.error || "unknown error"}`);
    return;
  }
  els.addId.value = "";
  els.addPort.value = "";
  els.addUrl.value = "";
  els.addToken.value = "";
  await refresh();
});

els.addId.addEventListener("input", () => {
  if (!els.addUrl.value) {
    const port = els.addPort.value.trim();
    if (port && els.addId.value.trim()) {
      els.addUrl.value = `ws://127.0.0.1:${port}/ws/${encodeURIComponent(els.addId.value.trim())}`;
    }
  }
});
els.addPort.addEventListener("input", () => {
  const port = els.addPort.value.trim();
  if (port && els.addId.value.trim()) {
    els.addUrl.value = `ws://127.0.0.1:${port}/ws/${encodeURIComponent(els.addId.value.trim())}`;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "status") {
    currentSnapshot = {
      agents: msg.payload.agents,
      bindings: msg.payload.bindings,
      tabsByAgent: msg.payload.tabsByAgent || {},
    };
    renderAgents();
    renderThisTab();
  }
});

refresh();
