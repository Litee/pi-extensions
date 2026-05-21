# Upstream

This package is a local copy of an upstream file. Use the information below to
diff against upstream and pick up future changes.

## Source

- **Repository:** [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)
- **Upstream path:** `packages/coding-agent/examples/extensions/built-in-tool-renderer.ts`
- **License:** MIT, © Mario Zechner

## Copied versions

- **Initially ported:** `f7cd613` (local commit `6eb59e7`)
- **Last synced:** `3e5ad67` (`chore: migrate pi packages to earendil works scope`, 2026-05-07)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow 3e5ad67..origin/HEAD -- \
    packages/coding-agent/examples/extensions/built-in-tool-renderer.ts
```
