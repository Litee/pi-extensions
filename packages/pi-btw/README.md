# pi-btw

> **Upstream:** [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw)
>
> This package is a copy of the upstream `pi-btw` extension (v0.4.0,
> MIT, by Dan Bachelder) ported into this workspace as `pi-btw` for
> easier local experimentation. The behaviour is identical; any changes
> made here should be kept in sync with the upstream via a diff against
> the link above.
>
> Two classes of modification versus upstream:
>
> 1. Peer-dependency imports rewritten from `@earendil-works/pi-*` to
>    `@mariozechner/pi-*` to match this workspace's convention.
> 2. A set of strictness-compliance edits (non-null assertions,
>    optional chaining, conditional spreads for optional fields,
>    one local guard, and a `.js` extension on the test's relative
>    import) to satisfy this repo's `@tsconfig/strictest` layering
>    (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
>    No behaviour changes — upstream's 50/50 vitest suite still
>    passes unchanged.

A pi extension that adds a `/btw` side-conversation channel. `/btw` opens a
real pi sub-session with coding-tool access that runs immediately even while
the main agent is still busy, rendered in a dedicated overlay so the main
session stays visible underneath.

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

## Overlay controls

- `Ctrl+\` toggles focus between the BTW overlay and the main editor
  without closing the overlay.
- `Ctrl+L` clears the current BTW thread while keeping the overlay open,
  ready for a fresh question (equivalent to `/btw:clear` but non-dismissing).
- `Ctrl+F` / `Ctrl+B` scroll the transcript forward / back by a page
  (MacBook-friendly alternative to `PgUp` / `PgDn`; follows the less/vim
  convention of forward = down, back = up).
- The composer's prompt glyph tracks keyboard focus: a bright `▶` when
  BTW is receiving your input, a dim `>` when the main editor owns focus.
  The overlay frame also brightens to accent colour when BTW is focused.
- `Esc` dismisses BTW immediately while the overlay is focused.
- The BTW overlay opens top-centered so the main session stays visible
  underneath it.

## Why

Sometimes you want to:

- ask a clarifying question while the main agent keeps working,
- think through next steps without derailing the current turn,
- explore an idea, then inject it back once it's ready.

## Included skill

This package also ships a small `btw` skill (see `skills/btw/SKILL.md`) so pi
can better recognize when a side-conversation workflow is appropriate. It
helps with discoverability and guidance, but is not required for the
extension itself to work.

## Attribution

This package is a verbatim port of
[`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw) (MIT,
© Dan Bachelder). For the full list of behaviours, design notes, and
upstream screenshots, see the upstream
[`README.md`](https://github.com/dbachelder/pi-btw/blob/main/README.md).

## License

MIT (inherited from the upstream). See [`LICENSE`](LICENSE).
