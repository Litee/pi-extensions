import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRemoteBlocked, loadHeadroomConfig } from "./config.ts";
import { createDefaultMenu } from "./menu.ts";
import type { HeadroomConfig, HeadroomRuntimeState } from "./types.ts";

const STATUS_KEY = "headroom";
const SUBCOMMANDS = ["status", "health", "stats"] as const;

type Subcommand = (typeof SUBCOMMANDS)[number] | null;

// ---------------------------------------------------------------------------
// Runtime state — tracks extension-local settings (no proxy/compression).
// ---------------------------------------------------------------------------

function createRuntimeState(config: HeadroomConfig): HeadroomRuntimeState {
	return {
		enabled: config.enabled,
		proxyOnline: null,
		remoteWarningShown: false,
		offlineWarningShown: false,
		stats: { attempts: 0, applied: 0, tokensSaved: 0 },
	};
}

// ---------------------------------------------------------------------------
// Public API — extension factory and test helpers.
// ---------------------------------------------------------------------------

export { createRuntimeState, parseSubcommand };

export default function headroomExtension(pi: ExtensionAPI): void {
	const config = loadHeadroomConfig();
	const state = createRuntimeState(config);

	pi.on("session_start", (_event, ctx) => {
		refreshStatus(ctx, config, state);
	});

	pi.registerCommand("headroom", {
		description: "Headroom settings. Usage: /headroom [on|off|status|health|stats]",
		getArgumentCompletions(argumentPrefix) {
			const prefix = argumentPrefix.trim().toLowerCase();
			return SUBCOMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
				value: command,
				label: command,
			}));
		},
		handler: async (args, ctx) => handleCommand(config, state, parseSubcommand(args), ctx),
	});
}

// ---------------------------------------------------------------------------
// Slash command handler.
// ---------------------------------------------------------------------------

async function handleCommand(
	config: HeadroomConfig,
	state: HeadroomRuntimeState,
	command: Subcommand,
	ctx: ExtensionContext,
): Promise<void> {
	if (command === "health") {
		ctx.ui.notify(
			isRemoteBlocked(config) ? renderRemoteBlocked(config) : `Headroom proxy: ${config.baseUrl}`,
			isRemoteBlocked(config) ? "warning" : "info",
		);
		return;
	}

	if (command === "stats") {
		ctx.ui.notify(
			isRemoteBlocked(config) ? renderRemoteBlocked(config) : "Proxy stats not available without a running proxy.",
			isRemoteBlocked(config) ? "warning" : "info",
		);
		return;
	}

	// Menu — shown when no subcommand is provided (null) and TUI is available.
	if (command === null) {
		if ((ctx as { hasUI?: boolean }).hasUI) {
			const menu = createDefaultMenu();
			await menu.openHeadroomMenu(ctx, { config, state, refreshStatus: (c) => refreshStatus(c, config, state) });
		} else {
			ctx.ui.notify("Headroom menu requires a TUI session (no UI available).", "warning");
		}
	}

	// Default: show status.
	if (command === "status") {
		refreshStatus(ctx, config, state);
	}
}

// ---------------------------------------------------------------------------
// Footer status rendering.
// ---------------------------------------------------------------------------

function refreshStatus(ctx: ExtensionContext, config: HeadroomConfig, state: HeadroomRuntimeState): void {
	if (!(ctx as { hasUI?: boolean }).hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, renderFooterStatus(ctx, config, state));
}

type HeadroomStatusColor = "dim" | "warning" | "success";

function isHeadroomStatusTheme(theme: unknown): theme is { fg(color: HeadroomStatusColor, text: string): string } {
	return typeof (theme as { fg?: unknown } | null)?.fg === "function";
}

function createStatusPainter(theme: unknown): (color: HeadroomStatusColor, text: string) => string {
	if (isHeadroomStatusTheme(theme)) return (color, text) => theme.fg(color, text);
	return (_color: HeadroomStatusColor, text: string) => text;
}

function renderFooterStatus(ctx: ExtensionContext, config: HeadroomConfig, state: HeadroomRuntimeState): string {
	const paint = createStatusPainter(ctx.ui.theme);
	if (!state.enabled) return paint("dim", "○ Headroom off");
	if (isRemoteBlocked(config)) return paint("warning", "⚠") + paint("dim", " Headroom remote blocked");
	if (state.proxyOnline === false) return paint("dim", "○ Headroom not running");
	if (state.proxyOnline === null) return paint("dim", "○ Headroom idle");

	const pct = Math.round((1 - (state.stats.last?.compressionRatio ?? 0)) * 100);
	return paint("success", "✓") + paint("dim", ` Headroom -${pct}% (${state.stats.last?.tokensSaved.toLocaleString() ?? 0} saved)`);
}

// ---------------------------------------------------------------------------
// Info helpers (no network calls).
// ---------------------------------------------------------------------------

function renderRemoteBlocked(config: HeadroomConfig): string {
	return [
		`Headroom remote URL is blocked: ${config.baseUrl}`,
		"Compression sends conversation context to the proxy.",
		"Set PI_HEADROOM_ALLOW_REMOTE=1 only for a trusted proxy.",
	].join("\n");
}



// ---------------------------------------------------------------------------
// Subcommand parser.
// ---------------------------------------------------------------------------

function parseSubcommand(args: string): Subcommand {
	const normalized = args.trim().toLowerCase();
	if (normalized === "") return null;
	return SUBCOMMANDS.includes(normalized as (typeof SUBCOMMANDS)[number]) ? (normalized as (typeof SUBCOMMANDS)[number]) : "status";
}
