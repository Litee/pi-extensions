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
	buildAddon?: () => Promise<{ ok: true; xpiPath: string } | { ok: false; error: string }>;
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
	const ITEM_BUILD = "Build & install XPI (permanent add-on)";
	const ITEM_CLOSE = "Close";

	while (true) {
		const extraLabels = (deps.extraItems ?? []).map((e) => e.label);

		const choice = await ctx.ui.select("Browser Control", [
			ITEM_STATUS,
			ITEM_TEST,
			ITEM_INSTALL,
			...(deps.buildAddon ? [ITEM_BUILD] : []),
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
		} else if (choice === ITEM_BUILD && deps.buildAddon) {
			ctx.ui.notify("Building XPI with web-ext…", "info");
			const r = await deps.buildAddon();
			if (r.ok) {
				ctx.ui.notify(
					`XPI built: ${r.xpiPath}\n\nTo install permanently:\n\nRequires Firefox ESR, Developer Edition, or Nightly (standard Firefox blocks unsigned add-ons).\n\n1. Open about:config → set xpinstall.signatures.required = false\n2. Open about:addons → gear icon → Install Add-on From File → select the XPI above\n3. The add-on will now survive Firefox restarts.`,
					"info",
				);
			} else {
				ctx.ui.notify(`Build failed: ${r.error}`, "error");
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
