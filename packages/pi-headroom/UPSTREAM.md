# Upstream

This package is a local port of an upstream extension. Use the information below to
diff against upstream and pick up future changes.

## Source

- **Repository:** [`Jonghakseo/pi-extension`](https://github.com/Jonghakseo/pi-extension)
- **Upstream path:** `packages/headroom`
- **License:** MIT (from `package.json`; no LICENSE file at upstream root)

## Copied versions

- **Initially ported:** `22b5e90` (commit `chore(generative-ui): bump version to 0.2.3`, 2026-06-05)
- **Last synced:** `22b5e90` (no upstream changes picked up since initial port)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-extension
git clone --quiet https://github.com/Jonghakseo/pi-extension.git "$UP"
git -C "$UP" log --follow 22b5e90..origin/HEAD -- packages/headroom
```
