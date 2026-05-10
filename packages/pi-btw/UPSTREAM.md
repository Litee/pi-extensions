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

For the list of intentional local divergences from upstream (macOS shortcuts,
focus indicator, dependency rewires, strictness edits) see the **Differences
from upstream** section in [`README.md`](./README.md). That is the canonical
location; this file stays focused on which upstream commit was copied and
how to diff against future upstream work.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/dbachelder-pi-btw
git clone --quiet https://github.com/dbachelder/pi-btw.git "$UP"
git -C "$UP" log --follow 6de3c06..origin/HEAD -- extensions/btw.ts tests/btw.runtime.test.ts skills/btw/SKILL.md
```
