# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions)
- **Upstream path:** `session-recap/`
- **License:** MIT, © Thomas Mustier

## Copied version

| Local file | Upstream commit | Upstream commit date | Upstream commit subject |
|---|---|---|---|
| `src/index.ts` | [`b9ffdc7`](https://github.com/tmustier/pi-extensions/commit/b9ffdc72dfe45534def62b6adf0fcbafa9c63a9d) | 2026-05-12 | `Release session-recap v0.1.3` |

Originally ported in local commit `e20c62b` (`feat(pi-session-recap): port session-recap from tmustier/pi-extensions`, 2026-05-03) from upstream `be58913`. Re-synced to `240b370` alongside the repo-wide `@mariozechner` → `@earendil-works` namespace migration. Re-synced to `b9ffdc7` (v0.1.3): ported `agentActive` deferred-focus logic, `cacheRetention: "none"` / `maxTokens: 256` model call fix, `turn_start` stale-draft cancellation, and `ctx.hasUI` guard on `session_start`. The `--recap-during-active` CLI flag from upstream is not ported — behavior is hardcoded to always defer. Upstream's flag-prefix fix (`--recap-*` → `recap-*`) is also not applied since our local fork already uses unprefixed flag names. The upstream version bump to `0.1.3` and changelog are not replicated.

`src/settings.ts` is **not** from upstream; it was added locally in commit
`5e1c97d` (`feat(pi-session-recap): own user-config file at
~/.pi/agent/pi-session-recap.json`). `src/helpers.ts` was also split out
locally; it does not exist upstream.

For the list of intentional local divergences from upstream, see the
**Differences from upstream** section in [`README.md`](./README.md). That is
the canonical location; this file stays focused on which upstream commit was
copied and how to diff against future upstream work.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/tmustier-pi-extensions
git clone --quiet https://github.com/tmustier/pi-extensions.git "$UP"
git -C "$UP" log --follow b9ffdc7..origin/HEAD -- session-recap/
```
