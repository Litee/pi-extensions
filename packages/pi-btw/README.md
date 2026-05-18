# pi-btw

A pi extension that adds a `/btw` side-conversation channel. `/btw` opens a
real pi sub-session with coding-tool access that runs immediately even while
the main agent is still busy, rendered in a dedicated overlay so the main
session stays visible underneath.

Use it when you want to ask a clarifying question, think through next steps,
or explore an idea without derailing the current turn — and optionally
inject the result back into the main agent when you are ready.

## What it does

- Opens a parallel side conversation without interrupting the main run.
- Runs that side conversation as a real pi sub-session with `read` / `bash` /
  `edit` / `write` tool access.
- Keeps a continuous BTW thread by default; `/btw:tangent` starts a
  contextless side thread that does not inherit the main-session context.
- Opens a focused BTW modal shell with its own composer and transcript.
- Keeps the BTW overlay open while you switch focus back to the main editor
  with `Ctrl+\`.
- Keeps BTW thread entries out of the main agent's future context (hidden
  custom session entries).
- Supports BTW-only model and thinking overrides without changing the main
  thread settings.
- Lets you inject the full thread, or a summary of it, back into the main
  agent.
- Optionally saves an individual BTW exchange as a visible session note with
  `--save`.
- Ships a small `btw` skill (`skills/btw/SKILL.md`) so pi can better
  recognize when a side-conversation workflow is appropriate. Helps with
  discoverability; not required for the extension itself.

## Commands

| Command | Description |
|---|---|
| `/btw [--save] <question>` | Ask a side question. Runs right away, even while pi is busy. Continues the current BTW thread. `--save` also persists the exchange as a visible session note. |
| `/btw:new [question]` | Clear the current BTW thread and start a fresh one that still inherits main-session context. |
| `/btw:tangent [--save] <question>` | Start or continue a contextless tangent thread (no inherited main context). |
| `/btw:clear` | Dismiss the BTW modal and clear the current BTW thread. |
| `/btw:inject [instructions]` | Send the full BTW thread back to the main agent as a user message. Queues as follow-up if pi is busy. Clears the BTW thread after sending. |
| `/btw:summarize [instructions]` | Summarize the BTW thread with the current effective BTW model (thinking forced off) and inject the summary into the main agent. |
| `/btw:model [<provider> <id> [responses-api] \| clear]` | Show / set / clear a BTW-only model override. |
| `/btw:thinking [<level> \| clear]` | Show / set / clear a BTW-only thinking-level override for normal BTW chat. |

## Keybindings

- `Ctrl+\` toggles focus between the BTW overlay and the main editor
  without closing the overlay.
- `Ctrl+L` clears the current BTW thread while keeping the overlay open,
  ready for a fresh question (equivalent to `/btw:clear` but non-dismissing).
- `Option+↑` / `Option+↓` (`⌥↑↓`) scroll the transcript back / forward
  by a page — MacBook-friendly equivalent to `PgUp` / `PgDn`. `Ctrl+B` /
  `Ctrl+F` keep working as a less/vim-style fallback (forward = down,
  back = up).
- `Esc` dismisses BTW immediately while the overlay is focused.
- The composer's prompt glyph tracks keyboard focus: a bright `▶` when
  BTW is receiving your input, a dim `>` when the main editor owns focus.
  The overlay frame also brightens to accent colour when BTW is focused.
- The BTW overlay opens top-centered so the main session stays visible
  underneath it.

## Attribution

This package is a verbatim port of
[`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw) (MIT,
© Dan Bachelder). For the full list of behaviours, design notes, and
upstream screenshots, see the upstream
[`README.md`](https://github.com/dbachelder/pi-btw/blob/main/README.md).
See [`UPSTREAM.md`](./UPSTREAM.md) for the exact copied commit and a
recipe for diffing against future upstream changes.

## Differences from upstream

Not exhaustive — just the highlights that matter if you are considering
copying this package. Here is what you will be picking up on top of upstream
`pi-btw` v0.4.0:

- **macOS-friendly overlay shortcuts.** Focus toggle moved from `Alt+/` /
  `Ctrl+Alt+W` to `Ctrl+\` (works on cmux and other kitty-protocol terminals
  without Option-as-Meta setup). Added `Ctrl+L` to clear the BTW thread in
  place without dismissing the overlay. Added `Ctrl+B` / `Ctrl+F` as
  MacBook-friendly page-scroll keys alongside `PgUp` / `PgDn`.
- **Visual focus indicator.** The composer prompt glyph is replaced with a
  focus-state marker: a bright accent `▶` when BTW has keyboard focus, a dim
  `>` when the main editor does. The overlay frame also changes colour to
  match. Makes it obvious which composer receives your keystrokes when the
  overlay is parked open.
- **Hint line drift guard.** The on-screen hint below the composer is
  covered by a regression test that fails if the hint string stops matching
  the real key bindings.
- **Workspace housekeeping** (no behaviour change): peer-dependency imports
  rewritten from `@earendil-works/pi-*` to `@earendil-works/pi-*`;
  strictness-compliance edits for `@tsconfig/strictest`
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); `.js`
  extension on the test's relative import for `nodenext` resolution.

Upstream's 50/50 vitest suite still passes unchanged. The new behaviour is
covered by additional local tests.

## License

MIT (inherited from the upstream). See [`LICENSE`](LICENSE).
