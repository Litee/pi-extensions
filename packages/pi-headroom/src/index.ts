import type { ContextEvent, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { applyCompressionResult, buildCompressionPayload } from "./bridge.ts";
import { HeadroomHttpClient } from "./client.ts";
import { isRemoteBlocked, loadHeadroomConfig } from "./config.ts";
import { createDefaultMenu } from "./menu.ts";
import { createDefaultProxyManager } from "./proxy-manager.ts";
import type {
	AgentMessage,
	CompressResult,
	HeadroomClient,
	HeadroomConfig,
	HeadroomRuntime,
	HeadroomRuntimeState,
	HeadroomStats,
	ProxyManager,
} from "./types.ts";

const STATUS_KEY = "headroom";
const SUBCOMMANDS = ["status", "on", "off", "health", "stats"] as const;

type Subcommand = (typeof SUBCOMMANDS)[number] | null;

// ---------------------------------------------------------------------------
// Public API — extension factory accepting injected dependencies.
// ---------------------------------------------------------------------------

export function createRuntime(
	config: HeadroomConfig,
	client: HeadroomClient,
	proxyManager: ProxyManager,
): HeadroomRuntime {
	const state: HeadroomRuntimeState = {
		enabled: config.enabled,
		proxyOnline: null,
		proxyStarting: false,
		proxyStartAttempted: false,
		remoteWarningShown: false,
		offlineWarningShown: false,
		stats: { attempts: 0, applied: 0, guardSkips: 0, tokensSaved: 0 },
	};

	const runtime: HeadroomRuntime = {
		config,
		client,
		state,
		refreshStatus(ctx) {
			refreshStatus(ctx, runtime.config, runtime.state);
		},
		async updateHealth(ctx) {
			const online = await updateHealthState(runtime, ctx.signal);
			runtime.refreshStatus(ctx);
			return online;
		},
		async ensureProxy(ctx) {
			return ensureProxy(runtime, ctx, proxyManager);
		},
	};
	return runtime;
}

/** Wire up a headroom extension with default (real) dependencies. */
/** Wire up a headroom extension with default (real) dependencies. */
export default headroomExtension;
export function headroomExtension(pi: ExtensionAPI): void {
	const config = loadHeadroomConfig();
	const client = new HeadroomHttpClient({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
	const runtime = createRuntime(config, client, createDefaultProxyManager());

	pi.on("session_start", (_event, ctx) => {
		if (isRemoteBlocked(runtime.config)) {
			runtime.refreshStatus(ctx);
			ctx.ui.notify(
				`Headroom remote URL is blocked by default: ${runtime.config.baseUrl}\nSet PI_HEADROOM_ALLOW_REMOTE=1 only if you trust that proxy with full context.`,
				"warning",
			);
			return;
		}
		runtime.refreshStatus(ctx);
		if (!runtime.state.enabled) return;
		void ensureProxyInBackground(runtime, ctx);
	});

	pi.on("context", (event, ctx) => handleContextCompression(runtime, event, ctx));

	pi.registerCommand("headroom", {
		description: "Headroom token compression. Usage: /headroom [on|off|status|health|stats]",
		getArgumentCompletions(argumentPrefix) {
			const prefix = argumentPrefix.trim().toLowerCase();
			return SUBCOMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
				value: command,
				label: command,
			}));
		},
		handler: async (args, ctx) => handleCommand(runtime, parseSubcommand(args), ctx),
	});
}

// ---------------------------------------------------------------------------
// Internal helpers (still use the runtime interface).
// ---------------------------------------------------------------------------

async function updateHealthState(runtime: HeadroomRuntime, signal?: AbortSignal): Promise<boolean> {
	if (isRemoteBlocked(runtime.config)) return false;
	runtime.state.proxyOnline = await runtime.client.health(signal);
	return runtime.state.proxyOnline;
}

async function ensureProxy(
	runtime: HeadroomRuntime,
	ctx: ExtensionContext,
	proxyManager: ProxyManager,
): Promise<boolean> {
	if (await runtime.updateHealth(ctx)) return true;
	if (!runtime.config.autoStart || runtime.state.proxyStartAttempted) return false;

	runtime.state.proxyStartAttempted = true;
	runtime.state.proxyStarting = true;
	runtime.refreshStatus(ctx);
	const started = await proxyManager.startPersistentHeadroomProxy(runtime.config);
	if (!started.ok) {
		runtime.state.stats.lastError = started.reason;
		runtime.state.proxyStarting = false;
		runtime.state.proxyOnline = false;
		runtime.refreshStatus(ctx);
		return false;
	}

	const online = await waitForProxyHealth(runtime, ctx.signal);
	runtime.state.proxyStarting = false;
	runtime.state.proxyOnline = online;
	runtime.refreshStatus(ctx);
	return online;
}

async function ensureProxyInBackground(runtime: HeadroomRuntime, ctx?: ExtensionContext): Promise<void> {
	try {
		if (ctx && (await runtime.updateHealth(ctx))) {
			safeRefreshStatus(runtime, ctx);
			return;
		}
		if (!runtime.config.autoStart || runtime.state.proxyStartAttempted) {
			safeRefreshStatus(runtime, ctx);
			return;
		}
		runtime.state.proxyStartAttempted = true;
		runtime.state.proxyStarting = true;
		safeRefreshStatus(runtime, ctx);
		if (ctx) {
			const started = await runtime.client.health(ctx.signal).then(() => ({ ok: true }));
			if (!started.ok) {
				runtime.state.stats.lastError = "proxy start failed";
				runtime.state.proxyStarting = false;
				runtime.state.proxyOnline = false;
				safeRefreshStatus(runtime, ctx);
				return;
			}
			runtime.state.proxyOnline = await waitForProxyHealth(runtime, ctx.signal);
			runtime.state.proxyStarting = false;
			safeRefreshStatus(runtime, ctx);
		}
	} catch (error) {
		runtime.state.proxyStarting = false;
		runtime.state.proxyOnline = false;
		runtime.state.stats.lastError = error instanceof Error ? error.message : String(error);
		safeRefreshStatus(runtime, ctx);
	}
}

function safeRefreshStatus(runtime: HeadroomRuntime, ctx: ExtensionContext | undefined): void {
	if (!ctx) return;
	try {
		runtime.refreshStatus(ctx);
	} catch {
		// The session may have been reloaded/replaced while background health was in flight.
	}
}

async function waitForProxyHealth(runtime: HeadroomRuntime, signal?: AbortSignal): Promise<boolean> {
	for (const delay of [300, 500, 800, 1200, 2000]) {
		await sleep(delay);
		if (await runtime.updateHealth({ ui: { hasUI: false, theme: undefined as unknown as Theme, setStatus: () => {}, notify: () => {} }, signal } as unknown as ExtensionContext)) return true;
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleContextCompression(
	runtime: HeadroomRuntime,
	event: ContextEvent,
	ctx: ExtensionContext,
): Promise<{ messages?: AgentMessage[] } | undefined> {
	if (shouldSkipBeforePayload(runtime, ctx)) return undefined;
	const payload = buildCompressionPayload(event.messages, runtime.config.minMessageChars);
	if (payload.candidateCount === 0) return undefined;
	if (runtime.state.proxyOnline !== true) {
		void ensureProxyInBackground(runtime, ctx);
		return undefined;
	}

	runtime.state.stats.attempts++;
	try {
		const result = await runtime.client.compress(payload.messages, ctx.model?.id, ctx.signal);
		runtime.state.proxyOnline = true;
		if (!result.compressed || result.tokensSaved <= 0) {
			runtime.refreshStatus(ctx);
			return undefined;
		}

		const applied = applyCompressionResult(event.messages, payload.mappings, result.messages, {
			minMessageChars: runtime.config.minMessageChars,
		});
		if (!applied.ok) {
			recordGuardSkip(runtime.state.stats, applied.reason);
			runtime.refreshStatus(ctx);
			return undefined;
		}

		recordAppliedCompression(runtime.state.stats, result, applied.appliedMessages);
		runtime.refreshStatus(ctx);
		return { messages: applied.messages };
	} catch (error) {
		recordCompressionError(runtime, ctx, error);
		return undefined;
	}
}

function shouldSkipBeforePayload(runtime: HeadroomRuntime, ctx: ExtensionContext): boolean {
	if (!runtime.state.enabled) return true;
	if (isRemoteBlocked(runtime.config)) {
		if (!runtime.state.remoteWarningShown) {
			runtime.state.remoteWarningShown = true;
			ctx.ui.notify(
				"Headroom compression skipped because remote proxy is blocked.",
				"warning",
			);
		}
		runtime.refreshStatus(ctx);
		return true;
	}
	const usage = (ctx as { getContextUsage?(): { tokens: number } | null | undefined }).getContextUsage?.();
	return usage?.tokens !== null && usage?.tokens !== undefined && usage.tokens < runtime.config.minContextTokens;
}

function recordGuardSkip(stats: HeadroomStats, reason: string): void {
	stats.guardSkips++;
	stats.lastSkipReason = reason;
}

function recordAppliedCompression(stats: HeadroomStats, result: CompressResult, appliedMessages: number): void {
	stats.applied++;
	stats.tokensSaved += result.tokensSaved;
	stats.lastError = undefined;
	stats.lastSkipReason = undefined;
	stats.last = { ...result, appliedMessages };
}

function recordCompressionError(runtime: HeadroomRuntime, ctx: ExtensionContext, error: unknown): void {
	runtime.state.stats.lastError = getErrorMessage(error);
	if (isAbortOrTimeoutError(error)) {
		runtime.refreshStatus(ctx);
		return;
	}

	const isHttpError = typeof runtime.state.stats.lastError === "string" && runtime.state.stats.lastError.startsWith("HTTP ");
	if (!isHttpError) {
		const wasOnline = runtime.state.proxyOnline === true;
		runtime.state.proxyOnline = false;
		if (wasOnline && !runtime.state.offlineWarningShown) {
			runtime.state.offlineWarningShown = true;
			ctx.ui.notify(
				`Headroom proxy unavailable. Compression disabled until /headroom health succeeds.\n${runtime.state.stats.lastError}`,
				"warning",
			);
		}
		if (wasOnline && runtime.state.offlineWarningShown) {
			runtime.state.offlineWarningShown = false;
			ctx.ui.notify("Headroom proxy is back online. Compression resumed.", "info");
		}
	}
	runtime.refreshStatus(ctx);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortOrTimeoutError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { cause?: unknown; message?: unknown; name?: unknown };
	if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
	if (
		typeof candidate.message === "string" &&
		/aborted due to timeout|operation was aborted/i.test(candidate.message)
	) {
		return true;
	}
	return candidate.cause !== undefined && candidate.cause !== error && isAbortOrTimeoutError(candidate.cause);
}

async function handleCommand(
	runtime: HeadroomRuntime,
	command: Subcommand,
	ctx: ExtensionContext,
): Promise<void> {
	if (command === "on") {
		runtime.state.enabled = true;
		runtime.state.offlineWarningShown = false;
		runtime.state.proxyStartAttempted = false;
		const healthy = await runtime.ensureProxy(ctx);
		ctx.ui.notify(
			healthy
				? "Headroom compression enabled. Proxy will keep running after Pi exits."
				: proxyStartHint(runtime.config),
			healthy ? "info" : "warning",
		);
		return;
	}
	if (command === "off") {
		runtime.state.enabled = false;
		runtime.refreshStatus(ctx);
		ctx.ui.notify("Headroom compression disabled for this Pi session. The proxy process is left running.", "info");
		return;
	}
	if (command === "health") {
		runtime.state.proxyStartAttempted = false;
		const healthy = await runtime.ensureProxy(ctx);
		ctx.ui.notify(
			healthy ? `Headroom proxy online: ${runtime.config.baseUrl}` : proxyStartHint(runtime.config),
			healthy ? "info" : "warning",
		);
		return;
	}
	if (command === "stats") {
		await showProxyStats(ctx, runtime.client, runtime.config);
		return;
	}
	// Menu — shown when no subcommand is provided (null) and TUI is available.
	if (command === null) {
		if ((ctx as { hasUI?: boolean }).hasUI) {
			const menu = createDefaultMenu();
			await menu.openHeadroomMenu(ctx, runtime);
		} else {
			ctx.ui.notify("Headroom menu requires a TUI session (no UI available).", "warning");
		}
	}
}

function refreshStatus(ctx: ExtensionContext, config: HeadroomConfig, state: HeadroomRuntimeState): void {
	if (!(ctx as { hasUI?: boolean }).hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, renderFooterStatus(ctx, config, state));
}

type HeadroomStatusColor = "dim" | "warning" | "success";

type HeadroomStatusTheme = {
	fg(color: HeadroomStatusColor, text: string): string;
};

function isHeadroomStatusTheme(theme: unknown): theme is HeadroomStatusTheme {
	return typeof (theme as { fg?: unknown } | null)?.fg === "function";
}

function createStatusPainter(theme: unknown): (color: HeadroomStatusColor, text: string) => string {
	if (isHeadroomStatusTheme(theme)) return (color, text) => theme.fg(color, text);
	return (_color, text) => text;
}

function renderFooterStatus(ctx: ExtensionContext, config: HeadroomConfig, state: HeadroomRuntimeState): string {
	const paint = createStatusPainter(ctx.ui.theme);
	if (!state.enabled) return paint("dim", "○ Headroom off");
	if (isRemoteBlocked(config)) return paint("warning", "⚠") + paint("dim", " Headroom remote blocked");
	if (state.proxyStarting) return paint("dim", "⏳ Headroom starting");
	if (state.proxyOnline === false) return paint("dim", "○ Headroom not running");
	if (state.proxyOnline === null && !state.stats.last) return paint("dim", "○ Headroom idle");
	if (!state.stats.last) return paint("success", "✓") + paint("dim", " Headroom");

	const pct = Math.round((1 - state.stats.last.compressionRatio) * 100);
	return (
		paint("success", "✓") + paint("dim", ` Headroom -${pct}% (${state.stats.last.tokensSaved.toLocaleString()} saved)`)
	);
}

async function showProxyStats(
	ctx: ExtensionContext,
	client: HeadroomClient,
	config: HeadroomConfig,
): Promise<void> {
	if (isRemoteBlocked(config)) {
		ctx.ui.notify(renderRemoteBlocked(config), "warning");
		return;
	}
	try {
		const stats = await client.stats(ctx.signal);
		ctx.ui.notify(
			`Headroom proxy stats (${config.baseUrl}):\n${JSON.stringify(stats, null, 2).slice(0, 4000)}`,
			"info",
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not read Headroom stats: ${message}`, "warning");
	}
}


function proxyStartHint(config: HeadroomConfig): string {
	if (isRemoteBlocked(config)) return renderRemoteBlocked(config);
	if (!config.autoStart) {
		return [
			`Headroom proxy is not running: ${config.baseUrl}`,
			"Auto-start is disabled. Start it manually:",
			`  HEADROOM_TELEMETRY=off ${renderManualProxyCommand(config)}`,
		].join("\n");
	}
	return [
		`Headroom proxy is not running: ${config.baseUrl}`,
		`Tried to start persistent proxy with command: ${config.command}`,
		"Install Headroom or set PI_HEADROOM_COMMAND if needed:",
		'  pip install "headroom-ai[proxy]"',
		"  # then run /headroom on",
	].join("\n");
}

function renderManualProxyCommand(config: HeadroomConfig): string {
	try {
		const url = new URL(config.baseUrl);
		const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[(.*)]$/, "$1");
		const port = url.port || "8788";
		return `${config.command} proxy --host ${host} --port ${port} --mode token --no-cache`;
	} catch {
		return `${config.command} proxy --mode token --no-cache`;
	}
}

function renderRemoteBlocked(config: HeadroomConfig): string {
	return [
		`Headroom remote URL is blocked: ${config.baseUrl}`,
		"Compression sends conversation context to the proxy.",
		"Set PI_HEADROOM_ALLOW_REMOTE=1 only for a trusted proxy.",
	].join("\n");
}

function parseSubcommand(args: string): Subcommand {
	const normalized = args.trim().toLowerCase();
	if (normalized === "") return null;
	return SUBCOMMANDS.includes(normalized as (typeof SUBCOMMANDS)[number]) ? (normalized as (typeof SUBCOMMANDS)[number]) : "status";
}

// ---------------------------------------------------------------------------
// Test helpers — exported so index.test.ts can exercise internal logic.
// ---------------------------------------------------------------------------

export const __test__ = {
	isAbortOrTimeoutError,
	renderFooterStatus,
	createRuntime,
	headroomExtension,
};
