# Upstream

This package is a local copy of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)
- **Upstream path:** `packages/coding-agent/examples/extensions/plan-mode/`
- **License:** MIT, © Mario Zechner

## Copied versions

Each file was copied at the then-latest upstream commit that touched it. The
two files landed at different upstream commits simply because upstream touched
them in different PRs.

| Local file | Upstream commit | Upstream commit date | Upstream commit subject |
|---|---|---|---|
| `src/index.ts` | [`39ee5fe`](https://github.com/badlogic/pi-mono/commit/39ee5fee92c5c4c004fb117382411487ed30fadc) | 2026-01-15 | `fix(plan-mode): change shortcut from Shift+P to Ctrl+Alt+P (#746)` |
| `src/utils.ts` | [`dee3d8c`](https://github.com/badlogic/pi-mono/commit/dee3d8c6a85f5f039addc34b5242f531d0c3ec50) | 2026-04-15 | `chore(coding-agent): replace exa with eza in plan-mode extension (#3240)` |

Ported in local commit `6eb59e7` (`feat(packages): add pi-plan-mode and pi-built-in-tool-renderer`, 2026-05-06).
Local port applies narrow strict-tsconfig patches only.

`src/tool-snapshot.ts` is **not** from upstream; it was added locally in commit
`b16db13` (`feat(plan-mode): persist model/thinking/tool snapshots across restarts`).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow 39ee5fe..origin/HEAD -- \
    packages/coding-agent/examples/extensions/plan-mode/index.ts
git -C "$UP" log --follow dee3d8c..origin/HEAD -- \
    packages/coding-agent/examples/extensions/plan-mode/utils.ts
```
