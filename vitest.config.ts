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
				// Thin `completeSimple(...)` shim; the orchestration in names.ts
				// is exercised through an injectable completion hook.
				"**/namesCompletion.ts",
				"**/namesCompletion.ts",
				// session-recap/index.ts is lifecycle wiring + a pi-ai model call
				// + a raw stdin focus-event listener. All logic worth testing is
				// factored into helpers.ts and covered there.
				"**/pi-session-recap/src/index.ts",
				// pi-tool-info/index.ts is pure TUI glue: a /tool-info command
				// handler that calls ctx.ui.select, ctx.ui.custom, and renders a
				// Markdown modal. All logic worth testing (truncate, formatTokens,
				// estimateToolTokens, sourceLabel) lives in helpers.ts.
				"**/pi-tool-info/src/index.ts",
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
