# Upstream

This package is a local copy of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
- **Upstream path:** `src/`, `test/`, `LICENSE`
- **License:** MIT, © tintinweb

## Copied versions

- **Initially ported:** `41308f0` (`feat(scopedModels): Add new feature to force following the defined scoped models by user (rebased #45) (#83)`, 2026-05-26)
- **Last synced:** `c32beeb` (`feat(ui): inline steer composer in the conversation viewer (#121)`, 2026-06-30)

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/tintinweb-pi-subagents
git clone --quiet https://github.com/tintinweb/pi-subagents.git "$UP"
git -C "$UP" log --follow c32beeb3abc4141c9eefc7b830fb627e12c95f97..origin/HEAD -- src/
```
