/**
 * Pure classifier for `/recap` subcommand args. Extracted from `index.ts`
 * so the dispatch decision table can be unit-tested without standing up
 * a pi runtime or a fake `ExtensionContext`.
 *
 * `/recap` itself only generates a recap. Configuration and the
 * idle-timeout override live behind the dedicated `/recap-settings`
 * TUI command — there are no `/recap` subcommands today.
 */

export type RecapSubcommand =
	| { kind: "generate" }
	| { kind: "unknown"; payload: string };

/**
 * Classify the `args` string passed to the `/recap` command handler.
 *
 * Empty / whitespace-only input dispatches to `generate`; anything else
 * is `unknown` (case- and whitespace-normalised for the toast message).
 */
export function dispatchRecap(args: string): RecapSubcommand {
	const sub = args.trim().toLowerCase();
	if (sub === "") return { kind: "generate" };
	return { kind: "unknown", payload: sub };
}
