import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { discoverCommandDirs } from "./discover.js";
import { resolveClaudeDir } from "./resolve.js";

/** Pi extension default export. */
export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", (event, ctx) => {
		const claudeDir = resolveClaudeDir(process.env, homedir());
		const promptPaths = discoverCommandDirs({
			claudeDir,
			// Project-local commands come from the current repository; only
			// import them into trusted sessions. User-level commands need no
			// trust. Mirrors pi's own gating of project resources.
			...(ctx.isProjectTrusted() ? { cwd: event.cwd } : {}),
		});
		return { promptPaths };
	});
}

export { discoverCommandDirs } from "./discover.js";
export { resolveClaudeDir } from "./resolve.js";
