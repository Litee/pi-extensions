---
name: browser-control
description: "Use when listing or finding the user's open Firefox browser tabs via the pi-browser-control extension. Triggers on: list firefox tabs, what tabs are open, find a browser tab, my open tabs, which tab has X open, browser_list_tabs, pi-browser-control, what is the user browsing, show me open tabs, find a URL in open tabs."
---

# Browser Control

Use this skill when the user asks what tabs are open in Firefox, wants
to find a specific tab by URL or title, or needs a list of currently
open browser pages.

Do not use for opening, closing, navigating, or modifying tabs —
`browser_list_tabs` is read-only. Firefox only (Chrome/Safari not supported).

## Tool: `browser_list_tabs`

**Registered and active immediately** — no `manage_tools` activation step
needed. Call it directly.

```
browser_list_tabs({ "offset": 0, "limit": 100 })
```

Returns an array of open tabs. Each entry has:

| Field | Type | Description |
|---|---|---|
| `id` | number | Numeric tab ID (use with `browser_get_tab_content` if it becomes available) |
| `url` | string | Full URL of the tab |
| `title` | string | Page title |
| `lastAccessed` | number | Unix ms timestamp of last access |

`limit` defaults to 100 and is **capped at 500** per call. Use `offset`
to page through more than 500 tabs.

## Tool: `browser_get_tab_content` (disabled by default)

This tool exists in the codebase but is **not registered** in normal
sessions. It is gated behind an internal `enableGetTabContent` flag
(default `false`) because `executeScript` can hang indefinitely on
streaming or SPA tabs. **Do not attempt to call it** — it will not be
present in `manage_tools` listings. If you see it, the operator has
explicitly opted in.

## `/browser-control` slash command

A user-facing management menu with three items:

| Item | What it does |
|---|---|
| **Status** | Shows daemon PID, uptime, version, and whether the add-on is connected |
| **Test connection** | Pings the daemon and reports how many tabs are visible |
| **Install Firefox native-messaging manifest** | Writes the NM manifest + launcher script to disk |

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
   `browser_list_tabs` directly.

If the user has previously completed setup, `browser_list_tabs` should
just work as long as Firefox is open with the add-on running.

## Error recovery

| Error code | Meaning | What to do |
|---|---|---|
| `DAEMON_NOT_RUNNING` | Firefox is not open or the add-on is not loaded | Ask the user to open Firefox and load the add-on via `about:debugging`. Do NOT claim that `/browser-control` starts the daemon. |
| `ADDON_NOT_CONNECTED` | Daemon is running but the add-on lost its NM connection | Ask the user to reload the add-on in `about:debugging → Reload`. |
| `TAB_NOT_FOUND` | Stale tab ID (tab was closed) | Re-run `browser_list_tabs` to get fresh IDs. |
| `TAB_DISCARDED` | (disabled tool) Firefox unloaded the tab to save memory | Ask the user to click the tab in Firefox to reload it, then retry. |
| `EXTRACTION_TIMEOUT` | (disabled tool) Page never settled (streaming / SPA) | Try a different tab or ask the user to let the page finish loading. |
| `TAB_PROTECTED` | (disabled tool) Privileged page (`about:`, `moz-extension:`) | Choose a normal web-content tab. |

## Typical workflow

```
browser_list_tabs({ "offset": 0, "limit": 100 })
```

Scan the returned list for the tab the user is asking about. If there
are more than 100 tabs and you did not find a match, increment `offset`
by 100 and repeat until `offset` ≥ total returned count.

## Limitations

- **Read-only.** Cannot open, close, navigate, focus, or modify tabs.
- **Firefox only.** No Chrome, Safari, or other browsers.
- **Content extraction disabled.** Reading tab page content is not
  available in standard sessions.
- **Local machine only.** The unix socket path
  `~/.pi/agent/pi-browser-control.sock` is on the same host as the pi
  session; remote or SSH sessions cannot reach a local Firefox instance.
