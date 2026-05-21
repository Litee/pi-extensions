# Upstream

This package contains prompt templates copied from OpenAI Codex. Use the
information below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`openai/codex`](https://github.com/openai/codex)
- **Upstream path:** `codex-rs/core/templates/goals/`
- **License:** Apache License 2.0, © 2025 OpenAI
- **License file:** [`LICENSE-APACHE-2.0`](./LICENSE-APACHE-2.0)
- **Attribution:** [`NOTICE`](./NOTICE)

## Copied versions

The three Mustache-style prompt templates that drive Codex's `/goal`
continuation lifecycle are copied verbatim. Variables in the templates
(`{{ objective }}`, `{{ tokens_used }}`, etc.) are filled in by `src/prompt.ts`
before the rendered prompt is injected into the agent context.

- **Initially ported:** `99157f3` (initial copy of all three templates, 2026-05-13)
- **Last synced:** `0d344ac` (`continuation.md` only — `goal: pause continuation loops on usage limits and blockers (#23094)`, 2026-05-18)

The `99157f3` SHA is the `main` HEAD at the time of the initial copy (the
shallow clone used during the port did not retain per-file history).

## What is original to this package

The TypeScript glue that makes the Codex prompts work as a pi extension is
original and MIT-licensed (see [`LICENSE`](./LICENSE)):

- `src/index.ts` — extension wiring, `/goal` command, `update_goal` tool registration, agent_end loop, token-budget tracking
- `src/state.ts` — session-persisted goal state (objective, token budget, baseline)
- `src/prompt.ts` — template loader and `{{ var }}` substitution
- `src/helpers.ts` — pi-message extraction utilities
- `test/*.test.ts` — unit tests

## Intentional local divergences from upstream

The Codex implementation runs inside the Codex CLI's Rust core, with native
goal lifecycle and a `update_goal` function tool. We adapt that surface to
pi's extension API:

| Codex behaviour | pi-goal port |
|---|---|
| `update_goal(status="complete"|"blocked")` function tool | `update_goal({status:"complete"|"blocked", summary})` extension tool. `complete` exits the loop on the success path; `blocked` exits on the issue-#0004 blocked path (warning notify + follow-up that mirrors the success/abort shape from #0003). Tool is inactive by default and only added to the active set while a goal is running. |
| Token usage from Codex's internal accounting | `ctx.getContextUsage()` |
| `objective_updated.md` rendered when the user edits the goal mid-stream | Rendered when `/goal <new_objective>` is invoked while a goal is already active |
| Budget-limited status is system-controlled (LLM cannot pause/resume) | Same — `update_goal` is the only LLM-facing transition |
| Native session/turn IDs | Iteration counter (also doubles as a hard safety cap) |
| Continuation injected as a separate system message before the agent turn | Continuation embedded inline in the kickoff/continue user message via `buildGoalTurnMessage()` — avoids two consecutive user messages, which Bedrock Claude rejects with "This model does not support assistant message prefill" |
| Audit prompt assumes code-task evidence (command output, file diffs) | We append a `PI_GOAL_TRIVIAL_ADDENDUM` paragraph in code (NOT in the template file) that carves out trivial Q&A / arithmetic goals where the assistant's stated answer IS the evidence. Code-task goals still require real evidence. |

The three template files themselves are copied **unmodified** so the upstream
diff stays clean. The trivial-goal addendum lives in `src/prompt.ts` as the
exported constant `PI_GOAL_TRIVIAL_ADDENDUM` and is appended at render time;
the Apache 2.0 §4(b) change-notice obligation does not apply because we are
not redistributing modified copies of the original work.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/codex
git clone --quiet --filter=blob:limit=200k https://github.com/openai/codex.git "$UP"
git -C "$UP" log --follow 0d344ac..origin/HEAD -- \
    codex-rs/core/templates/goals/continuation.md \
    codex-rs/core/templates/goals/budget_limit.md \
    codex-rs/core/templates/goals/objective_updated.md
```

If new templates appear under `codex-rs/core/templates/goals/`, evaluate
whether they map to a useful pi event (e.g. user edits, session resume) and
port them with the same attribution pattern.
