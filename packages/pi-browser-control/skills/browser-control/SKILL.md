---
name: browser-control
description: "Use when listing, reading, exporting, or closing the user's open Firefox browser tabs via the pi-browser-control extension. Triggers on: list firefox tabs, what tabs are open, find a browser tab, my open tabs, which tab has X open, browser_control, pi-browser-control, what is the user browsing, show me open tabs, find a URL in open tabs, read a tab, get tab content, export tabs, close a tab, close tab, close browser tab."
---

# Browser Control

Use this skill when the user asks what tabs are open in Firefox, wants
to find or read a specific tab by URL or title, needs to export tab
metadata, or wants to close a tab.

Firefox only (Chrome/Safari not supported). Cannot open, navigate, or
reorder tabs.

## Tool: `browser_control` — operation: `list_tabs`

**Registered and active immediately** — no `manage_tools` activation step
needed. Call it directly.

```
browser_control({ "operation": "list_tabs", "offset": 0, "limit": 100 })
```

Returns an array of open tabs. Each entry has:

| Field | Type | Description |
|---|---|---|
| `id` | number | Numeric tab ID (use with `get_tab_content` or `close_tab`) |
| `url` | string | Full URL of the tab |
| `title` | string | Page title |
| `lastAccessed` | number | Unix ms timestamp of last access |
| `normalizedUrl` | string \| null | Canonicalized URL (fragment stripped, params sorted) |

`limit` defaults to 100 and is **capped at 500** per call. Use `offset`
to page through more than 500 tabs.

## Tool: `browser_control` — operation: `get_tab_content`

Reads the full text content and links of a tab by its numeric ID.

```
browser_control({ "operation": "get_tab_content", "tabId": 42, "offset": 0 })
```

- `tabId` — obtained from `list_tabs`.
- `offset` — character offset for paginating large documents (pass `0` for the first read).
- Links (`[{ text, url }]`) are only included in the first call (`offset=0`).
- If the content is truncated, increment `offset` by the returned text length and call again.

## Tool: `browser_control` — operation: `export_tabs`

Exports all open tab metadata to a JSON Lines file. Each line is one
tab object with 19 fields. Private-browsing tabs are excluded.

```
browser_control({ "operation": "export_tabs", "path": "/absolute/path/to/tabs.jsonl" })
```

- `path` must be an absolute path (starts with `/`).
- The file is created or overwritten.

## Tool: `browser_control` — operation: `close_tab`

Closes a single tab by its numeric ID.

```
browser_control({ "operation": "close_tab", "tabId": 42 })
```

- `tabId` — obtained from `list_tabs`.
- **Edge case**: closing the last tab of the last Firefox window will close
  Firefox entirely, destroying the native-messaging port before the reply
  can be sent. The caller will receive a timeout error in that case.

## `/browser-control` slash command

A user-facing management menu with four items:

| Item | What it does |
|---|---|
| **Status** | Shows daemon PID, uptime, version, and whether the add-on is connected |
| **Test connection** | Pings the daemon and reports how many tabs are visible |
| **Install Firefox native-messaging manifest** | Writes the NM manifest + launcher script to disk |
| **Build & install XPI (permanent add-on)** | Runs `web-ext build` on the `firefox-addon/` directory and produces a signed-free `.xpi` file for permanent installation |

**`/browser-control` does NOT start the daemon.** See prerequisites below.

## Prerequisites — how the daemon actually starts

The architecture is:

```
Firefox add-on ──native messaging──▶ Node daemon (spawned by Firefox)
                                         │ unix socket
pi session ────────────────────────── ~/.pi/agent/pi-browser-control.sock
```

**The daemon is spawned and owned by Firefox** when Firefox loads the
add-on — not by `/browser-control` or any pi command.

One-time setup the user must complete:

1. **Install the manifest once** — run `/browser-control → Install Firefox
   native-messaging manifest` (or, from the repo root,
   `node packages/pi-browser-control/scripts/install.ts`). This writes the
   NM manifest + launcher; only needed once per machine. (The manifest
   installer currently targets macOS — it writes to
   `~/Library/Application Support/Mozilla/NativeMessagingHosts/`.) After
   installing, **restart Firefox** so it picks up the new manifest.
2. **Load the add-on in Firefox** — open `about:debugging`, click
   *Load Temporary Add-on*, and select
   `packages/pi-browser-control/firefox-addon/manifest.json`. Firefox then
   spawns the daemon automatically.
3. **Verify** — run `/browser-control → Test connection` or call
   `browser_control` with `operation: "list_tabs"` directly.

If the user has previously completed setup, `browser_control` should
just work as long as Firefox is open with the add-on running.

### Permanent installation (survives Firefox restarts)

Temporarily-loaded add-ons (step 2 above) are removed when Firefox closes.
To install permanently:

1. Run `/browser-control → Build & install XPI (permanent add-on)`. This
   runs `web-ext build` and reports the path to the generated `.xpi` file.
2. In Firefox, open `about:config` and set
   `xpinstall.signatures.required = false` (required for unsigned local
   builds).
3. Open `about:addons` → gear icon → *Install Add-on From File* → select
   the `.xpi` reported in step 1.
4. The add-on will now survive Firefox restarts; the manifest only needs
   to be (re-)installed once.

## Error recovery

| Error code | Meaning | What to do |
|---|---|---|
| `DAEMON_NOT_RUNNING` | Firefox is not open or the add-on is not loaded | Ask the user to open Firefox and load the add-on via `about:debugging`. Do NOT claim that `/browser-control` starts the daemon. |
| `ADDON_NOT_CONNECTED` | Daemon is running but the add-on lost its NM connection | Ask the user to reload the add-on in `about:debugging → Reload`. |
| `TAB_NOT_FOUND` | Stale tab ID (tab was closed) | Re-run `browser_control` with `operation: "list_tabs"` to get fresh IDs. |
| `TAB_DISCARDED` | Firefox unloaded the tab to save memory | Ask the user to click the tab in Firefox to reload it, then retry with `operation: "get_tab_content"`. |
| `EXTRACTION_TIMEOUT` | Page never settled (streaming / SPA) | Try a different tab or ask the user to let the page finish loading, then retry `operation: "get_tab_content"`. |
| `TAB_PROTECTED` | Privileged page (`about:`, `moz-extension:`) | Choose a normal web-content tab. |

## Typical workflow

```
browser_control({ "operation": "list_tabs", "offset": 0, "limit": 100 })
```

Scan the returned list for the tab the user is asking about. If there
are more than 100 tabs and you did not find a match, increment `offset`
by 100 and repeat until `offset` ≥ total returned count.

To read a tab's content once you have its ID:

```
browser_control({ "operation": "get_tab_content", "tabId": 42, "offset": 0 })
```

To export all tabs to a file:

```
browser_control({ "operation": "export_tabs", "path": "/tmp/tabs.jsonl" })
```

To close a tab:

```
browser_control({ "operation": "close_tab", "tabId": 42 })
```

## Limitations

- **Cannot open, navigate, focus, or reorder tabs.**
- **Firefox only.** No Chrome, Safari, or other browsers.
- **Local machine only.** The unix socket path
  `~/.pi/agent/pi-browser-control.sock` is on the same host as the pi
  session; remote or SSH sessions cannot reach a local Firefox instance.
