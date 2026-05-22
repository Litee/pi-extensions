/**
 * Pure, dependency-free computation of the next active-tool set.
 *
 * Split out from index.ts so it can be unit-tested without faking the pi
 * ExtensionAPI. Every helper here is a pure function of its inputs.
 */

export type Action = "list" | "activate" | "deactivate" | "reset";

export interface ComputeInputs {
	action: Action;
	tools?: readonly string[];
	currentActive: ReadonlySet<string>;
	startupActive: ReadonlySet<string>;
	knownTools: ReadonlySet<string>;
	protectedTools: ReadonlySet<string>;
}

export interface ComputeResult {
	/** New active set. Undefined means "no change" (e.g. for action:"list"). */
	nextActive?: Set<string>;
	/** Requested names that aren't in `knownTools`. Silently dropped. */
	ignoredUnknown: string[];
	/** Requested names that couldn't be deactivated because they are protected. */
	ignoredProtected: string[];
}

/**
 * Partition `requested` into known/unknown relative to `knownTools`.
 * Preserves order of first appearance and dedupes.
 */
function partitionKnown(
	requested: readonly string[] | undefined,
	knownTools: ReadonlySet<string>,
): { known: string[]; unknown: string[] } {
	const known: string[] = [];
	const unknown: string[] = [];
	const seen = new Set<string>();
	for (const name of requested ?? []) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (knownTools.has(name)) known.push(name);
		else unknown.push(name);
	}
	return { known, unknown };
}

export function computeNext(input: ComputeInputs): ComputeResult {
	const { action, tools, currentActive, startupActive, knownTools, protectedTools } = input;

	switch (action) {
		case "list":
			return { ignoredUnknown: [], ignoredProtected: [] };

		case "activate": {
			const { known, unknown } = partitionKnown(tools, knownTools);
			const next = new Set(currentActive);
			for (const name of known) next.add(name);
			return { nextActive: next, ignoredUnknown: unknown, ignoredProtected: [] };
		}

		case "deactivate": {
			const { known, unknown } = partitionKnown(tools, knownTools);
			const next = new Set(currentActive);
			const refused: string[] = [];
			for (const name of known) {
				if (protectedTools.has(name)) {
					refused.push(name);
					continue;
				}
				next.delete(name);
			}
			return { nextActive: next, ignoredUnknown: unknown, ignoredProtected: refused };
		}

		case "reset": {
			const next = new Set(startupActive);
			// Protected names must always be active so the LLM can never get stuck.
			for (const name of protectedTools) next.add(name);
			return { nextActive: next, ignoredUnknown: [], ignoredProtected: [] };
		}
	}
}
