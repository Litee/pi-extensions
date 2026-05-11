# Upstream

This package is a local port of an upstream extension. Use the information
below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`tintinweb/pi-schedule-prompt`](https://github.com/tintinweb/pi-schedule-prompt)
- **Upstream path:** (repository root)
- **License:** MIT, © tintinweb

## Copied version

| Local file | Upstream commit | Upstream commit date | Upstream commit subject |
|---|---|---|---|
| `src/**` (v0.3.0) | [`8d36dfb`](https://github.com/tintinweb/pi-schedule-prompt/commit/8d36dfbb3657bbfa1127f4ca3e5adb29c7bf12d1) | 2026-05-03 | `Update package.json` |

Original port from upstream `a51cf5a` (v0.3.0 release). Re-synced to `8d36dfb`; the two intervening upstream commits (`1d5f1d4` .gitignore/.npmignore, `8d36dfb` description tweak) don't apply locally (this package has no local ignore files and our description is a different LLM-only fork description).

Ported locally as `pi-prompt-scheduler` — a trimmed, LLM-only fork of upstream
`pi-schedule-prompt`. The manual `add` flow and its supporting TUI widgets
(`src/ui/add-flow.ts`, `src/ui/schedule-input.ts`) are intentionally omitted;
jobs are created exclusively through the LLM-facing `schedule_prompt` tool,
and the `/schedule-prompt` command only browses / toggles / removes them.

For the list of intentional local divergences from upstream, see the
**Differences from upstream** section in [`README.md`](./README.md). That is
the canonical location; this file stays focused on which upstream commit was
copied and how to diff against future upstream work.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/tintinweb-pi-schedule-prompt
git clone --quiet https://github.com/tintinweb/pi-schedule-prompt.git "$UP"
git -C "$UP" log --follow 8d36dfb..origin/HEAD
```
