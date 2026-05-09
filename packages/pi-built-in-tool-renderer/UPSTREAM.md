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

The local port intentionally diverges from upstream in the bash renderer:
- Uses `context.isError` as the authoritative non-zero-exit signal (instead of
  regex-matching stdout).
- Parses the real `Command exited with code N` / `Command timed out after Ns`
  / `Command aborted` sentinels for the failure label.
- Shows elapsed time inline, ticking every second while the command runs.

Renderers for `grep` / `ls` / `find` were added locally in `6ed90df`; they do
not exist in upstream.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/pi-mono
git clone --quiet https://github.com/badlogic/pi-mono.git "$UP"
git -C "$UP" log --follow f7cd613..origin/HEAD -- \
    packages/coding-agent/examples/extensions/built-in-tool-renderer.ts
```
