# pi-sandboxed-workflows

Pi extension that loads user-authored TypeScript workflow scripts from any number
of directories listed in `~/.pi/agent/pi-sandboxed-workflows.json` and registers
each discovered file as a `/workflow:<name>` slash command. Sub-agents run inside
an OS-level sandbox (Seatbelt on macOS) by default. The package owns its own
engine — no external runtime dependency on sandcastle or anything else. Also
registers `/sandbox-workflow`, an interactive TUI for browsing discovered
workflows and inspecting past runs.

---

## Quick start

1. **Install the extension** — it ships as a workspace package in this monorepo.
   On first load it creates `~/.pi/agent/pi-sandboxed-workflows.json` with a
   default directory:

   ```json
   { "directories": ["~/.pi/agent/sandboxed-workflows"] }
   ```

   Add more directories to that file. `~` is expanded to your home directory;
   relative paths are not supported.

   > **Project-local workflows**: drop a `*.workflow.ts` file into
   > `.pi/sandboxed-workflows/` at your project root. These are discovered
   > automatically — no config edit needed. Project-local workflows shadow
   > global ones of the same name.

2. **Drop a `*.workflow.ts` file** into any configured directory. The part before
   `.workflow.ts` becomes the command suffix — `triage.workflow.ts` registers
   `/workflow:triage`. Names must match `^[a-z][a-z0-9-]*$`.

3. **Run `/reload`** after adding or removing files. Content changes to existing
   files are picked up on each invocation without a reload.

4. **Browse** with `/sandbox-workflow` to confirm every file you expect is
   discovered, and to inspect past run history.

---

## A minimal workflow

```ts
// ~/.pi/agent/sandboxed-workflows/hello.workflow.ts
import type { WorkflowContext } from "pi-sandboxed-workflows";

export default async function hello(host: WorkflowContext): Promise<void> {
  const target = host.args.trim() || "world";
  host.publishStatusUpdate({
    kind: "greeting",
    message: `Hello, ${target}!`,
    details: { target },
  });
}
```

Then in pi:

```
/workflow:hello pi
```

The `import type` is erased at runtime — `pi-sandboxed-workflows` does not need to
be installed next to your workflow files. Everything is injected via `host`.

See [`examples/hello.workflow.ts`](./examples/hello.workflow.ts) for the full
file with comments.

---

## Hello, agent

[`examples/hello-agent.workflow.ts`](./examples/hello-agent.workflow.ts) shows
two `host.runAgent` call patterns:

1. **Plain text** — ask a question, publish the answer.
2. **Structured output** — provide a JSON Schema; the framework extracts and
   validates the typed response.

Copy it to `~/.pi/agent/sandboxed-workflows/hello-agent.workflow.ts` and run:

```
/workflow:hello-agent "What is the capital of France?"
```

Prerequisites: AWS credentials reachable via `AWS_PROFILE` / `AWS_REGION`
(defaults: `dev-ai`, `us-west-2`).

---

## Plan / implement / review

[`examples/plan-implement-review.workflow.ts`](./examples/plan-implement-review.workflow.ts)
demonstrates a three-role orchestration pattern over a real git worktree:

1. **Planner** — default read-only sandbox, structured output (`Plan`). Produces
   an overview, step list, files-to-touch, and risks.
2. **Worktree** — created via `host.createWorktree`; the implementor edits files
   here. The branch is `pi-sw/<slug>-<runId>`.
3. **Implementor** — writable sandbox (`host.createSandbox({ worktreeReadonly: false })`),
   no schema. Pi handles the implementation loop internally. Must NOT commit.
4. **Reviewer** — default read-only sandbox, structured verdict (`Verdict`).
   `APPROVED` ends the loop; `REVISE` feeds issues back to the implementor.

Loop runs up to `WORKFLOW_PIR_MAX_ROUNDS` (default 3). On approval a
`.pi-summary.md` is written to the worktree. No commits, no merge, no push —
inspect, commit, or discard the worktree yourself.

See the file for the full implementation. Do not reproduce it here.

---

## WorkflowContext API reference

### Identity & lifecycle

| Field | Type | Purpose |
|---|---|---|
| `host.name` | `string` | Script basename without `.ts`. |
| `host.args` | `string` | Raw text after `/workflow:<name>`. May be empty. |
| `host.cwd` | `string` | Pi's working directory at invocation time. |
| `host.runId` | `string` | Opaque per-invocation correlation id. |
| `host.signal` | `AbortSignal` | Fires when the user cancels (Esc / Ctrl+C). |

---

### Communication

#### `host.publishStatusUpdate(event)`

```ts
host.publishStatusUpdate({ kind: string; message: string; details?: Record<string, unknown> })
```

Posts a non-LLM-triggering progress update to pi chat.

- Calls `pi.sendMessage({ customType: "pi-sandboxed-workflows:event", display: true }, { triggerTurn: false })`.
- The message lands in session history and is visible to the LLM on the next turn.
- When `kind === "error"`, also fires a `notify(message, "error")` toast so the
  failure is immediately visible without scrolling.
- Errors from `sendMessage` are swallowed — workflows never crash on UI failure.
- The framework reserves `kind` values: `started`, `completed`, `error`,
  `concurrent-rejected`.

#### `host.askUser(question)`

```ts
type Question =
  | { kind: "input";   text: string; default?: string }
  | { kind: "select";  text: string; options: readonly string[]; default?: string }
  | { kind: "confirm"; text: string; default?: boolean };

type Answer =
  | { kind: "input";   value: string }
  | { kind: "select";  value: string }
  | { kind: "confirm"; value: boolean };

host.askUser(q: Question): Promise<Answer>
```

Dispatches a single interactive question through pi's UI. Throws `WorkflowError`
when the session has no UI (`ctx.hasUI === false`). Rejects with `AbortError`
when `host.signal` fires mid-question.

> **Phase-C caveat**: the `ctx.ui` passthrough from pi's extension API is not yet
> wired for all session types. Wrap `host.askUser` in `try/catch` if you need a
> non-interactive fallback.

---

### Sub-agents

#### `host.runAgent(prompt, opts?)`

```ts
host.runAgent(prompt: string, opts?: AgentOpts): Promise<string>
host.runAgent<T>(prompt: string, opts: AgentOpts & { schema: JsonSchema }): Promise<T>
```

The single primitive for spawning sub-agents. Every call spawns the `pi` CLI
as a hermetic sub-agent (`pi --print --mode json --no-extensions --no-skills`)
inside a sandbox, driven by the in-package engine.

Pi handles the full agent loop (model calls, tool use, responses) internally,
so each `host.runAgent()` call is a single `pi` invocation — there is no outer
iteration here.

**Options:**

| Option | Default | Purpose |
|---|---|---|
| `schema` | — | JSON Schema; forces structured output + AJV validation |
| `label` | `"agent"` | Label for run history and fake sandbox keying |
| `retries` | `2` | Budget for schema validation failures + transient errors (3 total attempts) |
| `model` | `WORKFLOW_AGENT_MODEL` or pi's default | Pi `--model` value (e.g. `sonnet:high`, `openai/gpt-4o`) |
| `sandbox` | read-only srt on `host.cwd` | Override the sandbox for this call |
| `cwd` | `host.cwd` | Working directory for the sub-agent |
| `idleTimeoutSeconds` | `600` | Abort the sub-agent if it produces no stdout for this many seconds |

**Hermetic by design**: the sub-agent always runs with `--no-extensions
--no-skills`. `--no-extensions` is non-negotiable — without it the sub-agent
would re-load this very `pi-sandboxed-workflows` extension and recurse.
When a root session ID is available the framework derives a stable
`--session-id` for each sub-agent so its session is persisted by pi and
browseable via `/resume`. Without a root session ID (e.g. in unit tests)
`--no-session` is used and the run is ephemeral.

**Provider/model selection**: `--model` is omitted entirely when neither
`opts.model` nor `WORKFLOW_AGENT_MODEL` is set; pi falls back to its own
configured default provider (whichever provider has credentials in your
environment). Set `WORKFLOW_AGENT_MODEL=anthropic/claude-sonnet-4-5:high` (or
any pattern pi accepts) to force a specific model across all workflows.

**Structured output**: when `schema` is given the framework appends a tag
instruction, scans the combined stdout for the last `<pi_sw_result>…</pi_sw_result>`
block, parses it, and AJV-validates it.

**Retry budget**: schema failures and transient errors retry up to `retries`
times with exponential backoff (250 ms → 500 ms → 1 s). Hard auth / quota
errors do NOT retry.

**Default sandbox**: `noSandbox` — pi inherits the parent process's env
(provider credentials, AWS profile, etc.) and reads its own config from
`~/.pi/agent/`. `HOME` is not overridden. Workflows that need OS-level
isolation for a specific sub-agent call `host.createSandbox()` explicitly.

**Cancellation**: `host.signal` is propagated into every call. Abort kills the
underlying `pi` subprocess and throws `AbortError`.

---

### Worktrees

#### `host.createWorktree(opts)`

```ts
host.createWorktree({
  cwd: string;
  branchStrategy: BranchStrategy;
}): Promise<Worktree>
```

Creates a git worktree via `git worktree add`. Returns a `Worktree` handle:

| Property | Purpose |
|---|---|
| `worktreePath` | Absolute path to the new worktree |
| `branch` | The branch checked out in the worktree |
| `dispose()` | Remove the worktree (also `[Symbol.asyncDispose]`) |

`await using` compatible:

```ts
await using wt = await host.createWorktree({
  cwd: host.cwd,
  branchStrategy: { type: "branch", branch: "pi-sw/my-feature" },
});
await host.runAgent("implement the plan", { cwd: wt.worktreePath });
// wt.dispose() runs automatically here
```

**`BranchStrategy`** values:
- `{ type: "branch", branch: string }` — create a new branch.
- `{ type: "merge-to-head" }` — branch off HEAD, merge back when disposed.
- `{ type: "head" }` — no-op handle (no new worktree created).

---

### Sandbox factories (top-level)

The three factories sit directly on `host` — there is no `host.sandbox` namespace.

---

#### `host.createSandbox(opts?)`

**Real subprocess. Real Bedrock cost. OS-level isolation.**

Creates a sandboxed `SandboxProvider` backed by the Anthropic Sandbox Runtime
(Seatbelt on macOS; bubblewrap on Linux — currently untested). Use this for any
sub-agent that must be isolated from the host filesystem and network.

```ts
host.createSandbox({
  worktreeReadonly?: boolean;   // deny writes to worktree path (default false)
  allowedDomains?: string[];    // network domains the agent may reach
  extraAllowWrite?: string[];   // additional host paths granted write access
  extraDenyWrite?: string[];    // paths to deny writes within allowed regions
  extraDenyRead?: string[];     // paths to deny read access
  env?: Record<string, string>; // env vars merged into every sandboxed exec
}): SandboxProvider
```

The subprocess inherits the parent's env (including `AWS_PROFILE`, `AWS_REGION`,
and credentials). Workflow-supplied `env` keys are merged on top. `HOME` is
not overridden — pi still finds its config and credentials via the normal path.
Filesystem and network restrictions are enforced by Seatbelt allowlists;
write access is granted only to `/tmp`, the worktree path, and
`~/.pi/agent/sessions/`.

---

#### `host.createNoOpSandbox(opts?)`

**Real subprocess. Real Bedrock cost. No OS-level isolation.**

Runs the `pi` CLI subprocess directly on the host with no Seatbelt or
bubblewrap wrapping. The process inherits the full host filesystem and network.

```ts
host.createNoOpSandbox({
  env?: Record<string, string>;
}): SandboxProvider
```

**This is not a mock or a lightweight alternative to `createSandbox`.** It spawns
the real pi CLI, makes real LLM API calls, and can write anywhere on your
filesystem. Use it when:

- Your CI runner (Docker, Firecracker) already provides OS-level isolation and
  you do not want to nest Seatbelt inside it.
- You are debugging a sandbox-policy issue and want to confirm the agent works
  without the Seatbelt layer before re-adding it.

Do **not** use `createNoOpSandbox` in unit tests — it charges your Bedrock account
on every run. Use `createFakeSandbox` instead.

---

#### `host.createFakeSandbox(opts?)`

**No subprocess. No Bedrock cost. In-process canned responses.**

Creates a fully in-process fake sandbox whose "pi CLI" is a lookup into a
label-keyed response queue you configure in your test. Nothing is spawned, nothing
touches the filesystem, nothing calls any LLM.

```ts
const fake = host.createFakeSandbox({
  responses?: {
    [label: string]: string[];  // FIFO queue of responses per agent label
  };
}): FakeSandboxProvider

// FakeSandboxProvider extras:
fake.calls          // FakeCall[] — log of every invocation
fake.setCurrentLabel(label: string)  // side-channel for multi-turn tests
```

Use this as **the only sandbox in unit tests**. It is the only way to write fast,
hermetic, cost-free tests for workflow logic. See "Testing your workflow" below.

---

### Discovery rules

The extension scans every directory at factory load time and again on every
`/reload`. The scan list is built as follows:

1. **Project-local directory** — `<cwd>/.pi/sandboxed-workflows/` is always
   prepended automatically (no config edit required). The directory does not
   need to exist; a missing directory is silently treated as empty.
2. **Global config directories** — every path listed in
   `~/.pi/agent/pi-sandboxed-workflows.json`, in the order listed.

Because the project-local directory comes first, a workflow there **shadows** a
same-named workflow in any global directory.

A file is registered if and only if:

- its name ends with `.workflow.ts`;
- the stem (the part before `.workflow.ts`) matches `^[a-z][a-z0-9-]*$`.

Plain `.ts` files, `.d.ts` declarations, and any other extensions are ignored
silently. Duplicate names (same stem in two directories) emit a `startup-warning`
event; the first-listed directory wins.

---

## /sandbox-workflow browser

`/sandbox-workflow` opens an interactive TUI:

- **Workflow list** — every discovered workflow with its source directory.
- `↑ ↓` — navigate.
- `Esc` / `Ctrl+C` — close.

Past sub-agent sessions are persisted by pi itself (via `--session-id`) and
browseable via pi's own `/resume` command — no separate runs browser is needed.

---

## Concurrency

At most one workflow runs in a pi process at a time. A second `/workflow:<name>`
invocation while one is active receives a `concurrent-rejected` event in chat and
a toast — it does not run. Cancel the active workflow (Esc) and try again.

---

## Cancellation

Every `host.runAgent` call propagates `host.signal`. When the user cancels (Esc or
Ctrl+C), the underlying `pi` subprocess is killed and the agent call throws
`AbortError`. Use `await using` on `host.createWorktree` if you want the worktree cleaned up
automatically on scope exit (including abort):

```ts
await using wt = await host.createWorktree({ cwd: host.cwd, branchStrategy });
// wt.dispose() runs automatically here, even if host.signal fired
```

If you want the worktree to **survive** after the workflow exits (so the user
can inspect or merge it), use `const` instead — `await using` always disposes
on scope exit regardless of outcome:

```ts
const wt = await host.createWorktree({ cwd: host.cwd, branchStrategy });
// worktree persists after the workflow returns
```

---

## Authoring contract

- **Top-level must be pure**: no `console.log`, no `fetch`, no `process.exit`, no
  `await` at module scope. The framework `import()`s each file fresh per
  invocation; side effects compound.
- **Default export is `(host: WorkflowContext) => Promise<unknown>`**. Any other
  shape produces an `error` event at run time.
- **Throwing is fine**: the framework catches and publishes an `error` event; it
  does not crash pi.
- **Use `host.publishStatusUpdate` for progress** — pi's TUI paints over stdout,
  so `console.*` writes garble the screen and are not visible to the LLM.

---

## Testing your workflow

`host.createFakeSandbox` is the only way to write fast, hermetic, cost-free unit
tests for workflows that call `host.runAgent`. A sketch:

```ts
import { buildWorkflowHost } from "pi-sandboxed-workflows/src/host.js";
import { vi } from "vitest";

const host = buildWorkflowHost({
  name: "my-workflow",
  args: "do the thing",
  cwd: "/tmp/repo",
  runId: "test-run-1",
  signal: new AbortController().signal,
  sendMessage: vi.fn(),
});

// Wire a fake sandbox into the agent call via the `sandbox` option:
const fake = host.createFakeSandbox({
  responses: {
    planner: ['{"overview":"test plan","steps":[],"filesToTouch":[],"risks":[]}'],
  },
});

// Pass it to the agent:
const result = await host.runAgent("plan this", { label: "planner", sandbox: fake });
//                                                                        ^^^^^^
// No subprocess was spawned. No Bedrock call was made.
// result === the string you put in responses.planner[0]

// Assert the call was recorded:
expect(fake.calls).toHaveLength(1);
expect(fake.calls[0]?.label).toBe("planner");
```

**Do not use `createNoOpSandbox` in tests.** It spawns the real pi CLI and
charges your LLM account on every test run.

---

## Error visibility (LLM-visible vs. toast-only)

Everything the framework reports is dual-emitted:

| Channel | Reaches LLM? | Used for |
|---|---|---|
| `pi.sendMessage({ customType: "pi-sandboxed-workflows:event", display: true }, { triggerTurn: false })` | **Yes** — lands in session history, included in the next LLM prompt | All progress + error events |
| `ctx.ui.notify(message, "error")` | No — toast only | Same content, for immediate human visibility |

Framework-emitted error events (both channels):
- Default export missing or not a function.
- Workflow throws during execution (caught, re-published as `kind: "error"`).
- Concurrent invocation rejected (`kind: "concurrent-rejected"`).
- Discovery warnings for unusable filenames at startup (`kind: "startup-warning"`).

Workflow-emitted `kind: "error"` events fire on the LLM channel automatically and
also trigger a toast. Workflow authors never call `notify` directly.

---

## Run history

Sub-agent runs are persisted as pi sessions. Each sub-agent gets a stable
`--session-id` derived from the host session ID, the workflow name, the
invocation sequence number, and the agent label:

```
<rootSessionId>-<workflowName>-<runSeq>-<agentLabel>  (slugified)
```

Browse past runs with pi's built-in `/resume` command — all sub-agent sessions
appear alongside regular sessions. Retries of the same agent within one
invocation share a session ID so pi resumes from the previous context.
Two parallel or sequential invocations of the same workflow never share a
session (different `runSeq`).

---

## Examples

| File | Description |
|---|---|
| [`examples/hello.workflow.ts`](./examples/hello.workflow.ts) | Minimal sanity check — two lifecycle events, no agents, no sandboxing. |
| [`examples/hello-agent.workflow.ts`](./examples/hello-agent.workflow.ts) | Manual smoke test for `host.runAgent` — plain text and structured output. |
| [`examples/plan-implement-review.workflow.ts`](./examples/plan-implement-review.workflow.ts) | Full three-role planner → implementor → reviewer loop with git worktree. |

---

## Future work / known punts

- **`host.askUser`**: the type, dispatcher, and `AskUserFn` are all landed. The
  `ctx.ui` passthrough from pi's extension API is not yet wired for all session
  types (Phase C); wrap calls in `try/catch` for now.
- **`host.phase(name)`**: declarative phase grouping is planned for a future iteration.
- **Per-project workflow overrides**: already work — put a project-local directory
  first in `~/.pi/agent/pi-sandboxed-workflows.json`.
- **Linux `createSandbox` (bubblewrap)**: the code path exists but is untested.
- **Concurrent runs queue**: not implemented. A second run is rejected outright;
  a queue / multiplex is a follow-up.
