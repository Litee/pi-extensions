# Upstream

This package is a local copy of an upstream file. Use the information below to
diff against upstream and pick up future changes.

## Source

- **Repository:** [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)
- **Upstream path:** `packages/coding-agent/examples/extensions/built-in-tool-renderer.ts`
- **License:** MIT, © Mario Zechner

## Copied version

| Local file | Upstream commit | Upstream commit date | Upstream commit subject |
|---|---|---|---|
| `src/index.ts` | [`f7cd613`](https://github.com/badlogic/pi-mono/commit/f7cd613ee46156955058b406e216290a3cb72299) | 2026-04-15 | `fix(coding-agent): stabilize edit diff previews closes #3134` |

Ported in local commit `6eb59e7` (`feat(packages): add pi-plan-mode and pi-built-in-tool-renderer`, 2026-05-06).

For the list of intentional local divergences from upstream (bash renderer
extensions, grep / ls / find renderers, shell-preservation fix, expanded
bash view) see the **Differences from upstream** section in
[`README.md`](./README.md). That is the canonical location; this file stays
focused on which upstream commit was copied and how to diff against future
upstream work.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow f7cd613..origin/HEAD -- \
    packages/coding-agent/examples/extensions/built-in-tool-renderer.ts
```
