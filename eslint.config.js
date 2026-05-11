// ESLint 9 flat config — type-checked recommended rules + ban `console.*`.
//
// WHY `no-console` EXISTS
// -----------------------
// These packages run as pi (pi-coding-agent) extensions. pi's TUI paints
// directly to stdout, so any stray `console.log` / `console.error` / etc.
// corrupts the live render. In non-interactive modes pi installs an output
// guard (`dist/core/output-guard.js`) that rewrites `process.stdout.write`
// to stderr — meaning `console.*` output either garbles the TUI or vanishes
// unread. Either way it is strictly wrong in runtime code.
//
// FULL POLICY
// -----------
// See the top-level AGENTS.md § "Logging: no console.* in runtime code".
// This config mechanises that rule; the prose there is authoritative.
//
// CORRECT REPLACEMENTS (one-liner)
// --------------------------------
//   user-visible notification  -> ctx.ui.notify(...)
//   persist entry to pi log    -> pi.appendEntry(...)
//   send message to the agent  -> pi.sendMessage(...)
//
// ESCAPE HATCHES ARE FORBIDDEN BY POLICY
// --------------------------------------
// ESLint itself cannot stop you from writing `// eslint-disable-next-line
// no-console` in `packages/*/src/**` or `packages/*/test/**` — but human
// review WILL reject such disables. There is no legitimate reason to call
// `console.*` from runtime or test code in this monorepo.
//
// SCOPE
// -----
// Applies to every `.ts` file under `packages/**`. Build artefacts,
// coverage, node_modules, the tmp/ scratch area, and nested worktrees are
// ignored.
//
// DESIGN NOTES
// ------------
// - Flat config only (ESLint 9+). No `.eslintrc*`.
// - Spreads `tseslint.configs.recommendedTypeChecked` so all type-aware
//   @typescript-eslint recommended rules are active. Type checking is
//   enabled via `parserOptions.projectService: true`, which delegates to
//   the TypeScript Language Service rather than a manually specified
//   `parserOptions.project` path. This is the TS-ESLint v8 recommended
//   approach: it is incremental, caches per-file types, and is
//   significantly faster than the old `project: ["./tsconfig.json"]` style.
// - `tsconfigRootDir: import.meta.dirname` anchors tsconfig lookup to the
//   repo root so every package's tsconfig.json is discoverable.
// - `no-console` is added on top of the recommended set.

import tseslint from "typescript-eslint";

export default tseslint.config(
	// Global ignores — keep build artefacts and worktrees out of linting.
	{
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"**/build/**",
			"**/coverage/**",
			".worktrees/**",
			"tmp/**",
			"packages/*/build/**",
			"packages/*/dist/**",
		],
	},

	// Type-checked recommended rules for all @typescript-eslint/* rules.
	// The spread wires in the parser, plugin, and rule set automatically.
	...tseslint.configs.recommendedTypeChecked,

	// Per-file overrides: enable the TypeScript Language Service and add
	// the no-console enforcement on top of the recommended base.
	{
		files: ["packages/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Default (no `allow`) errors on every `console.*` member:
			// log, info, warn, error, debug, trace, dir, table, group, ...
			"no-console": ["error"],

			// ── Deferred: any-flood (pi packages lack type declarations) ───────────────
			"@typescript-eslint/no-unsafe-member-access":        "off", //  356 violations
			"@typescript-eslint/no-unsafe-assignment":           "off", //  178 violations
			"@typescript-eslint/no-unsafe-call":                 "off", //  158 violations
			"@typescript-eslint/no-explicit-any":                "off", //  155 violations
			"@typescript-eslint/no-unsafe-argument":             "off", //   68 violations
			"@typescript-eslint/no-unsafe-return":               "off", //   42 violations

			// ── Deferred: medium complexity ───────────────────────────────────────────
			"@typescript-eslint/require-await":                  "off", //   89 violations
			"@typescript-eslint/unbound-method":                 "off", //   10 violations

			// ── Deferred: easy/auto-fixable (Wave 2) ─────────────────────────────────
			"@typescript-eslint/no-unnecessary-type-assertion":  "off", //   83 violations
			"@typescript-eslint/no-unused-vars":                 "off", //   24 violations
			"@typescript-eslint/no-redundant-type-constituents": "off", //   18 violations
		},
	},
);
