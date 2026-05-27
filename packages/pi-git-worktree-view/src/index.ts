/**
 * pi-git-worktree-view — extension entry point.
 *
 * On session_start:
 *   • Reads the previously saved port from session state (if any).
 *   • Starts the HTTP server, trying to bind to the saved port first.
 *   • Persists the actual bound port back into session state.
 *   • Prints the URL as a session message.
 *
 * On session_shutdown:
 *   • Calls close() to tear down the HTTP server.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startServer } from "./server.js";
import type { ServerHandle } from "./server.js";

const ENTRY_TYPE = "git-worktree-view:port";

export default function (pi: ExtensionAPI): void {
	let handle: ServerHandle | null = null;

	pi.on("session_start", async (_event, ctx) => {
		// Read last-used port from session entries
		let preferredPort = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const port = (entry.data as { port?: unknown }).port;
				if (typeof port === "number") preferredPort = port;
			}
		}

		try {
			handle = await startServer(ctx.cwd, preferredPort);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.sendMessage({
				customType: "git-worktree-view",
				content: `[pi-git-worktree-view] Failed to start server: ${msg}`,
				display: true,
			});
			return;
		}

		// Persist the bound port for the next reload
		pi.appendEntry(ENTRY_TYPE, { port: handle.port });

		pi.sendMessage({
			customType: "git-worktree-view",
			content: `Git worktree view → http://localhost:${handle.port}`,
			display: true,
		});
	});

	pi.on("session_shutdown", () => {
		if (handle) {
			try { handle.close(); } catch { /* ignore */ }
			handle = null;
		}
	});
}
