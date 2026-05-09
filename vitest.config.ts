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
				// TUI pickers are integration code that needs a live pi-tui runtime;
				// logic that can be unit-tested lives in index.ts (handleCcSkills).
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
				"**/namesCompletion.ts",
				// pi-skills-browser/index.ts is TUI wiring: a /skills command handler
				// that builds a custom component via ctx.ui.custom. All pure logic
				// (token estimation, filtering, sorting) lives in helpers.ts and is
				// fully covered there.
				"**/pi-skills-browser/src/index.ts",
				// pi-claude-code-skills-import/src/index.ts: session_start handler
				// + cc-skills-info command registration. All testable logic
				// (handleCcSkills, discovery, collisions) is exported and fully
				// covered in the dedicated test files.
				"**/pi-claude-code-skills-import/src/index.ts",
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
				// setActiveTools orchestration, copied verbatim (minus a handful
				// of strict-tsconfig patches) from the upstream pi-mono example.
				// All pure logic (allow/deny lists, plan extraction, [DONE:n]
				// tracking) lives in utils.ts and is covered there.
				"**/pi-plan-mode/src/index.ts",
				// pi-context-window-analysis/index.ts is lifecycle wiring +
				// command registration + widget update calls. All pure logic
				// (token estimation, breakdown, rendering) lives in breakdown.ts
				// and render.ts and is fully covered there.
				"**/pi-context-window-analysis/src/index.ts",
				// pi-built-in-tool-renderer/index.ts is a set of Text-returning
				// renderCall / renderResult overrides for the four built-in tools,
				// copied verbatim from the upstream pi-mono example. Exercising
				// the renderers requires a live theme + tool runtime; the smoke
				// test in test/index.test.ts confirms the wiring is intact.
				"**/pi-built-in-tool-renderer/src/index.ts",
				// pi-btw/src/index.ts is a copy of dbachelder/pi-btw's extensions/btw.ts
				// (MIT, © Dan Bachelder). The file is end-to-end TUI wiring:
				// overlay rendering, slash-command dispatch, focus/keybinding
				// handling, sub-session lifecycle orchestration, and error toasts.
				// The 50-test btw.runtime.test.ts suite exercises the business
				// logic against mocked sessions as far as possible without a
				// live pi-tui runtime; the remaining branches (overlay render
				// paths, focus refresh, toast paths) cannot be unit-tested.
				"**/pi-btw/src/index.ts",
			],
			reporter: ["text", "html"],
			// Fail the suite (non-zero exit) when any threshold is not met.
			thresholds: {
				lines: 90,
				statements: 90,
				functions: 90,
				branches: 90,
			},
		},
	},
});
