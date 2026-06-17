import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { discoverCommandDirs } from "./discover.js";
import { resolveClaudeDir } from "./resolve.js";

/** Pi extension default export. */
export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", (event, _ctx) => {
		const claudeDir = resolveClaudeDir(process.env, homedir());
		const promptPaths = discoverCommandDirs({ claudeDir, cwd: event.cwd });
		return { promptPaths };
	});
}

export { discoverCommandDirs } from "./discover.js";
export { resolveClaudeDir } from "./resolve.js";
