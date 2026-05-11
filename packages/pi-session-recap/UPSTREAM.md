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
| `src/index.ts` | [`240b370`](https://github.com/tmustier/pi-extensions/commit/240b370181ee353c0be8ceaa054d3e2f7ae7b60f) | 2026-05-07 | `Declare Pi runtime peer dependencies` |

Originally ported in local commit `e20c62b` (`feat(pi-session-recap): port session-recap from tmustier/pi-extensions`, 2026-05-03) from upstream `be58913`. Re-synced to `240b370` alongside the repo-wide `@mariozechner` → `@earendil-works` namespace migration. The upstream version bump to `0.1.2` and its stand-alone `devDependencies` block are not replicated: this package is `private: true` and dev deps come from the monorepo root.

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
git -C "$UP" log --follow 240b370..origin/HEAD -- session-recap/
```
