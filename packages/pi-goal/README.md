# pi-goal

Codex-style autonomous goal mode for pi. Set a `/goal` and pi works toward it
across turns until the agent itself signals completion via a `update_goal`
tool call, the iteration safety net is hit, or the token budget is exhausted.

The completion-audit prompt and lifecycle templates are ported verbatim from
[OpenAI Codex](https://github.com/openai/codex) (Apache 2.0). See
[`UPSTREAM.md`](./UPSTREAM.md).

## What it does

- **`/goal <objective>`** — Enable goal mode with the given objective and kick
  off the first turn.
- **`/goal stop`** — Cancel goal mode immediately.
- **`/goal status`** — Show current objective, iteration count, and token
  usage as a chat message.
- **`/goal <new objective>`** while already active — Switch the objective.
  The next continuation injects Codex's `objective_updated.md` so the agent
  knows to abandon any work that only served the old objective.
- **`Ctrl+Alt+G`** — If goal is active: cancel it. If not: open an input
  prompt.
- **`update_goal(summary)`** — A tool the agent can call to mark the goal
  complete. The agent is instructed to call it only after a strict
  evidence-based completion audit; calling it ends the loop deterministically.
- **Iteration safety net** — Stops after a configurable number of turns
  (default: 100) regardless of token usage, in case completion is never
  signalled.
- **Token budget** — Tracked via `ctx.getContextUsage()`. When tokens consumed
  since goal start exceed the budget, the agent is given Codex's
  `budget_limit.md` prompt asking it to wrap up cleanly without starting new
  substantive work.
- **Session persistence** — Goal state (objective, baseline tokens, iteration
  count) is written to the session log and restored on `/reload`, `/resume`,
  and `/fork`.
- **Context hygiene** — Goal-mode prompt injections, kickoff messages, and
  continuation nudges are filtered out of the LLM context when goal mode is
  off, preventing stale noise in follow-up conversations.

## How it works

The architecture mirrors Codex's `/goal`:

1. `/goal <objective>` enables goal mode, registers the `update_goal` tool
   so it appears in the agent's available tool set, and sends a kickoff
   message that triggers the first turn.
2. **Before each turn**, the extension injects one of three prompt templates
   (all copied verbatim from Codex) into the agent context, with the current
   objective and token usage substituted in:
   - **`continuation.md`** — the default. Tells the agent to keep working
     toward the requested end state, demands evidence-based completion before
     calling `update_goal`, and warns against shrinking the goal to fit
     current state.
   - **`budget_limit.md`** — injected once when the token budget is exhausted.
     Asks the agent to wrap up, summarize, and leave a clean handoff. The
     agent is explicitly told NOT to call `update_goal` just because the
     budget ran out.
   - **`objective_updated.md`** — injected on the next turn after the user
     edits the goal mid-stream. Marks the new objective as untrusted user
     input and tells the agent to abandon work that only served the old goal.
3. **After each turn**, `agent_end` deterministically decides what happens
   next:
   - If the agent called `update_goal` this turn → disable goal mode, show
     a success notification with the agent's summary.
   - Else if iterations ≥ max → disable goal mode with a "max iterations
     reached" warning.
   - Else if tokens exceeded budget AND we already delivered the budget-limit
     prompt → disable goal mode with a "budget exhausted" warning.
   - Otherwise → send a thin continue nudge with `triggerTurn: true` to start
     the next turn. The substantive instructions are in the prompt template
     `before_agent_start` will inject before the LLM call.
4. Any **interactive** user input (typing in the editor) cancels goal mode
   immediately. Extension-injected messages (kickoff, continue) and RPC
   inputs do not cancel.

There is **no separate checker model** — the working agent itself decides
completion. This avoids extra LLM cost, auth races, and stale-transcript
bugs that a post-turn evaluator suffers.

## Configuration

Create `~/.pi/agent/pi-goal.json` to customise behaviour. All fields are
optional.

```json
{
  "maxIterations": 100,
  "tokenBudget": 200000
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `maxIterations` | number | `100` | Hard safety cap on turn count. |
| `tokenBudget` | number | `200000` | Tokens consumed since goal start before `budget_limit.md` is injected. |

## Status indicator

A footer status pill `⚑ goal [N/M, X/Y t]` is shown while goal mode is active,
where `N/M` is iterations and `X/Y` is tokens used vs. budget.

## Cancellation

Goal mode ends in any of these cases:

- Agent calls `update_goal` (the happy path).
- User types interactively while goal is running.
- `/goal stop` or `Ctrl+Alt+G` while active.
- Iteration cap is hit.
- Token budget is exhausted (after one final `budget_limit.md` turn).
- Session shutdown.

## Attribution

The three goal-lifecycle prompt templates under `src/templates/goals/` are
copied verbatim from
[OpenAI Codex](https://github.com/openai/codex/tree/main/codex-rs/core/templates/goals)
and remain under the Apache License 2.0, © 2025 OpenAI. See
[`LICENSE-APACHE-2.0`](./LICENSE-APACHE-2.0), [`NOTICE`](./NOTICE), and
[`UPSTREAM.md`](./UPSTREAM.md).

The TypeScript glue code that loads the templates and runs the loop inside a
pi extension is original work, MIT licensed; see [`LICENSE`](./LICENSE).

## License

MIT for the original glue code; Apache 2.0 for the ported template files.
SPDX: `MIT AND Apache-2.0`.
