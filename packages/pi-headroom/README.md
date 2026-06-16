# @ryan_nookpi/pi-extension-headroom

This extension provides settings management and status display for [Headroom](https://github.com/headroom-ai/headroom) compression.

It lets you toggle token compression, adjust thresholds, and view current settings through a TUI menu — all persisted to `~/.pi/agent/pi-headroom.json`.

**This extension does not manage the Headroom proxy lifecycle.** You launch and control the proxy externally (e.g. via terminal). The extension simply reads your settings and shows status in the pi footer.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-headroom
```

You also need the Headroom proxy available on your machine:

```bash
pip install "headroom-ai[proxy]"
```

## Commands

- `/headroom` — open the TUI settings menu (compression toggle, thresholds, reset).
- `/headroom on` — enable compression for this session.
- `/headroom off` — disable compression for this session.
- `/headroom status` — show current settings (default when no subcommand).
- `/headroom health` — report proxy URL and whether it is reachable.
- `/headroom stats` — report proxy statistics (requires a running proxy).

The footer shows a compact status (`✓ Headroom -42% (12,345 saved)`) when compression is applied and the proxy is online.

## Privacy

Compression sends conversation context to the proxy, so remote URLs are blocked by default. Only `localhost`/`127.0.0.1`/`::1` are allowed unless you explicitly set `PI_HEADROOM_ALLOW_REMOTE=1` for a proxy you trust.

## Configuration

Settings are read at startup from `~/.pi/agent/pi-headroom.json`. Values in this file override environment variables; environment variables remain supported as fallbacks.

Example:

```json
{
  "minContextTokens": 10000,
  "minMessageChars": 1000
}
```

| Setting key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `PI_HEADROOM_ENABLED` | `true` | Enable compression on start. |
| `baseUrl` (`url` also accepted) | `PI_HEADROOM_URL` (`HEADROOM_URL` / `HEADROOM_BASE_URL` also accepted) | `http://127.0.0.1:8788` | Proxy base URL. |
| `allowRemote` | `PI_HEADROOM_ALLOW_REMOTE` | `false` | Allow non-local proxy URLs. |
| `command` | `PI_HEADROOM_COMMAND` | `headroom` | Command used to launch the proxy. |
| `minContextTokens` | `PI_HEADROOM_MIN_CONTEXT_TOKENS` | `20000` | Skip compression below this context token count. |
| `minMessageChars` | `PI_HEADROOM_MIN_MESSAGE_CHARS` | `2000` | Only compress messages at or above this size. |
| `timeoutMs` | `PI_HEADROOM_TIMEOUT_MS` | `30000` | HTTP timeout for proxy requests. |

Boolean values accept JSON booleans, or strings such as `1/0`, `true/false`, `yes/no`, `on/off`.

## Manual proxy launch

To start the proxy manually:

```bash
HEADROOM_TELEMETRY=off headroom proxy --host 127.0.0.1 --port 8788 --mode token --no-cache
```

The extension will automatically detect the proxy when it is running at the configured `baseUrl`.
