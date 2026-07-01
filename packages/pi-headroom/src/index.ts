import type { ContextEvent, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { applyCompressionResult, buildCompressionPayload } from "./bridge.ts";
import { HeadroomHttpClient } from "./client.ts";
import { isLocalHeadroomUrl, loadHeadroomConfig } from "./config.ts";
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
const SUBCOMMANDS = ["status", "health", "stats"] as const;

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
export default headroomExtension;
export function headroomExtension(pi: ExtensionAPI): void {
	const config = loadHeadroomConfig();
	const client = new HeadroomHttpClient({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
	const runtime = createRuntime(config, client, createDefaultProxyManager());

	pi.on("session_start", (_event, ctx) => {
		if (!isLocalHeadroomUrl(runtime.config.baseUrl)) {
			ctx.ui.notify(
				`Headroom proxy URL is remote: ${runtime.config.baseUrl}\nCompression will send context to this proxy.`,
				"warning",
			);
		}
		void runtime.updateHealth(ctx);
	});

	pi.on("context", (event, ctx) => handleContextCompression(runtime, event, ctx));

	pi.registerCommand("headroom", {
		description: "Headroom token compression. Usage: /headroom [status|health|stats]",
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
	runtime.state.proxyOnline = await runtime.client.health(signal);
	return runtime.state.proxyOnline;
}

async function ensureProxy(
	runtime: HeadroomRuntime,
	ctx: ExtensionContext,
	proxyManager: ProxyManager,
): Promise<boolean> {
	if (await runtime.updateHealth(ctx)) return true;
	if (runtime.state.proxyStartAttempted) return false;

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
	try {
		const usage = (ctx as { getContextUsage?(): { tokens: number } | null | undefined }).getContextUsage?.();
		return usage?.tokens !== null && usage?.tokens !== undefined && usage.tokens < runtime.config.minContextTokens;
	} catch {
		// ctx is stale after session replacement — skip compression
		return true;
	}
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

function refreshStatus(ctx: ExtensionContext, _config: HeadroomConfig, state: HeadroomRuntimeState): void {
	if (!(ctx as { hasUI?: boolean }).hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, renderFooterStatus(ctx, state));
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

function renderFooterStatus(ctx: ExtensionContext, state: HeadroomRuntimeState): string {
	const paint = createStatusPainter(ctx.ui.theme);
	if (!state.enabled) return paint("dim", "○ Headroom off");
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
	return [
		`Headroom proxy is not running: ${config.baseUrl}`,
		"Start it manually:",
		`  HEADROOM_TELEMETRY=off ${renderManualProxyCommand(config)}`,
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
