# Upstream

This package is a port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail)
- **Upstream path:** `pi-extension/`, `hooks/`, `skills/`
- **License:** MIT, © 2026 DietrichGebert

## Copied versions

- **Initially ported:** latest (commit hash unavailable — GitHub API unreachable at time of port)
- **Last synced:** latest

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/DietrichGebert-ponytail
git clone --quiet https://github.com/DietrichGebert/ponytail.git "$UP"
git -C "$UP" log --oneline -- pi-extension/ hooks/ skills/
```

Compare the output against the last synced commit to spot new changes.

Note: upstream hook files use `.js` extension; this package uses `.cjs`.
