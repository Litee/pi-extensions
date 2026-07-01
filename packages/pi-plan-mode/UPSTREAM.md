# Upstream

This package is a local copy of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)
- **Upstream path:** `packages/coding-agent/examples/extensions/plan-mode/`
- **License:** MIT, © Mario Zechner

## Copied versions

- **Initially ported:** `dee3d8c` (local commit `6eb59e7`)
- **Last synced:** `542683b29ab2865976dddb006b4d70cffe315e25` (`fix(coding-agent): fix plan-mode example`, 2026-06-21)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow 542683b29ab2865976dddb006b4d70cffe315e25..origin/HEAD -- \
    packages/coding-agent/examples/extensions/plan-mode/
```
