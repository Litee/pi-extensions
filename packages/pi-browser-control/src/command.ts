/**
 * /browser-control command handler.
 *
 * Menu items:
 *   Status                              — show daemon + add-on status
 *   Test connection                     — test daemon/add-on connectivity
 *   Install Firefox native-messaging manifest — write the NM manifest + launcher
 *   [extraItems…]                       — optional caller-injected items
 *   Close
 *
 * All deps are injected so the handler is fully unit-testable.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtraMenuItem {
	label: string;
	handler: () => Promise<void>;
}

export interface BrowserControlCommandDeps {
	getStatus: () => Promise<{
		daemon: { pid: number; uptimeSec: number; version: string };
		addon: { connected: boolean; lastSeenSec: number | null };
	}>;
	testConnection: () => Promise<{ ok: boolean; message: string }>;
	installManifest: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
	extraItems?: ExtraMenuItem[];
}

// ---------------------------------------------------------------------------
// runBrowserControlCommand
// ---------------------------------------------------------------------------

export async function runBrowserControlCommand(
	ctx: ExtensionCommandContext,
	deps: BrowserControlCommandDeps,
): Promise<void> {
	const ITEM_STATUS = "Status";
	const ITEM_TEST = "Test connection";
	const ITEM_INSTALL = "Install Firefox native-messaging manifest";
	const ITEM_CLOSE = "Close";

	while (true) {
		const extraLabels = (deps.extraItems ?? []).map((e) => e.label);

		const choice = await ctx.ui.select("Browser Control", [
			ITEM_STATUS,
			ITEM_TEST,
			ITEM_INSTALL,
			...extraLabels,
			ITEM_CLOSE,
		]);

		if (!choice || choice === ITEM_CLOSE) return;

		if (choice === ITEM_STATUS) {
			ctx.ui.notify("Checking status…", "info");
			try {
				const s = await deps.getStatus();
				const addonStatus = s.addon.connected
					? "connected"
					: "disconnected";
				ctx.ui.notify(
					`Daemon: PID ${s.daemon.pid}, up ${s.daemon.uptimeSec}s, v${s.daemon.version} | Add-on: ${addonStatus}`,
					"info",
				);
			} catch (err: unknown) {
				const e = err as { code?: string; message?: string };
				if (e.code === "DAEMON_NOT_RUNNING") {
					ctx.ui.notify(
						"Daemon not running. Start Firefox with the pi-browser-control add-on loaded, then run 'Install Firefox native-messaging manifest' below.",
						"error",
					);
				} else {
					ctx.ui.notify(
						`Status error: ${e.message ?? String(err)}`,
						"error",
					);
				}
			}
		} else if (choice === ITEM_TEST) {
			ctx.ui.notify("Testing connection…", "info");
			const r = await deps.testConnection();
			ctx.ui.notify(r.message, r.ok ? "info" : "error");
		} else if (choice === ITEM_INSTALL) {
			ctx.ui.notify("Installing…", "info");
			const r = await deps.installManifest();
			if (r.ok) {
				ctx.ui.notify(`Native-messaging manifest installed to ${r.path}`, "info");
			} else {
				ctx.ui.notify(`Install failed: ${r.error}`, "error");
			}
		} else {
			// Extra items
			const item = (deps.extraItems ?? []).find((e) => e.label === choice);
			if (item) {
				await item.handler();
			}
		}
	}
}
