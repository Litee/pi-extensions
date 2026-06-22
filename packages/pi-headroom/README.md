# pi-headroom

Pi extension for [Headroom](https://github.com/headroom-ai/headroom) token compression. Connects to a Headroom proxy you run externally, compresses conversation context to reduce token usage, and shows live compression stats in the pi footer.

**The extension does not launch or manage the proxy.** Start it manually before or during a session.

## Install

```bash
pi install npm:pi-headroom
```

You also need the Headroom proxy:

```bash
pip install "headroom-ai[proxy]"
```

Start it manually:

```bash
HEADROOM_TELEMETRY=off headroom proxy --host 127.0.0.1 --port 8788 --mode token --no-cache
```

## Commands

- `/headroom` — open the TUI settings menu.
- `/headroom status` — show current settings (default when no subcommand).
- `/headroom health` — report proxy URL and whether it is reachable.
- `/headroom stats` — report proxy statistics (requires a running proxy).

The footer shows a compact status (`✓ Headroom -42% (12,345 saved)`) when compression is active and the proxy is online.

## TUI menu

The `/headroom` menu provides:

- **Compression** — enable/disable for this session.
- **Min context tokens** — compress only when context exceeds this threshold.
- **Min message chars** — skip messages shorter than this.
- **Proxy URL** — the base URL of the Headroom proxy.
- **Allow remote** — permit non-localhost proxy URLs (off by default for privacy).
- **Timeout (ms)** — HTTP request timeout.
- **Reset to defaults** — delete `pi-headroom.json` and revert all settings.

The top of the menu shows a live snapshot of the current session: proxy status, compression attempts vs. applied, cumulative tokens saved, and last compression detail.

## Privacy

Compression sends conversation context to the proxy. Remote URLs are blocked by default — only `localhost`/`127.0.0.1`/`::1` are allowed unless you enable **Allow remote** in the menu or set `PI_HEADROOM_ALLOW_REMOTE=1` for a proxy you trust.

## Configuration

Settings persist to `~/.pi/agent/pi-headroom.json`. Values there override environment variables.

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
| `minContextTokens` | `PI_HEADROOM_MIN_CONTEXT_TOKENS` | `20000` | Skip compression below this context token count. |
| `minMessageChars` | `PI_HEADROOM_MIN_MESSAGE_CHARS` | `2000` | Only compress messages at or above this size. |
| `timeoutMs` | `PI_HEADROOM_TIMEOUT_MS` | `30000` | HTTP timeout for proxy requests. |

Boolean values accept `true/false`, `1/0`, `yes/no`, or `on/off`.

## Local customisations from upstream

- Restructured to monorepo conventions: sources in `src/`, tests in `test/`.
- Package renamed from `@ryan_nookpi/pi-extension-headroom` to `pi-headroom`.
- Settings path changed to `~/.pi/agent/pi-headroom.json` (upstream uses `~/.headroom/settings.json`).
- Removed `autoStart` / automatic proxy launch — proxy is started externally.
- Removed `files`, `publishConfig`, `homepage`, `bugs` from `package.json`.
- TUI menu expanded with proxy URL, allow remote, timeout, and session stats display.
- `/headroom on` and `/headroom off` subcommands removed — use the menu instead.
- Proxy health is checked automatically on `session_start` (upstream only checks on `/headroom health`).
