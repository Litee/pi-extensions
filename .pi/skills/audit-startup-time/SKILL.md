---
name: audit-startup-time
description: >
  Audit all registered pi extensions in this monorepo for startup time impact:
  static imports of heavy modules, synchronous filesystem I/O at registration
  time, and work that runs unconditionally on every session start. Use when
  asked to "audit startup time", "profile extension load cost", "find slow
  extensions", "check startup impact", or "/audit-startup-time".
---

# audit-startup-time

Analyse every extension package in this monorepo and report what it costs at
pi startup. The goal is a ranked table of offenders with concrete,
actionable findings — not a general TypeScript review.

## What counts as a startup cost

Only flag items that run **before the user types a single message**:

| Category | Examples |
|---|---|
| Heavy static import | `@aws-sdk/client-*`, `@sinclair/typebox`, any module ≥ 1 MB on disk |
| Sync FS I/O at registration | `existsSync`, `readdirSync`, `readFileSync`, `realpathSync`, `statSync` in module top-level or inside a synchronous default-export function |
| Async work at `session_start` | N-serial awaits (for-of + await), multiple sequential `readFile` calls, network probes |
| Full directory walk per event | `findSkillDirs`-style recursive stat loops triggered on every `resources_discover` or `session_start` |
| Repeated work on resume | Rebuilding state / re-arming timers on every `session_start` including resume, when a once-per-process cache would suffice |

Do **not** flag:
- `import type` — erased at compile time, zero runtime cost
- Dynamic `await import()` inside a lazy path
- Work inside slash-command handlers (only runs when the user invokes the command)
- Work inside the poll loop of a watcher (only runs after a watcher is started)

---

## Step 1 — Enumerate packages

```bash
ls <repo-root>/packages/
```

For each directory under `packages/`, note the package name.

---

## Step 2 — Measure module sizes

Run this from the **main checkout root** (not a worktree, which has no
`node_modules`). For the known heavy suspects:

```bash
REPO=/Volumes/workplace/external/pi-extensions
du -sh "$REPO/node_modules/@aws-sdk/client-ec2"          2>/dev/null || echo "not installed"
du -sh "$REPO/node_modules/@aws-sdk/client-glue"         2>/dev/null || echo "not installed"
du -sh "$REPO/node_modules/@aws-sdk/client-s3"           2>/dev/null || echo "not installed"
du -sh "$REPO/node_modules/@aws-sdk/credential-providers" 2>/dev/null || echo "not installed"
du -sh "$REPO/node_modules/@sinclair/typebox"            2>/dev/null || echo "not installed"
```

Note: in a hoisted monorepo `du` on a single package reports only that
package's own files — transitive deps are hoisted to the root and counted
separately. Use the figures for relative ranking, not absolute cost.

Add any other large packages surfaced during the per-package analysis below.

---

## Step 3 — Dispatch parallel sub-agents

Dispatch one `andrey-researcher` sub-agent **per package** with
`run_in_background: true`. Record each returned agent ID — you will need them
in Step 4.

Note: `andrey-researcher` is defined in this project's `AGENTS.md` and is not
available outside this repo. Do not move this skill to a global skills
directory without also making `andrey-researcher` globally available.

Note: the subagent manager runs at most 4 agents concurrently, so 29 spawns
will queue and process 4-at-a-time — not truly all-at-once.

### Discover the entry point

Before writing each sub-agent prompt, read `packages/<pkg>/package.json` and
check the `main` or `exports` field for the real entry point. Most packages
use `src/index.ts`. `pi-watcher-core` and similar library packages may have a
different structure — adapt accordingly. For library packages with no
extension entry point, the relevant startup cost is whatever is eagerly
executed when the library module is first `import`ed by a consuming extension.

### Per-sub-agent prompt template

```
Analyse the startup time impact of the pi extension (or library) in:
  <repo-root>/packages/<pkg>/

1. Read `package.json` to find the entry point (main / exports field).
   If none, use src/index.ts.
2. Read the entry point in full.
3. For each top-level import in the entry point that is NOT `import type`,
   read that imported file in full (one level deep only — do not recurse
   further unless the file is clearly a registration-time helper, e.g. a
   file whose entire purpose is to call registerExtension or similar).

Report ONLY items that incur cost before the user types a message:

1. **Static imports of heavy modules** — list every top-level
   `import ... from "..."` (non-type) whose package name appears in the
   known-heavy list (@aws-sdk/*, @sinclair/typebox) OR whose on-disk size
   is ≥ 1 MB (you will be given size figures from Step 2).
   Cite file:line for each.

2. **Sync FS I/O at registration** — list every call to existsSync,
   readdirSync, readFileSync, realpathSync, statSync that executes during
   module load or inside a synchronous default-export factory.
   Cite file:line for each.

3. **Serial async work at session_start** — list any for-of + await loops,
   sequential readFile chains, or N-RTT patterns inside session_start
   handlers. Cite file:line.

4. **Repeated work on every session_start** — flag anything that rebuilds
   state or re-reads files on every session_start including resume, when it
   could be cached after first run. Cite file:line.

If the package has none of the above, say "no startup cost found" and stop.
Do NOT suggest fixes — findings only.
```

---

## Step 4 — Collect and rank results

Collect all sub-agent results with `get_subagent_result` (agent_id: <id>,
wait: true) for each agent ID recorded in Step 3.

Produce a ranked findings table, heaviest impact first:

```
| Priority | Package | Issue | Location | Estimated impact |
|---|---|---|---|---|
| High | pi-subagents | Static import @sinclair/typebox (5.2 MB) | src/index.ts:17 | 5.2 MB parsed unconditionally |
| … | … | … | … | … |
```

Priority rules:
- **High** — static import ≥ 5 MB, or sync FS walk touching N files, or serial N-RTT loop at session_start
- **Medium** — static import 1–5 MB, or 2 sequential reads at session_start, or repeated-resume work
- **Low** — static import < 1 MB, or single cheap sync call

---

## Step 5 — Architecture note

If the findings reveal that pi's own extension loader serialises all startup
costs (each extension loads one-at-a-time), note this as an **architecture
observation** separate from the per-package table. The serial loader is in
`@earendil-works/pi-coding-agent` (not this repo) and cannot be fixed here,
but it means every per-package saving is fully additive.

---

## Gotchas

- **Follow imports one level deep only.** If `index.ts` re-exports from
  `./client.ts`, read `client.ts`. But do not recurse into every transitive
  import — you will produce noise about utility functions that never run at
  startup.
- **Distinguish registration-time from call-time.** A function defined in a
  module but only called later is not a startup cost. Only code that runs as
  a side effect of `import` or inside a synchronous registration factory
  counts.
- **`import type` is always free.** Never flag a type-only import. A line like
  `import type { Foo } from "heavy-pkg"` costs nothing at runtime even if
  `heavy-pkg` is 100 MB.
- **Dynamic `await import()` is the fix, not the problem.** If a package
  already uses `await import()` for a heavy module, mark it clean for that
  item.
- **`du` in a hoisted monorepo measures one package at a time.** `du -sh
  node_modules/@aws-sdk/credential-providers` returns ~376 K (the package
  itself); its transitive deps (another ~2–3 MB) are hoisted and counted
  separately. Use figures for relative ranking only.
- **Worktrees have no `node_modules`.** Always run `du` against the main
  checkout, not a `.worktrees/<branch>/` directory.
- **Library packages (e.g. pi-watcher-core) have no extension entry point.**
  The startup cost of a library is the cost incurred when a consuming
  extension first `import`s it. Read the library's exported entry point and
  apply the same rules.
- **Do not suggest fixes in this audit.** Findings only — fixes belong in
  separate issues filed via `use-local-skills-issue-tracker`.

---

## Related skills and tools

- `use-local-skills-issue-tracker` — file issues for each High/Medium finding
  after the user reviews the audit table.
- `andrey-researcher` — the sub-agent type dispatched per package; defined in
  this project's `AGENTS.md`.

## Historical findings (as of June 2026)

Previous audits of this repo produced the following baseline. Use this to
avoid re-reporting already-fixed items. **Do not use line numbers here as a
substitute for reading current source** — they drift; always cite fresh
file:line from the actual files.

### Fixed: lazy AWS SDK clients
`@aws-sdk/client-ec2` (25 MB), `client-glue` (7.8 MB), `client-s3` (4.3 MB)
— moved to `await import()` at first use inside each client factory.

### Fixed: glue watcher config deferral
`pi-aws-glue-watcher` `loadConfig()` deferred to `session_start`.

### Fixed: watcher-core poll loop
`pi-watcher-core` poll loop parallelised with `Promise.all`.

### Fixed: additional-system-prompt sentinel
`pi-additional-system-prompt` SENTINEL guard added to prevent double-append.

### Known remaining issues (verify line numbers against current HEAD)

| Priority | Package | Issue |
|---|---|---|
| High | pi-watcher-core | `_seedMissingBaselines` serial for-of+await at session_start |
| High | pi-subagents | Sync FS I/O at registration: `existsSync` + `readdirSync` + `readFileSync`×N + 2 settings JSON reads |
| High | pi-claude-code-skills-import | Full plugin walk on every `resources_discover`: `existsSync`+`realpathSync`+`readdirSync`+`statSync`+`readFileSync` per skill |
| Medium | pi-subagents | `@sinclair/typebox` (5.2 MB) static import at `src/index.ts:17` |
| Medium | pi-prompt-scheduler | Fully rebuilds on every `session_start` including resume: multiple `readFileSync` calls + timer re-arm |
| Architecture | pi-coding-agent (upstream) | Extension loader is fully serial — all startup costs are additive; cannot be fixed in this repo |
