# TASK.2026-06-09 — multi-tab tool execution

## Problem
Multiple tabs can be bound to one agent, but:
1. The extension has NO content script, so browser_navigate / browser_click
   etc. don't actually do anything on the page
2. Even if they did, no way to specify WHICH tab a tool call should act on

## Protocol (MCP server -> extension WebSocket)

Modified tool calls (add optional tabId):
  - browser_navigate     payload: url, tabId OPTIONAL
  - browser_click        payload: element, ref, tabId OPTIONAL
  - browser_type         payload: element, ref, text, submit, tabId OPTIONAL
  - browser_snapshot     payload: tabId OPTIONAL
  - browser_screenshot   payload: tabId OPTIONAL
  - browser_press_key    payload: key, tabId OPTIONAL
  - browser_hover        payload: element, ref, tabId OPTIONAL
  - browser_select_option payload: element, ref, values, tabId OPTIONAL
  - browser_go_back      payload: tabId OPTIONAL
  - browser_go_forward   payload: tabId OPTIONAL
  - browser_get_console_logs payload: tabId OPTIONAL

New management tools:
  - browser_list_tabs      response: tabs: list of tabId, label, url, title, isActive
  - browser_open_tab       payload: url OPTIONAL, label OPTIONAL
  - browser_close_tab      payload: tabId
  - browser_rename_tab     payload: tabId, label
  - browser_set_active_tab payload: tabId

## Storage
- chrome.storage.local["tabMeta"] = {tabId: {label, url, agentId, boundAt}}
- chrome.storage.local["activeTabs"] = {agentId: tabId}

## Tab routing rule
- If tool call has tabId, route to that tab's content script
- If no tabId, route to the agent's active tab
- If no active tab, error: "No active tab. Call browser_set_active_tab first."

## Files to modify
- background.js: content script injection, message routing by tabId,
                 new handlers for list/open/close/rename/setActive
- content.js: NEW — handles DOM operations for browser_* tool calls
- manifest.json: add content_scripts
- popup.html + popup.js: show labels, let user rename, show active tab
- README.md: document the multi-tab workflow
