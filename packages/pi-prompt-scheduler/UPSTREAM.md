# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`tintinweb/pi-schedule-prompt`](https://github.com/tintinweb/pi-schedule-prompt)
- **Upstream path:** (repository root)
- **License:** MIT, © tintinweb

## Copied versions

- **Initially ported:** `a51cf5a` (v0.3.0 release)
- **Last synced:** `8d36dfb` (`Update package.json`, 2026-05-03)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/tintinweb-pi-schedule-prompt
git clone --quiet https://github.com/tintinweb/pi-schedule-prompt.git "$UP"
git -C "$UP" log --follow 8d36dfb..origin/HEAD
```
