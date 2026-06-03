/**
 * Pi extension entry: register the unified `browser_control` tool.
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
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import { SocketClient, type SocketClientLike } from "./socket-client.js";
import { runBrowserControlCommand } from "./command.js";
import { installManifest } from "./manifest-installer.js";
import { installLauncher } from "./launcher-installer.js";
import { launcherPath } from "./socket-paths.js";
import {
	buildListTabsResult,
	buildTabContentResult,
	type SlimBrowserTab,
	type FullBrowserTab,
	type TabContentData,
} from "./tool-format.js";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import fs, { existsSync } from "node:fs";

const execFile = promisify(execFileCb);

// Re-export SocketClientLike so tests can import it from index.js
export type { SocketClientLike };

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

const BrowserControlParamsSchema = Type.Object({
	operation: Type.Union([
		Type.Literal("list_tabs"),
		Type.Literal("export_tabs"),
		Type.Literal("get_tab_content"),
		Type.Literal("close_tab"),
	], { description: "Operation to perform: list_tabs, export_tabs, get_tab_content, or close_tab." }),
	path: Type.Optional(Type.String({ description: "Absolute file path to write the JSONL output to (creates or overwrites). Required for export_tabs." })),
	tabId: Type.Optional(Type.Number({ description: "The numeric tab ID as returned by list_tabs. Required for get_tab_content and close_tab." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: "Character offset for paginating large documents with get_tab_content. Defaults to 0." })),
});
type TBrowserControlParams = Static<typeof BrowserControlParamsSchema>;

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
	 * Kept for backward compatibility with existing tests. No longer used to
	 * gate tool registration — get_tab_content is now an operation of the
	 * unified browser_control tool and is always registered.
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
			"The requested tab was not found. Run browser_control with operation=list_tabs to get the current list of tab IDs.";
	} else if (code === "TAB_DISCARDED") {
		text =
			`browser-control error: ${msg}\n\n` +
			"Firefox has unloaded this tab to save memory, so its content cannot be read until it is reloaded. Pick a tab that is currently loaded, or ask the user to switch to this tab in Firefox and retry.";
	} else if (code === "EXTRACTION_TIMEOUT") {
		text =
			`browser-control error: ${msg}\n\n` +
			"The page did not return its content in time (often a streaming or single-page app that never finishes loading). Try another tab, or ask the user to switch to this tab and let it settle before retrying.";
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
// buildAddon — runs web-ext build on the firefox-addon/ directory
// ---------------------------------------------------------------------------

async function buildAddon(): Promise<{ ok: true; xpiPath: string } | { ok: false; error: string }> {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	// src/ → packages/pi-browser-control/ (pkgRoot) → firefox-addon/
	const pkgRoot = resolve(__dirname, "..");
	const addonDir = resolve(pkgRoot, "firefox-addon");
	const artifactsDir = resolve(pkgRoot, "web-ext-artifacts");
	// npm workspaces hoists deps to the monorepo root — walk up from pkgRoot
	// until we find node_modules/.bin/web-ext (handles both hoisted and local).
	const monorepoRoot = resolve(pkgRoot, "..", "..");
	const localBin = resolve(pkgRoot, "node_modules", ".bin", "web-ext");
	const hoistedBin = resolve(monorepoRoot, "node_modules", ".bin", "web-ext");
	const webExtBin = existsSync(localBin) ? localBin : hoistedBin;
	try {
		const { stdout } = await execFile(webExtBin, [
			"build",
			"--source-dir",
			addonDir,
			"--artifacts-dir",
			artifactsDir,
			"--overwrite-dest",
		]);
		// web-ext prints: "Your web extension is ready: /path/to/file.xpi"
		const match = /Your web extension is ready:\s*(\S+\.xpi)/i.exec(stdout);
		const xpiPath = match?.[1] ?? artifactsDir;
		return { ok: true, xpiPath };
	} catch (err: unknown) {
		const e = err as { stderr?: string; message?: string };
		const error = e.stderr?.trim() || e.message || String(err);
		return { ok: false, error };
	}
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
						const tabs = tabsResult as { tabs: SlimBrowserTab[] };
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
				buildAddon,
			}),
	});

	// -------------------------------------------------------------------------
	// browser_control (unified)
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "browser_control",
		label: "Browser Control",
		description:
			"Control the user's Firefox browser. Supports four operations:\n" +
			"- list_tabs: List open tabs with IDs, URLs, titles, last-accessed times. Paginate with offset/limit.\n" +
			"- export_tabs: Export all tab metadata to a JSON Lines file at the given absolute path.\n" +
			"- get_tab_content: Get the full text content and links of a tab by ID.\n" +
			"- close_tab: Close a single tab by ID.\n" +
			"Requires the pi-browser-control Firefox add-on to be installed and the daemon running.",
		promptSnippet: "Control Firefox browser tabs (requires pi-browser-control add-on)",
		promptGuidelines: [
			"Use operation=list_tabs to discover tab IDs before calling get_tab_content or close_tab.",
			"Requires Firefox with the pi-browser-control add-on running. Run /browser-control to install and test.",
			"Use operation=export_tabs to dump full tab metadata for all open Firefox tabs to a file.",
			"The export output is JSON Lines format — one tab object per line.",
		],
		parameters: BrowserControlParamsSchema,

		async execute(_toolCallId, params: TBrowserControlParams, _signal, _onUpdate, _ctx) {
			try {
				if (params.operation === "list_tabs") {
					const result = await client.listTabs();
					const { tabs } = result as { tabs: SlimBrowserTab[] };
					return {
						...buildListTabsResult(tabs),
						details: { ok: true, operation: "list_tabs" as const },
					};
				}

				if (params.operation === "export_tabs") {
					const filePath = params.path;
					if (!filePath || !isAbsolute(filePath)) {
						return {
							content: [{ type: "text" as const, text: `browser_control error: path must be absolute (got "${filePath ?? "(none)"}" )` }],
							details: { ok: false },
						};
					}
					const result = await client.exportTabs();
					const { tabs } = result as { tabs: FullBrowserTab[] };
					const publicTabs = tabs.filter((t) => !t.incognito);
					const skipped = tabs.length - publicTabs.length;
					const jsonl = publicTabs.map((tab) => JSON.stringify(tab)).join("\n");
					try {
						fs.writeFileSync(filePath, jsonl, "utf-8");
					} catch (writeErr: unknown) {
						const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
						return {
							content: [{ type: "text" as const, text: `browser_control error: failed to write file: ${msg}` }],
							details: { ok: false, error: msg },
						};
					}
					const note = skipped > 0 ? ` (${skipped} private-browsing tab${skipped === 1 ? "" : "s"} excluded)` : "";
					return {
						content: [{ type: "text" as const, text: `Exported ${publicTabs.length} tabs to ${filePath}${note}` }],
						details: { ok: true, operation: "export_tabs" as const },
					};
				}

				if (params.operation === "get_tab_content") {
					const result = await client.getTabContent(params.tabId!, params.offset ?? 0);
					return {
						...buildTabContentResult(result as TabContentData, params.offset ?? 0),
						details: { ok: true, operation: "get_tab_content" as const },
					};
				}

				if (params.operation === "close_tab") {
					await client.closeTab(params.tabId!);
					return {
						content: [{ type: "text" as const, text: `Tab ${params.tabId!} closed.` }],
						details: { ok: true, operation: "close_tab" as const, tabId: params.tabId! },
					};
				}

				// Exhaustive check — compile error here if a new operation is added without handling
				const _exhaustive: never = params.operation;
				return _exhaustive;
			} catch (err: unknown) {
				return errorResult(err);
			}
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "…"), 0, 0);
			const content = result.content as { type: string; text: string }[] | undefined;
			if (!content || content.length === 0) {
				return new Text(theme.fg("muted", "(no output)"), 0, 0);
			}
			const op = (result.details as { operation?: string } | undefined)?.operation;
			if (op === "list_tabs") {
				const DISPLAY_LIMIT = 10;
				const header = content[0]!.text;
				const tabLines = content.slice(1);
				const total = tabLines.length;
				const shown = expanded ? tabLines.slice(0, DISPLAY_LIMIT) : tabLines.slice(0, 3);
				const hidden = total - shown.length;
				let text = theme.fg("dim", header) + "\n";
				text += shown.map(l => l.text).join("\n");
				if (hidden > 0) {
					text += "\n" + theme.fg("muted", `… ${hidden} more tab${hidden === 1 ? "" : "s"} — open logs to see all`);
				}
				return new Text(text, 0, 0);
			}
			return new Text(content[0]!.text, 0, 0);
		},
	});
}
