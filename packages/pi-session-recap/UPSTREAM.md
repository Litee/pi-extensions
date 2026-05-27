# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions)
- **Upstream path:** `session-recap/`
- **License:** MIT, © Thomas Mustier

## Copied versions

- **Initially ported:** `be58913` (local commit `e20c62b`)
- **Last synced:** `b9ffdc7` (`Release session-recap v0.1.3`, 2026-05-12)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/tmustier-pi-extensions
git clone --quiet https://github.com/tmustier/pi-extensions.git "$UP"
git -C "$UP" log --follow b9ffdc7..origin/HEAD -- session-recap/
```
