/**
 * Pi extension entry: register `browser_list_tabs` and `browser_get_tab_content`.
 *
 * Both tools communicate with the Firefox pi-browser-control add-on through a
 * shared daemon process via a unix socket. The daemon is launched by Firefox
 * via the native-messaging protocol.
 *
 * Architecture:
 *   Firefox add-on ── native messaging ──▶ Node daemon
 *                                           │ unix socket
 *   pi session A/B/C ─── ~/.pi/agent/pi-browser-control.sock ──┘
 *
 * Setup (one-time):
 *   1. Load firefox-addon/ in Firefox via about:debugging
 *   2. Run /browser-control → Install Firefox native-messaging manifest
 *   3. Verify with /browser-control → Test connection
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { SocketClient, SocketClientError, type SocketClientLike } from "./socket-client.js";
import { runBrowserControlCommand } from "./command.js";
import { installManifest } from "./manifest-installer.js";
import { installLauncher } from "./launcher-installer.js";
import { launcherPath } from "./socket-paths.js";
import {
	buildListTabsResult,
	buildTabContentResult,
	type BrowserTab,
	type TabContentData,
} from "./tool-format.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Re-export SocketClientLike so tests can import it from index.js
export type { SocketClientLike };

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

const ListTabsParamsSchema = Type.Object({
	offset: Type.Integer({
		minimum: 0,
		default: 0,
		description: "Starting index for pagination (0-based, must be >= 0).",
	}),
	limit: Type.Number({
		default: 100,
		description: "Maximum number of tabs to return (default 100, capped 1–500).",
	}),
});
type TListTabsParams = Static<typeof ListTabsParamsSchema>;

const GetTabContentParamsSchema = Type.Object({
	tabId: Type.Number({
		description: "The numeric tab ID as returned by browser_list_tabs.",
	}),
	offset: Type.Number({
		default: 0,
		description:
			"Character offset for paginating large documents. Pass 0 (default) for the first read.",
	}),
});
type TGetTabContentParams = Static<typeof GetTabContentParamsSchema>;

// ---------------------------------------------------------------------------
// Dependency-injection interface for tests
// ---------------------------------------------------------------------------

export interface BrowserControlOptions {
	/** Pre-built socket client (for tests). Overrides default SocketClient. */
	socketClient?: SocketClientLike;
	/** Override agent directory for path helpers (for tests). */
	agentDir?: string;
	/**
	 * Override the native-messaging manifest output path (for tests ONLY).
	 * In production this is undefined and the manifest is written to the
	 * fixed Firefox location; tests MUST set this to a temp path so the suite
	 * never writes to the real ~/Library/.../NativeMessagingHosts location.
	 */
	manifestPath?: string;
	/**
	 * Register the browser_get_tab_content tool. Disabled by default: content
	 * extraction via executeScript can hang indefinitely on streaming/SPA tabs
	 * (e.g. perplexity.ai, feedly.com) that never reach an idle load state, so
	 * the tool is withheld from the agent until that is fixed. Tests opt in.
	 */
	enableGetTabContent?: boolean;
}

// ---------------------------------------------------------------------------
// Error result builders
// ---------------------------------------------------------------------------

function errorResult(err: unknown): {
	content: { type: "text"; text: string }[];
	details: { ok: false; error: string };
} {
	const e = err as { code?: string; message?: string };
	const code = e.code ?? "";
	const msg = e.message ?? String(err);

	let text: string;
	if (code === "DAEMON_NOT_RUNNING") {
		text =
			`browser-control error: ${msg}\n\n` +
			"The pi-browser-control daemon is not running. Start Firefox with the pi-browser-control add-on loaded, then run /browser-control → Install Firefox native-messaging manifest.";
	} else if (code === "ADDON_NOT_CONNECTED") {
		text =
			`browser-control error: ${msg}\n\n` +
			"The daemon is running but the Firefox add-on is not connected. Load the pi-browser-control add-on in Firefox via about:debugging.";
	} else if (code === "TAB_NOT_FOUND") {
		text =
			`browser-control error: ${msg}\n\n` +
			"The requested tab was not found. Run browser_list_tabs again to get the current list of tab IDs.";
	} else if (code === "TAB_DISCARDED") {
		text =
			`browser-control error: ${msg}\n\n` +
			"Firefox has unloaded this tab to save memory, so its content cannot be read until it is reloaded. Pick a tab that is currently loaded, or ask the user to switch to this tab in Firefox and retry.";
	} else {
		text = `browser-control error: ${msg}\n\nEnsure Firefox is open with the pi-browser-control add-on running.`;
	}

	return {
		content: [{ type: "text", text }],
		details: { ok: false, error: msg },
	};
}

// ---------------------------------------------------------------------------
// Helpers to resolve the daemon script path
// ---------------------------------------------------------------------------

function resolveDaemonScriptPath(): string {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	return resolve(__dirname, "daemon", "daemon.ts");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function browserControl(
	pi: ExtensionAPI,
	options: BrowserControlOptions = {},
): void {
	const client: SocketClientLike = options.socketClient ?? new SocketClient();

	// -------------------------------------------------------------------------
	// /browser-control command
	// -------------------------------------------------------------------------

	pi.registerCommand("browser-control", {
		description: "Manage browser-control: status, test connection, install native-messaging manifest",
		handler: (_args, ctx) =>
			runBrowserControlCommand(ctx, {
				getStatus: async () => {
					const result = await client.status();
					return result as {
						daemon: { pid: number; uptimeSec: number; version: string };
						addon: { connected: boolean; lastSeenSec: number | null };
					};
				},
				testConnection: async () => {
					try {
						await client.ping();
						const tabsResult = await client.listTabs();
						const tabs = tabsResult as { tabs: BrowserTab[] };
						return {
							ok: true,
							message: `Connected to browser-control add-on. ${tabs.tabs.length} open tab(s).`,
						};
					} catch (err: unknown) {
						const e = err as { code?: string };
						if (e.code === "DAEMON_NOT_RUNNING") {
							return {
								ok: false,
								message:
									"Daemon not running. Start Firefox with the pi-browser-control add-on loaded, then run /browser-control → Install.",
							};
						}
						if (e.code === "ADDON_NOT_CONNECTED") {
							return {
								ok: false,
								message:
									"Daemon is running but the Firefox add-on is not connected. Load it via about:debugging.",
							};
						}
						return {
							ok: false,
							message: `Connection test failed: ${(err as Error).message}`,
						};
					}
				},
				installManifest: () => {
					const lp = launcherPath(options.agentDir);
					const dp = resolveDaemonScriptPath();
					const launcherResult = installLauncher({
						targetPath: lp,
						daemonScriptPath: dp,
					});
					if (!launcherResult.ok) {
						return Promise.resolve(launcherResult);
					}
					return Promise.resolve(
						installManifest({
							launcherPath: lp,
							...(options.manifestPath !== undefined
								? { overrideManifestPath: options.manifestPath }
								: {}),
						}),
					);
				},
			}),
	});

	// -------------------------------------------------------------------------
	// browser_list_tabs
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "browser_list_tabs",
		label: "List Browser Tabs",
		description:
			"List all open tabs in the user's Firefox browser. Returns tab IDs, URLs, titles, and last-accessed times. Use offset/limit for pagination when there are many tabs. Requires the pi-browser-control Firefox add-on to be installed and the daemon running.",
		promptSnippet:
			"List open Firefox browser tabs (requires pi-browser-control add-on)",
		promptGuidelines: [
			"Use browser_list_tabs to discover tab IDs before calling browser_get_tab_content.",
			"Requires Firefox with the pi-browser-control add-on running. Run /browser-control to install and test.",
			"Use offset/limit to paginate — limit is capped to 500 per call.",
		],
		parameters: ListTabsParamsSchema,

		async execute(_toolCallId, params: TListTabsParams, _signal, _onUpdate, _ctx) {
			try {
				const result = await client.listTabs();
				const { tabs } = result as { tabs: BrowserTab[] };
				return {
					...buildListTabsResult(tabs, params.offset, params.limit),
					details: { ok: true },
				};
			} catch (err: unknown) {
				return errorResult(err);
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_tab_content
	// -------------------------------------------------------------------------
	// Temporarily disabled by default (hangs on streaming/SPA tabs). Opt in via
	// options.enableGetTabContent once executeScript is made timeout-safe.

	if (options.enableGetTabContent) {
		pi.registerTool({
			name: "browser_get_tab_content",
			label: "Get Browser Tab Content",
			description:
				"Get the full text content and links of a Firefox browser tab by tab ID. Use offset only for large documents when the first call was truncated. Requires the pi-browser-control Firefox add-on to be installed and the daemon running.",
			promptSnippet:
				"Get full text + links of a Firefox tab by ID (requires pi-browser-control add-on)",
			promptGuidelines: [
				"Call browser_list_tabs first to get a valid tabId before calling browser_get_tab_content.",
				"Use offset only when the previous call returned a truncation hint and you need more content.",
				"Links are only included in the first call (offset=0); subsequent paginated calls omit them.",
				"Requires Firefox with the pi-browser-control add-on running.",
			],
			parameters: GetTabContentParamsSchema,

			async execute(_toolCallId, params: TGetTabContentParams, _signal, _onUpdate, _ctx) {
				try {
					const result = await client.getTabContent(params.tabId, params.offset);
					return {
						...buildTabContentResult(result as TabContentData, params.offset),
						details: { ok: true },
					};
				} catch (err: unknown) {
					if (err instanceof SocketClientError) {
						return errorResult(err);
					}
					return errorResult(err);
				}
			},
		});
	}
}
