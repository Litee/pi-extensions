// ESLint 9 flat config — single-purpose: ban `console.*` in packages/**.
//
// WHY THIS RULE EXISTS
// --------------------
// These packages run as pi (pi-coding-agent) extensions. pi's TUI paints
// directly to stdout, so any stray `console.log` / `console.error` / etc.
// corrupts the live render. In non-interactive modes pi installs an output
// guard that rewrites `process.stdout.write` to stderr — meaning `console.*`
// output either garbles the TUI or vanishes unread. Either way it is strictly
// wrong in runtime code.
//
// CORRECT REPLACEMENTS (one-liner)
// --------------------------------
//   internal diagnostic log  -> pi.appendEntry(customType, data)
//   user-visible notification -> pi.sendMessage(...)
//   pass-through callback     -> accept onError?: (err: unknown) => void in deps
//
// ESCAPE HATCHES ARE FORBIDDEN BY POLICY
// --------------------------------------
// There is no legitimate reason to call `console.*` from runtime or test code
// in this monorepo. Human review will reject eslint-disable comments.
//
// SCOPE
// -----
// Applies to every .ts file under packages/**. Build artefacts, coverage,
// node_modules, the tmp/ scratch area, and nested worktrees are ignored.

import tseslint from "typescript-eslint";

export default [
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
	{
		files: ["packages/**/*.ts"],
		linterOptions: {
			reportUnusedDisableDirectives: "off",
		},
		languageOptions: {
			parser: tseslint.parser,
			ecmaVersion: "latest",
			sourceType: "module",
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		rules: {
			"no-console": ["error"],
		},
	},
];
