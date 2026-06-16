# Upstream

This package is a local copy of an upstream file. Use the information below to
diff against upstream and pick up future changes.

## Source

- **Repository:** [`Jonghakseo/pi-extension`](https://github.com/Jonghakseo/pi-extension)
- **Upstream path:** `packages/headroom`
- **License:** MIT (from `package.json`; no LICENSE file at upstream root)

## Copied versions

- **Initially ported:** `22b5e90` (commit `chore(generative-ui): bump version to 0.2.3`, 2026-06-05)

## Differences from upstream

- Restructured to match local monorepo conventions: source files moved into `src/`, tests into `test/`.
- Package renamed from `@ryan_nookpi/pi-extension-headroom` to `pi-headroom`.
- Removed `files` array and `publishConfig` (not used in local packages).
- Removed `homepage` and `bugs` fields.
- **Major divergence (local):** Removed all proxy management and token compression logic (`client.ts`, `bridge.ts`, `proxy-manager.ts`). The extension no longer starts, monitors, or communicates with the Headroom proxy. It only provides:
  - A TUI settings menu (compression toggle, threshold adjustment, reset).
  - Slash command `/headroom` with subcommands (status, on, off, health, stats).
  - Footer status rendering.
  - Config loading/saving (settings.json + env vars).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-extension
git clone --quiet https://github.com/Jonghakseo/pi-extension.git "$UP"
git -C "$UP" log --follow 22b5e90..origin/HEAD -- packages/headroom
```

Note: due to the major divergence above, upstream changes are unlikely to be directly mergeable. Review each change manually before considering an update.
