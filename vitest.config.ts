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
			exclude: ["**/*.test.ts", "**/*.d.ts"],
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
