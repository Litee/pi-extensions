# pi-browser-control

Pi extension that registers two read-only tools for inspecting the user's
Firefox browser via the
[browser-control-mcp](https://github.com/eyalzh/browser-control-mcp) WebSocket
add-on. Only read-only tools are exposed for safety. Includes a `/browser-control`
management command for setting configuration interactively.

## Tools

| Tool | Operation | Description |
|---|---|---|
| `browser_control` | `list_tabs` | Lists all open browser tabs with IDs, URLs, titles, and last-accessed times. Supports `offset`/`limit` pagination (limit capped to 500). |
| `browser_control` | `export_tabs` | Exports all tab metadata to a JSON Lines file at the given absolute path. Excludes private-browsing tabs. |
| `browser_control` | `get_tab_content` | Returns the full text content and links of a tab by ID. Supports `offset` pagination for large documents. Links are only included in the first call (`offset=0`). |
| `browser_control` | `close_tab` | Closes a single tab by its numeric ID. |

## Setup

### 1. Use a Firefox version that allows unsigned add-ons

Standard Firefox does not allow unsigned add-ons. You need one of:

- **Firefox ESR** — disable signing via `about:config` → `xpinstall.signatures.required = false`
- **Firefox Developer Edition** — same `about:config` toggle
- **Firefox Nightly** — same `about:config` toggle

Unbranded Firefox builds also work but are primarily intended for developers.

### 2. Install the Firefox browser-control add-on

Install the [browser-control Firefox extension](https://github.com/eyalzh/browser-control-mcp)
from the upstream repository. The add-on listens on a local WebSocket port and
relays tab data to any connected MCP/WebSocket client.

### 3. Configure with `/browser-control` (recommended)

The easiest way to configure is via the interactive command. In pi, type:

```
/browser-control
```

This opens a menu with three options:

| Menu item | What it does |
|---|---|
| **Set secret** | Enter the shared secret from the add-on's options page. Stored in `~/.pi/agent/pi-browser-control.json`. Never displayed after saving. |
| **Set port** | Set a custom port (default: 8089). Shows the current value; leave blank to keep it. |
| **Test connection** | Applies the saved config to environment and tries connecting. Reports how many tabs are visible. |

Config is stored at `~/.pi/agent/pi-browser-control.json` and persists across
pi sessions.

### 4. (Alternative) Set environment variables

You can also configure via environment variables before starting pi. These
take precedence over the saved config file:

```bash
export EXTENSION_SECRET="your-secret-here"
export EXTENSION_PORT=9000   # optional, default 8089
```

The `EXTENSION_SECRET` value must match the secret on the add-on's options page.

### 5. Start pi

With Firefox open and the add-on running, start pi. The first call to either
tool will start the local WebSocket server and wait for the Firefox add-on to
connect.

## Usage notes

- Both tools are **read-only** — they cannot open, close, reorder, or modify
  browser tabs. This is intentional.
- The WebSocket server is started **lazily** on first use, so sessions start
  instantly even without a secret configured.
- If init fails (missing secret, port in use), the tool returns a descriptive
  error rather than crashing the session. Subsequent calls will retry init.
- After setting a new secret or port via `/browser-control → Test connection`,
  the extension resets the API instance to pick up the updated values.
- Tab content is retrieved from the currently-loaded DOM via the add-on. Content
  from tabs that require special permissions or are loading may be incomplete.

## Vendored code

The WebSocket client (`BrowserAPI`) is vendored from
[`eyalzh/browser-control-mcp`](https://github.com/eyalzh/browser-control-mcp)
at commit `ae0d0d3`. See [UPSTREAM.md](./UPSTREAM.md) for the full provenance
and a recipe to check for upstream changes.
