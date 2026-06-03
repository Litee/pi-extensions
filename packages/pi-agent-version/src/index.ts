/**
 * pi-version — pi extension.
 *
 * Registers a `/version` slash command that prints the running
 * @earendil-works/pi-coding-agent version to the chat UI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Walk ancestor directories of `startDir`, reading each `package.json` via
 * the supplied `readFile` callback, and return the `version` field of the
 * first manifest whose `name` matches `packageName`.
 *
 * Returns `"unknown"` if the root is reached without a match.
 *
 * Exported for unit testing (inject a fake `readFile` instead of the real FS).
 */
export function findVersionInAncestors(
	startDir: string,
	packageName: string,
	readFile: (path: string) => string,
): string {
	let dir = startDir;
	while (true) {
		const candidate = join(dir, "package.json");
		try {
			const pkg = JSON.parse(readFile(candidate)) as {
				name?: string;
				version?: string;
			};
			if (pkg.name === packageName) {
				return pkg.version ?? "unknown";
			}
		} catch {
			// not a valid/present package.json at this level — keep walking
		}
		const parent = dirname(dir);
		if (parent === dir) return "unknown";
		dir = parent;
	}
}

function readAgentVersion(): string {
	// Resolve the package entry point, then walk up to find its package.json.
	// (The package's "exports" field blocks direct ./package.json imports.)
	const entryPath = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	return findVersionInAncestors(
		dirname(entryPath),
		"@earendil-works/pi-coding-agent",
		(p) => readFileSync(p, "utf8"),
	);
}

export default function versionExtension(pi: ExtensionAPI): void {
	pi.registerCommand("version", {
		description: "Print the current version of the pi coding agent.",
		// eslint-disable-next-line @typescript-eslint/require-await
		handler: async (_args, ctx) => {
			const version = readAgentVersion();
			ctx.ui.notify(`pi-coding-agent v${version}`, "info");
		},
	});
}
