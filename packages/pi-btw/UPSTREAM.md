# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw)
- **Upstream path:** `extensions/btw.ts`, `tests/btw.runtime.test.ts`,
  `skills/btw/SKILL.md`, `LICENSE`
- **License:** MIT, © Dan Bachelder

## Copied version

| Local file | Upstream commit | Upstream commit date | Upstream commit subject |
|---|---|---|---|
| `src/index.ts` | [`6de3c06`](https://github.com/dbachelder/pi-btw/commit/6de3c06a2ff4f685bc581d84a04646e733bcd32e) | 2026-05-07 | `chore: release v0.4.0 — @earendil-works namespace, pi 0.74` |
| `test/btw.runtime.test.ts` | [`6de3c06`](https://github.com/dbachelder/pi-btw/commit/6de3c06a2ff4f685bc581d84a04646e733bcd32e) | 2026-05-07 | `chore: release v0.4.0 — @earendil-works namespace, pi 0.74` |
| `skills/btw/SKILL.md` | [`6de3c06`](https://github.com/dbachelder/pi-btw/commit/6de3c06a2ff4f685bc581d84a04646e733bcd32e) | 2026-05-07 | `chore: release v0.4.0 — @earendil-works namespace, pi 0.74` |
| `LICENSE` | [`6de3c06`](https://github.com/dbachelder/pi-btw/commit/6de3c06a2ff4f685bc581d84a04646e733bcd32e) | 2026-05-07 | `chore: release v0.4.0 — @earendil-works namespace, pi 0.74` |

Upstream layout is `extensions/btw.ts`; locally it lives at `src/index.ts`
to match this workspace's per-package convention.

Local port intentionally diverges from upstream:

- Peer-dependency imports rewritten from `@earendil-works/pi-*` to
  `@mariozechner/pi-*` to match this workspace's convention (three lines
  in `src/index.ts`, one in `test/btw.runtime.test.ts`).
- Strictness-compliance edits to satisfy this repo's `@tsconfig/strictest`
  layering (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`):
  ~5 fix sites in `src/index.ts` and ~31 in `test/btw.runtime.test.ts` —
  non-null assertions at indexed-access sites, optional chaining,
  conditional spreads for `exactOptionalPropertyTypes`-guarded optional
  fields, and two local `if (!x) continue;` guards.
- Test's relative import switched from `"../src"` to `"../src/index.js"`
  to satisfy this repo's `nodenext` module resolution (matches
  `pi-plan-mode` / `pi-session-recap` convention).
- Top-of-file JSDoc in `src/index.ts` and `README.md` attribution block
  point back to upstream as the design-of-record.

No behaviour changes vs. upstream. Upstream's 50/50 vitest suite still
passes unchanged.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/dbachelder-pi-btw
git clone --quiet https://github.com/dbachelder/pi-btw.git "$UP"
git -C "$UP" log --follow 6de3c06..origin/HEAD -- extensions/btw.ts tests/btw.runtime.test.ts skills/btw/SKILL.md
```
