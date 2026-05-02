# pi-ask-user-question

Pi extension that registers the `ask_user_question` tool: a tabbed TUI dialog
the LLM can use to ask the user 1–5 structured clarifying questions (2–6
options each) instead of guessing. Feature-equivalent with the single-file
`ask-user-question.ts` extension that ships in `~/.pi/agent/extensions/`,
refactored as a monorepo package so every piece of behaviour is unit-tested.

## What it does

Registers one LLM tool: `ask_user_question`. The tool validates its arguments,
opens a tabbed TUI overlay, and returns the user's selections back to the
model. Supported features:

- single-select (default) or multi-select questions
- optional per-option markdown preview (single-select only; triggers
  side-by-side layout)
- per-option free-text "note" (press `n`)
- auto-appended "Type something." row on single-select questions that have
  no previews
- auto-appended "Next" row on multi-select questions (advances the tab)
- auto-appended "Chat about this" row on every question (soft escape)
- runtime validation: rejects duplicate / reserved labels and out-of-range
  shapes before showing any UI

## Architecture

The extension is split into small single-purpose modules so the dialog's
behaviour is fully testable without a live TUI:

| Module | Responsibility |
|---|---|
| `constants.ts` | Limits (`MIN_OPTIONS`, `MAX_QUESTIONS`, …) and the reserved-label regex. |
| `schema.ts` | TypeBox schema for the tool parameters. |
| `validate.ts` | Semantic validation (duplicates, reserved labels, preview-on-multi-select). |
| `rows.ts` | Builds the per-tab row list (options + sentinels). |
| `format.ts` | `Result` types, `emptyResult`, `formatToolResult` for the LLM reply. |
| `controller.ts` | Pure state machine for the dialog. No pi-tui imports. Drives tab/row cursor, multi-select bitmap, notes, input modes, completion. |
| `render.ts` | Small `renderCall` / `renderResult` helpers used in the tool listing. |
| `dialog.ts` | Thin pi-tui glue that wires `DialogController` to `ctx.ui.custom`. Excluded from coverage (it needs a real TUI to exercise). |
| `index.ts` | Tool registration. Accepts a `runDialog` override for testability. |

## Development

```bash
# from repo root
npm install
npx vitest run packages/pi-ask-user-question
# or include coverage thresholds:
npx vitest run --coverage packages/pi-ask-user-question
```

The package ships TypeScript sources only; pi loads them through its
jiti-based extension runtime, so there is no separate build step.
