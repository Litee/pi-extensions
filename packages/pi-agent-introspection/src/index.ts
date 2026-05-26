import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionDebugInfoTool } from "./tool.js";
import { registerCommandsTool } from "./commandsTool.js";

export default function (pi: ExtensionAPI): void {
	registerSessionDebugInfoTool(pi);
	registerCommandsTool(pi);

	// Both introspection tools are off by default so they don't clutter the
	// active tool set on every session.  The agent (or user) can re-enable them
	// at any time via the manage_tools tool.
	pi.on("session_start", (_event, _ctx) => {
		pi.setActiveTools(
			pi.getActiveTools().filter(
				(t) => t !== "get_session_debug_info" && t !== "inspect_commands",
			),
		);
	});
}
