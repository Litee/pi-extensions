# Upstream

This package is a local copy of an upstream file. Use the information below to
diff against upstream and pick up future changes.

## Source

- **Repository:** [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)
- **Upstream path:** `packages/coding-agent/examples/extensions/built-in-tool-renderer.ts`
- **License:** MIT, © Mario Zechner

## Copied version

| Local file | Upstream commit | Upstream commit date | Upstream commit subject |
|---|---|---|---|
| `src/index.ts` | [`3e5ad67`](https://github.com/badlogic/pi-mono/commit/3e5ad67e0f325d4888f82f9b82966218eb4407f5) | 2026-05-07 | `chore: migrate pi packages to earendil works scope` |

Originally ported in local commit `6eb59e7` (`feat(packages): add pi-plan-mode and pi-built-in-tool-renderer`, 2026-05-06) from upstream `f7cd613`. Re-synced to `3e5ad67` alongside the repo-wide `@mariozechner` → `@earendil-works` namespace migration.

For the list of intentional local divergences from upstream, see the
**Differences from upstream** section in [`README.md`](./README.md). That is
the canonical location; this file stays focused on which upstream commit was
copied and how to diff against future upstream work.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow 3e5ad67..origin/HEAD -- \
    packages/coding-agent/examples/extensions/built-in-tool-renderer.ts
```
