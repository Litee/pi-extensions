# Upstream

This package is a local port of an upstream extension. Use the information below to
diff against upstream and pick up future changes.

> **⚠️ Upstream deprecated — stop checking.** `packages/headroom` was deprecated
> upstream on 2026-07-12 (commit `44f8f50`, "chore: deprecate codex-large-context,
> todo-write, headroom extensions"); the upstream README now states the package "is
> no longer maintained and will not receive updates." Do not run routine upstream
> checks for this package — the recipe below is kept for reference only.

## Source

- **Repository:** [`Jonghakseo/pi-extension`](https://github.com/Jonghakseo/pi-extension)
- **Upstream path:** `packages/headroom`
- **License:** MIT (from `package.json`; no LICENSE file at upstream root)
- **Upstream status:** deprecated (since 2026-07-12) — no further syncing

## Copied versions

- **Initially ported:** `22b5e90` (commit `chore(generative-ui): bump version to 0.2.3`, 2026-06-05)
- **Last synced:** `22b5e90` — no functional upstream changes ported since. Post-port
  commits touching `packages/headroom` were only release version bumps (`ba11195`,
  `80b0695`) and the deprecation commit itself (`44f8f50`); nothing was worth
  porting before checking was stopped.

For intentional local divergences see **Differences from upstream** in [`README.md`](./README.md).

## How to check for upstream changes

**Not applicable — upstream is deprecated and no longer maintained.** Recipe kept for reference:

```bash
UP=$(mktemp -d)/pi-extension
git clone --quiet https://github.com/Jonghakseo/pi-extension.git "$UP"
git -C "$UP" log --follow 22b5e90..origin/HEAD -- packages/headroom
```
