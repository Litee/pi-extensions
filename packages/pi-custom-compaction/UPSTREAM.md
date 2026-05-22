# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`nicobailon/pi-custom-compaction`](https://github.com/nicobailon/pi-custom-compaction)
- **Upstream path:** repository root
- **License:** MIT, © Nico Bailon

## Copied versions

- **Initially ported:** `a0e4700` (`chore: release 0.2.5`, 2026-04-04)
- **Last synced:** `a0e4700` (`chore: release 0.2.5`, 2026-04-04)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/nicobailon-pi-custom-compaction
git clone --quiet https://github.com/nicobailon/pi-custom-compaction.git "$UP"
git -C "$UP" log --follow a0e4700..origin/HEAD
```
