import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts"],
		// Each extension is self-contained; run their tests in parallel by default.
		pool: "threads",
		coverage: {
			provider: "v8",
			// Measure only first-party source, not fixtures, tests, or configs.
			include: ["packages/*/src/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/*.d.ts",
				// Type-only declaration files contribute no runtime code to exercise.
				"**/types.ts",
				// pi-claude-code-skills-import/src/tuiPicker.ts: live
				// pi-tui + ctx.ui.custom wiring. The pure colour-decision
				// helper (decoratePickerValue) has been extracted to
				// pickerValue.ts and is fully covered there.
				"**/tuiPicker.ts",
				// TUI-backed `/local-issue-watcher-info` picker — integration
				// code that needs a live pi-tui runtime. Pure orchestration
				// lives in infoHandler.ts and is fully covered there.
				"**/infoTui.ts",
				// TUI dialog is integration glue for pi-tui; the state machine that
				// drives it lives in controller.ts and is fully covered there.
				"**/dialog.ts",
				// Thin `spawn("cmux", …)` shims; the rest of cmux.ts in each
				// cmux-facing package is pure argv builders + dispatch and is
				// fully covered.
				"**/cmuxSpawner.ts",
				// Thin `exec("aws glue …")` shim — cannot be meaningfully
				// unit-tested without running the real AWS CLI. All logic is
				// driven through the injected GlueClient interface instead.
				"**/pi-aws-glue-watcher/src/cli-client.ts",
				// Thin `completeSimple(...)` shim; the orchestration in names.ts
				// is exercised through an injectable completion hook.
				"**/namesCompletion.ts",
				// pi-additional-system-prompt/index.ts reads PROMPT.md and
				// appends it to the system prompt via before_agent_start.
				// Pure lifecycle wiring; no testable logic beyond what the
				// PROMPT.md content itself provides.
				"**/pi-additional-system-prompt/src/index.ts",
				// pi-thinking-level-control/index.ts registers two keyboard
				// shortcuts (ctrl+] / ctrl+[) via pi.registerShortcut. The
				// shortcut handler logic is fully covered by the test suite;
				// the wiring itself requires a live pi-tui runtime.
				"**/pi-thinking-level-control/src/index.ts",
				// pi-skills-browser/src/index.ts is the TUI shell that wires
				// ctx.ui.custom(...) to the pure viewport.ts / row.ts / keys.ts
				// modules (all 100% covered). Exercising the shell requires a
				// live pi-tui runtime.
				"**/pi-skills-browser/src/index.ts",
				// pi-tools/src/index.ts is the TUI shell that wires
				// ctx.ui.custom(...) to the pure branchState.ts / completions.ts
				// / renderToolMarkdown.ts / rows.ts modules (all 100% covered).
				// Exercising the shell requires a live pi-tui runtime.
				"**/pi-tools/src/index.ts",
				// pi-aws-glue-watcher/src/ui/watches-view.ts and glue-widget.ts
				// are Container + DynamicBorder shells that wire the pure
				// watchesModel.ts / watchesKeys.ts / widgetRows.ts modules
				// (all 100% covered). Exercising the shells requires a live
				// pi-tui runtime.
				"**/pi-aws-glue-watcher/src/ui/watches-view.ts",
				"**/pi-aws-glue-watcher/src/ui/glue-widget.ts",
				// setActiveTools orchestration, copied verbatim (minus a handful
				// of strict-tsconfig patches) from the upstream pi-mono example.
				// All pure logic (allow/deny lists, plan extraction, [DONE:n]
				// tracking) lives in utils.ts and is covered there.
				// pi-btw/src/index.ts is a copy of dbachelder/pi-btw's extensions/btw.ts
				// (MIT, © Dan Bachelder). The file is end-to-end TUI wiring:
				// overlay rendering, slash-command dispatch, focus/keybinding
				// handling, sub-session lifecycle orchestration, and error toasts.
				// The 50-test btw.runtime.test.ts suite exercises the business
				// logic against mocked sessions as far as possible without a
				// live pi-tui runtime; the remaining branches (overlay render
				// paths, focus refresh, toast paths) cannot be unit-tested.
				"**/pi-btw/src/index.ts",
				// pi-built-in-tool-renderer/src/index.ts is pure TUI-wiring glue
				// after the helpers.ts / renderers.ts extraction: seven
				// `pi.registerTool({renderCall, renderResult})` calls whose
				// callbacks only fire inside a live pi runtime. All pure logic
				// (formatDuration, countLines, describeBashFailure, tickBashTimer,
				// renderRead/Bash/Edit/Write/Grep/Ls/Find) lives in helpers.ts +
				// renderers.ts and is 100% covered there.
				"**/pi-built-in-tool-renderer/src/index.ts",
				// pi-prompt-scheduler/index.ts is lifecycle wiring:
				// session_start / session_shutdown + a `/schedule-prompt` command
				// that calls ctx.ui.select / ctx.ui.custom. All pure logic
				// (validation, persistence, jobs-view state machine, tool actions)
				// is exported from scheduler.ts / storage.ts / settings.ts /
				// tool.ts / ui/jobs-view.ts and covered there.
				"**/pi-prompt-scheduler/src/index.ts",
				// pi-prompt-scheduler/subagent.ts spawns an in-process
				// AgentSession via pi-coding-agent to run a scheduled prompt in
				// a fresh model context. Cannot be exercised without live
				// pi-agent-core plumbing + a provider API key; resolveModel and
				// the runner are exercised end-to-end through the scheduler's
				// subagent firing path in manual QA.
				"**/pi-prompt-scheduler/src/subagent.ts",
				// pi-prompt-scheduler/ui/cron-widget.ts is the live
				// below-the-editor status widget. Rendering depends on
				// pi-coding-agent's DynamicBorder + a running TUI loop; the
				// pure helpers (formatISOShort, humanizeCron) it reads from
				// live in scheduler.ts and are covered there.
				"**/pi-prompt-scheduler/src/ui/cron-widget.ts",
				// pi-goal/src/index.ts is lifecycle wiring: pi.on() event
				// subscriptions, pi.registerCommand(), pi.registerShortcut(),
				// and session_start restore logic, all of which require a live
				// pi-coding-agent runtime. The pure logic (checker, helpers,
				// prompt, state) is 100% covered by the other four test files.
				"**/pi-goal/src/index.ts",
				// pi-custom-compaction/src/index.ts is the top-level wiring entry
				// point: it creates the runtime services then calls registerCommands
				// and registerEvents. All three callees are tested or excluded
				// separately; the three-line wrapper itself requires a live
				// pi-coding-agent runtime.
				"**/pi-custom-compaction/src/index.ts",
				// pi-custom-compaction/src/commands/register-commands.ts wires
				// pi.registerCommand() for /compact-policy and /compact-now.
				// The helper formatters (formatModels, formatTrigger) are exercised
				// indirectly via the policy tests; the command handlers themselves
				// call ctx.ui.notify and ctx.compact which require a live runtime.
				"**/pi-custom-compaction/src/commands/register-commands.ts",
				// pi-custom-compaction/src/events/register-events.ts wires pi.on()
				// for agent_end, session_before_compact, session_compact,
				// session_start, session_tree, and session_shutdown. The
				// session_before_compact retention-fallback path is covered in
				// events.test.ts; the remaining branches (custom compaction,
				// model/API-key resolution, template paths) require a live model
				// API and session event flow that cannot be exercised in unit tests.
				"**/pi-custom-compaction/src/events/register-events.ts",
				// pi-custom-compaction/src/runtime/session-state.ts is a closure
				// factory (createRuntimeServices). Its inner helpers
				// (showCompactionWidget, hideCompactionWidget, updateStatus,
				// triggerCompaction) call ctx.ui.setWidget, ctx.ui.setStatus, and
				// ctx.compact which all require a live pi-tui runtime. The
				// orchestration paths are exercised end-to-end through
				// events.test.ts; the widget/status branches cannot be reached
				// without a real TUI session.
				"**/pi-custom-compaction/src/runtime/session-state.ts",
				// pi-file-system-watcher/src/index.ts is the lifecycle wiring entry
				// point: it calls pi.on(session_start/turn_end/session_shutdown),
				// pi.registerMessageRenderer(), and pi.registerCommand(). All
				// pure logic (registerToolIfNeeded, rehydrateStateFromSession,
				// setupWatchFs, pollOnce, refreshStatus, runFsWatcherCommand) is
				// exported from their respective modules and covered there. The
				// lifecycle wiring itself requires a live pi-coding-agent runtime.
				"**/pi-file-system-watcher/src/index.ts",
			],
			// `json-summary` makes the coverage output machine-readable so CI or
			// review tooling (e.g. gh-action coverage comments, pi-session-recap
			// summaries) can consume it without parsing HTML. `html` kept for
			// local drill-down.
			reporter: ["text", "html", "json-summary"],
			// Fail the suite (non-zero exit) when any threshold is not met.
			//
			// Branches and functions are below the 90% target because of
			// pre-existing untested code in scanner.ts, settings.ts,
			// persistence.ts, renderer.ts, archon-client.ts, and glue-client.ts.
			// These gaps pre-date the current threshold enforcement. Raise each
			// number as the corresponding files gain coverage.
			// Thresholds calibrated against @vitest/coverage-v8 v4. v4 counts
			// functions (arrow callbacks, short-lived closures) more aggressively
			// than v2 did. Re-raise once the flagged files are tightened.
			thresholds: {
				lines: 90,
				statements: 90,
				functions: 90,
				branches: 90,
			},
		},
	},
});
