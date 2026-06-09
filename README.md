# Better Browser MCP — Chrome Extension

Multi-agent browser automation extension. Forks `@browsermcp` with two key changes:

1. **Configurable WebSocket endpoints** — instead of a hard-coded `ws://localhost:9009`, the popup lets you add/remove WS endpoints to monitor. Each is identified by an agent ID (e.g. `hermes`, `omp`, `codex`).

2. **Per-tab agent binding** — when you click the extension icon on a tab, you see a list of currently-connected agents. Picking one binds that tab to the agent. The binding persists for the tab until changed, the WebSocket disconnects, or the tab is closed. Other tabs can be bound to different agents.

## How it works

```
+-----------------+     +-------------------+     +-----------------+
|  Hermes MCP     |     | Better Browser    |     |  Brave tabs     |
|  port 9009      |<--->| MCP extension     |<--->|  - Stripe tab   |
|  /ws/hermes     | WS  |  (this repo)      |     |  - Slack tab    |
+-----------------+     |  service worker   |     |  - etc.         |
                        |                   |     +-----------------+
+-----------------+     |  - Map<agent, WS> |             ^   ^
|  OMP MCP        |     |  - Map<tab,   -->|             |   | (tab bindings
|  port 9010      |<--->|     agent>       |             |   |  persist via
|  /ws/omp        | WS  |                   |             |   |  chrome.storage)
+-----------------+     |  Popup UI:        |             |   |
                        |  - list agents   |             |   |
                        |  - add/remove    |             |   |
                        |  - bind tab to   |-------------+   |
                        |    agent         |                 |
                        +-------------------+                 |
                                                              |
                              (per-tab binding to specific agent)
```

The extension doesn't know about MCP servers directly — it just maintains WebSocket connections to whatever endpoints you configure. The MCP server side (see `nbiish/betterbrowsermcp`) is responsible for serving the WS endpoint at `/ws/<agent-id>` and handling tool routing.

## Installation

### From source (developer mode)

1. Clone this repo
2. Open `chrome://extensions` (or `brave://extensions`)
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the repo directory
5. The Better Browser MCP icon appears in your toolbar

### From Chrome Web Store

_(Coming soon — package and submit after testing)_

## Configuration

After installation, click the extension icon. The popup has two sections:

### Add an agent

For each MCP process you started (e.g. one per AI agent), add an entry here:

- **Agent ID** — any string, e.g. `hermes`, `omp`, `codex`
- **Port** — the port the MCP process is bound to (default 9009 for the first agent)
- **Full URL** (optional) — overrides the port; e.g. `ws://127.0.0.1:9010/ws/omp`
- **Auth token** (optional) — the value of `BROWSER_MCP_AUTH_TOKEN` for that server

The auto-fill builds the URL as `ws://127.0.0.1:<port>/ws/<agent-id>`. The agent ID becomes the WS path segment.

### Bind a tab to an agent

Open a browser tab, click the extension icon, and pick an agent from the **This tab** section. The binding persists in `chrome.storage.local` keyed by tab ID. Close the tab → binding is auto-removed. Restart the browser → bindings are cleared (you re-bind on next use).

## Storage layout

```js
// chrome.storage.sync — synced across devices (if user has sync enabled)
{
  "endpoints": [
    { "id": "hermes", "url": "ws://127.0.0.1:9009/ws/hermes", "token": null },
    { "id": "omp",    "url": "ws://127.0.0.1:9010/ws/omp",    "token": null }
  ]
}

// chrome.storage.local — per-device
{
  "bindings": {
    "12345": "hermes",  // tab 12345 is bound to agent "hermes"
    "67890": "omp"      // tab 67890 is bound to agent "omp"
  }
}
```

## Protocol

The extension speaks the same WebSocket protocol as `@browsermcp/mcp`. Each connected agent's MCP server uses these messages:

| Direction | Type | Purpose |
|---|---|---|
| server → ext | `auth` (response) | (none — this is a request from ext) |
| ext → server | `auth` | `{type:"auth", token:"..."}` if `BROWSER_MCP_AUTH_TOKEN` is set |
| ext → server | tool method | `{id, type:"browser_navigate", payload:{url}}` etc. |
| server → ext | `messageResponse` | `{type:"messageResponse", payload:{requestId, result\|error}}` |
| server → ext | `ping` | keepalive (every 25s) |
| ext → server | `selectTab` | `{type:"selectTab", payload:{tabId}}` — sets browser focus to the bound tab |

## Comparison with `@browsermcp` extension

| | `@browsermcp` | `@betterbrowsermcp` |
|---|---|---|
| WS endpoint | Hard-coded `ws://localhost:9009` | User-configured list, any number |
| Agent ID | None | First-class, used in WS path |
| Multi-agent | No (one process fights for the port) | Yes — N processes, N endpoints, all coexist |
| Per-tab binding | N/A (single tab at a time) | Per-tab, persistent until changed |
| Auth | None | Optional shared-secret token per agent |
| Port-murder behavior | Yes (extension inherits upstream server's `killProcessOnPort`) | Removed — extension doesn't care about ports |
| UI complexity | "Connected" / "Not connected" badge | Agent list + tab binding picker + endpoint management |

## Development

No build step — the source is plain ESM JavaScript that Chrome loads directly. Just edit the files in `manifest.json`, `background.js`, `popup.html`, `popup.js` and reload the extension via `chrome://extensions`.

For testing the message flow without a real MCP server, you can spin up a minimal WebSocket server:

```bash
# Install wscat (or use python's websockets library)
python3 -c "
import asyncio, websockets
async def echo(ws):
    async for msg in ws:
        print('RECV', msg)
        import json
        m = json.loads(msg)
        await ws.send(json.dumps({
            'type': 'messageResponse',
            'payload': {'requestId': m['id'].replace('req-', ''), 'result': 'ok'}
        }))
async def main():
    async with websockets.serve(echo, '127.0.0.1', 9099):
        await asyncio.Future()
asyncio.run(main())
"
```

Then add `ws://127.0.0.1:9099/ws/test` as an endpoint in the extension popup.

## Limitations

- **Tab binding doesn't survive browser restart** — we clear bindings on startup so stale tab IDs don't accumulate. You re-bind on next use.
- **No popup action on browser-action click** — clicking the icon opens the popup, but the popup only shows status, doesn't auto-bind. The user explicitly picks.
- **WebSocket auth is per-agent** — the same token is sent on every reconnect.
- **No content script for in-page ARIA yet** — the upstream extension has sophisticated ARIA-snapshot logic in a content script. This initial version focuses on the multi-agent routing; ARIA snapshots can be added via `chrome.scripting.executeScript` from the background when needed.

## Credits

Forked from the bundled `@browsermcp` Chrome extension (v1.3.4 from Chrome Web Store). Reimplemented with the multi-agent routing design needed for the Hermes + OMP + Codex multi-agent workflow. By [Nbiish](https://github.com/nbiish).
