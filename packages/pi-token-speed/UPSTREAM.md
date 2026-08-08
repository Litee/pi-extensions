# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`gsanhueza/pi-token-speed`](https://github.com/gsanhueza/pi-token-speed)
- **Upstream path:** entire repository
- **License:** MIT, © Gabriel Sanhueza

## Copied versions

- **Copied:** `75e0aca` (`chore: updated to 0.7.0`, 2026-07-04)

## How to check for upstream changes

```bash
UP=$(mktemp -d)/gsanhueza-pi-token-speed
git clone --quiet https://github.com/gsanhueza/pi-token-speed.git "$UP"
git -C "$UP" log 75e0aca..origin/HEAD
```
