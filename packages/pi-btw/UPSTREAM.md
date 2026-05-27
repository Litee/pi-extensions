# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw)
- **Upstream path:** `extensions/btw.ts`, `tests/btw.runtime.test.ts`,
  `skills/btw/SKILL.md`, `LICENSE`
- **License:** MIT, © Dan Bachelder

## Copied versions

- **Initially ported:** `88980a4` (initial port)
- **Last synced:** `742f0ee` (`chore: remove pnpm lockfile`, 2026-05-22)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/dbachelder-pi-btw
git clone --quiet https://github.com/dbachelder/pi-btw.git "$UP"
git -C "$UP" log --follow 742f0ee..origin/HEAD -- extensions/btw.ts tests/btw.runtime.test.ts skills/btw/SKILL.md
```
