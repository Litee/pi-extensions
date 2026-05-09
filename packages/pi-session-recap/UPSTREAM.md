# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions)
- **Upstream path:** `session-recap/`
- **License:** MIT, © Thomas Mustier

## Copied version

| Local file | Upstream commit | Upstream commit date | Upstream commit subject |
|---|---|---|---|
| `src/index.ts` | [`be58913`](https://github.com/tmustier/pi-extensions/commit/be58913759ea774e2eba7f836fb5c15e02f01d81) | 2026-04-24 | `fix(session-recap): add codex instructions` |

Ported in local commit `e20c62b` (`feat(pi-session-recap): port session-recap from tmustier/pi-extensions`, 2026-05-03).

Local port intentionally diverges from upstream:
- Pure helpers split out into `src/helpers.ts` so they are unit-testable
  without `pi-tui` / `pi-ai` / stdin. **`helpers.ts` does not exist upstream.**
- Strict-mode adjustments for `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`.
- Default idle timeout bumped from 45s to 120s (later raised again to 180s in
  commit `cba79b4`).
- Top-of-file JSDoc and README point back to upstream `DESIGN.md` as the
  design-of-record.

`src/settings.ts` is **not** from upstream; it was added locally in commit
`5e1c97d` (`feat(pi-session-recap): own user-config file at
~/.pi/agent/pi-session-recap.json`).

## How to check for upstream changes

```bash
UP=$(mktemp -d)/tmustier-pi-extensions
git clone --quiet https://github.com/tmustier/pi-extensions.git "$UP"
git -C "$UP" log --follow be58913..origin/HEAD -- session-recap/
```
