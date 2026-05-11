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
| `src/index.ts` | [`3e5ad67`](https://github.com/badlogic/pi-mono/commit/3e5ad67e0f325d4888f82f9b82966218eb4407f5) | 2026-05-07 | `chore: migrate pi packages to earendil works scope` |
| `src/utils.ts` | [`dee3d8c`](https://github.com/badlogic/pi-mono/commit/dee3d8c6a85f5f039addc34b5242f531d0c3ec50) | 2026-04-15 | `chore(coding-agent): replace exa with eza in plan-mode extension (#3240)` |

Originally ported in local commit `6eb59e7` (`feat(packages): add pi-plan-mode and pi-built-in-tool-renderer`, 2026-05-06) from upstream `39ee5fe`/`dee3d8c`. `index.ts` re-synced to `3e5ad67` alongside the repo-wide `@mariozechner` → `@earendil-works` namespace migration; `utils.ts` untouched upstream since `dee3d8c`.

`src/tool-snapshot.ts` is **not** from upstream; it was added locally in commit
`b16db13` (`feat(plan-mode): persist model/thinking/tool snapshots across restarts`).

For the list of intentional local divergences from upstream, see the
**Differences from upstream** section in [`README.md`](./README.md). That is
the canonical location; this file stays focused on which upstream commits
were copied and how to diff against future upstream work.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow 3e5ad67..origin/HEAD -- \
    packages/coding-agent/examples/extensions/plan-mode/index.ts
git -C "$UP" log --follow dee3d8c..origin/HEAD -- \
    packages/coding-agent/examples/extensions/plan-mode/utils.ts
```
