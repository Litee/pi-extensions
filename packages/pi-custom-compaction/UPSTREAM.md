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

## Local divergences

- Source moved from repo root into `src/` so the package matches this monorepo's
  layout (`packages/*/src/**`, `packages/*/test/**`).
- Imports rewritten from `@mariozechner/pi-*` to `@earendil-works/pi-*` — this
  monorepo consumes the `@earendil-works` republish of the pi SDK.
- Tests ported from `node:test` (`tsx --test`) to `vitest`. The `node:assert`
  imports are kept as-is; only the `describe`/`it` source changed.
- `package.json` slimmed to the conventions of this repo: `private: true`,
  peerDependencies on the `@earendil-works/pi-*` packages, no standalone
  `test`/`build` scripts (the workspace-level `npm run check` covers it).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/nicobailon-pi-custom-compaction
git clone --quiet https://github.com/nicobailon/pi-custom-compaction.git "$UP"
git -C "$UP" log --follow a0e4700..origin/HEAD
```
