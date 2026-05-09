/**
 * Pure classifier for `/recap` subcommand args. Extracted from `index.ts`
 * so the dispatch decision table can be unit-tested without standing up
 * a pi runtime or a fake `ExtensionContext`.
 */

export type RecapSubcommand =
	| { kind: "generate" }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "unknown"; payload: string };

/**
 * Classify the `args` string passed to the `/recap` command handler.
 *
 * Normalisation: leading/trailing whitespace is trimmed and the token is
 * lower-cased so `  STATUS  ` still dispatches to `status`.
 */
export function dispatchRecap(args: string): RecapSubcommand {
	const sub = args.trim().toLowerCase();
	if (sub === "") return { kind: "generate" };
	if (sub === "status") return { kind: "status" };
	if (sub === "help") return { kind: "help" };
	return { kind: "unknown", payload: sub };
}
