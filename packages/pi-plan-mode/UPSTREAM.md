# Upstream

This package is a local copy of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)
- **Upstream path:** `packages/coding-agent/examples/extensions/plan-mode/`
- **License:** MIT, © Mario Zechner

## Copied versions

- **Initially ported:** `dee3d8c` (local commit `6eb59e7`)
- **Last synced:** `c29bbc09`

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow c29bbc09..origin/HEAD -- \
    packages/coding-agent/examples/extensions/plan-mode/
```
