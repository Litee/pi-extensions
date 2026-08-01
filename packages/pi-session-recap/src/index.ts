/**
 * session-recap
 *
 * "While you were away" recap for pi, modelled on Claude Code's away-summary.
 * A recap is only drafted after a *genuine* absence, and is waiting above the
 * editor when you return:
 *
 *   1) Away timer: terminal focus reporting via DECSET ?1004. After the
 *      terminal has been continuously blurred for `--recap-away-seconds`
 *      (default 90s), a recap is generated and shown so it's parked above
 *      the editor when you refocus.
 *
 *   2) Turn-end while away: if a turn finishes while the terminal is blurred
 *      (the prime multi-tab moment — the agent finished while you were in
 *      another tab), a recap is drafted after a short debounce.
 *
 *   3) Idle fallback: only when the terminal has not demonstrated focus
 *      reporting support (no ESC[I / ESC[O seen this session). N seconds
 *      after the last `turn_end` with no input, generate anyway. `turn_end`
 *      (not `agent_end`) is used so this fires even for errored/aborted turns.
 *
 * Also fires on `/resume` / `/fork` (session_start reason) to recap where the
 * prior session left off.
 *
 * Recap content follows Claude Code's prompt philosophy: state the high-level
 * task first (what the user is building/fixing), then the concrete next step.
 * Skip status reports — the last assistant message is already on screen; what
 * the user has lost is the task thread.
 *
 * Model: defaults to the user's currently active model with reasoning/thinking
 * disabled and cache writes disabled. This piggybacks on the user's configured
 * auth. Custom providers using a built-in pi-ai API work normally; providers
 * with a custom API handler are skipped silently. Override explicitly with
 * `--recap-model "<provider>/<id>"`.
 *
 * Flags:
 *   --recap-away-seconds <n>   Continuous blur before an away recap (default 90)
 *   --recap-idle-seconds <n>   Idle-fallback delay after turn_end (default 300)
 *   --recap-disable-focus      Disable DECSET ?1004 focus reporting
 *   --recap-during-active      Allow away recaps while an agent turn is running
 *   --recap-auto               Enable automatic recaps (local-only, default off)
 *   --recap-model <p/id>       Override the default (active) model
 *
 * Command:
 *   /recap                     Force-generate a recap right now
 *
 * Upstream source: https://github.com/tmustier/pi-extensions/tree/main/session-recap
 * Copied from tmustier/pi-extensions @ session-recap v0.2.2 (see UPSTREAM.md).
 * Original author: Thomas Mustier. MIT licensed.
 *
 * Local adaptations (documented in README.md "Differences from upstream"):
 * the implementation is split across ./helpers.ts, ./prompt.ts,
 * ./focusParser.ts, ./recapOrchestrator.ts, ./subcommands.ts, ./settings.ts
 * and ./settingsMenu.ts; this file is flag registration + pi.on(...)
 * subscriptions + the `/recap` / `/recap-settings` commands + stats.
 */

import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { feedFocusBytes } from "./focusParser.js";
import { type DisabledFlag, splitModel, type StatusLineOptions } from "./helpers.js";
import {
	createRecapOrchestrator,
	type RecapOrchestrator,
	type RecapOrchestratorConfig,
} from "./recapOrchestrator.js";
import { migrateLegacyConfig, readUserRecapModel } from "./settings.js";
import { MIN_IDLE_SECONDS, runRecapSettingsCommand } from "./settingsMenu.js";
import { dispatchRecap } from "./subcommands.js";

type Model = Parameters<typeof completeSimple>[0];

/** @see ./recapOrchestrator.ts for the widget/status key convention. */
export const WIDGET_KEY = "pi-session-recap";
export const STATUS_KEY = "pi-session-recap";

const DEFAULT_IDLE_SECONDS = 300;
const DEFAULT_AWAY_SECONDS = 90;

const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("recap-idle-seconds", {
		description:
			"Idle-fallback: seconds after turn_end before a recap when the terminal doesn't report focus",
		type: "string",
		default: String(DEFAULT_IDLE_SECONDS),
	});
	pi.registerFlag("recap-away-seconds", {
		description: "Seconds of continuous terminal blur before an away recap is generated",
		type: "string",
		default: String(DEFAULT_AWAY_SECONDS),
	});
	pi.registerFlag("recap-disable-focus", {
		description: "Disable DECSET ?1004 focus reporting (idle fallback still runs)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-during-active", {
		description: "Allow away recaps while an agent turn is still running",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-auto", {
		description: "Enable automatic session recaps (idle, away, and resume triggers)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-model", {
		description: "Override the default (active) model, e.g. anthropic/claude-sonnet-4-6",
		type: "string",
		default: "",
	});

	// --- flag accessors ------------------------------------------------------

	// Session-scoped override set via `/recap-settings`. Wins over the flag
	// while non-undefined, and is cleared on session_shutdown / session
	// replacement so it never leaks across pi sessions.
	let sessionIdleOverride: number | undefined;

	const idleSeconds = (): number => {
		if (sessionIdleOverride !== undefined) return sessionIdleOverride;
		const n = Number(pi.getFlag("recap-idle-seconds") ?? DEFAULT_IDLE_SECONDS);
		return Math.max(MIN_IDLE_SECONDS, Number.isFinite(n) ? n : DEFAULT_IDLE_SECONDS);
	};
	const awaySeconds = (): number => {
		const n = Number(pi.getFlag("recap-away-seconds") ?? DEFAULT_AWAY_SECONDS);
		return Math.max(5, Number.isFinite(n) ? n : DEFAULT_AWAY_SECONDS);
	};
	const isAutoEnabled = (): boolean => Boolean(pi.getFlag("recap-auto"));
	const isFocusDisabled = (): boolean => Boolean(pi.getFlag("recap-disable-focus"));
	const allowDuringActive = (): boolean => Boolean(pi.getFlag("recap-during-active"));
	const configuredOverride = (): { source: "--recap-model" | "pi-session-recap.json"; spec: string } | null => {
		const cli = String(pi.getFlag("recap-model") ?? "").trim();
		if (cli.length > 0) return { source: "--recap-model", spec: cli };
		const fromFile = readUserRecapModel();
		if (fromFile) return { source: "pi-session-recap.json", spec: fromFile };
		return null;
	};
	const modelOverride = (): string | undefined => configuredOverride()?.spec;

	// --- orchestrator (lazy — needs ctx) ------------------------------------

	const config: RecapOrchestratorConfig = {
		isAutoEnabled,
		isFocusDisabled,
		idleMs: () => idleSeconds() * 1000,
		awayMs: () => awaySeconds() * 1000,
		modelOverride,
		allowDuringActive,
	};

	// Orchestrator is keyed per-ctx: pi delivers each lifecycle callback with
	// the same ExtensionContext instance, so we cache by identity. This keeps
	// the deps object plain (no globals) while allowing every `pi.on(...)`
	// callback to delegate without threading a second argument.
	let orchestrator: RecapOrchestrator | undefined;
	let orchestratorCtx: ExtensionContext | undefined;
	const getOrchestrator = (ctx: ExtensionContext): RecapOrchestrator => {
		if (orchestrator && orchestratorCtx === ctx) return orchestrator;
		orchestratorCtx = ctx;
		orchestrator = createRecapOrchestrator({
			completeSimple,
			getModel,
			ctx,
			config,
			widgetKey: WIDGET_KEY,
			statusKey: STATUS_KEY,
			onError: (err) =>
				pi.appendEntry("session-recap:error", {
					message: err instanceof Error ? err.message : String(err),
				}),
			onTrigger: () => {
				triggerCount += 1;
				persistStats();
			},
			onUsage: (usage) => {
				totalInputTokens += usage.input;
				totalOutputTokens += usage.output;
				persistStats();
			},
		});
		return orchestrator;
	};

	// --- session-level counters --------------------------------------------
	// Persisted via pi.appendEntry("session-recap:stats", ...) and rehydrated
	// on session_start from the most recent such entry.
	const STATS_ENTRY_TYPE = "session-recap:stats";
	let triggerCount = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	const persistStats = () => {
		pi.appendEntry(STATS_ENTRY_TYPE, { triggerCount, totalInputTokens, totalOutputTokens });
	};

	const rehydrateStats = (ctx: ExtensionContext) => {
		try {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (
					e &&
					typeof e === "object" &&
					"type" in e &&
					e.type === "custom" &&
					"customType" in e &&
					e.customType === STATS_ENTRY_TYPE &&
					"data" in e &&
					typeof e.data === "object" &&
					e.data !== null
				) {
					const d = e.data as Record<string, unknown>;
					if (typeof d["triggerCount"] === "number") triggerCount = d["triggerCount"];
					if (typeof d["totalInputTokens"] === "number") totalInputTokens = d["totalInputTokens"];
					if (typeof d["totalOutputTokens"] === "number") totalOutputTokens = d["totalOutputTokens"];
					break;
				}
			}
		} catch {
			/* defensive — stale ctx or missing sessionManager */
		}
	};

	const clearRecapWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	// --- focus reporting (stdin listener) -----------------------------------

	let focusListener: ((chunk: Buffer) => void) | undefined;
	let focusEnabled = false;

	const attachFocusReporting = (ctx: ExtensionContext) => {
		if (focusEnabled || isFocusDisabled() || !ctx.hasUI) return;
		if (!process.stdout.isTTY || !process.stdin.isTTY) return;

		try {
			process.stdout.write(FOCUS_ENABLE);
		} catch {
			return;
		}

		let buf = "";
		const listener = (chunk: Buffer) => {
			try {
				const { events, rest } = feedFocusBytes(buf, chunk.toString("binary"));
				buf = rest;
				const orch = getOrchestrator(ctx);
				for (const ev of events) {
					if (ev === "in") orch.onFocusIn();
					else orch.onFocusOut();
				}
			} catch {
				/* best-effort */
			}
		};
		process.stdin.on("data", listener);
		focusListener = listener;
		focusEnabled = true;
	};

	const detachFocusReporting = () => {
		if (focusListener) {
			try {
				process.stdin.off("data", focusListener);
			} catch {
				/* noop */
			}
			focusListener = undefined;
		}
		if (focusEnabled) {
			try {
				process.stdout.write(FOCUS_DISABLE);
			} catch {
				/* noop */
			}
			focusEnabled = false;
		}
	};

	// --- lifecycle subscriptions --------------------------------------------

	pi.on("turn_end", (_event, ctx) => {
		getOrchestrator(ctx).onTurnEnd();
	});

	pi.on("turn_start", (_event, ctx) => {
		getOrchestrator(ctx).onTurnStart();
	});

	pi.on("input", (_event, ctx) => {
		const orch = getOrchestrator(ctx);
		orch.onInput();
		clearRecapWidget(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		const orch = getOrchestrator(ctx);
		orch.onAgentStart();
		clearRecapWidget(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		getOrchestrator(ctx).onAgentEnd();
	});

	pi.on("session_shutdown", () => {
		orchestrator?.reset();
		detachFocusReporting();
		sessionIdleOverride = undefined;
	});

	pi.on("session_start", (event, ctx) => {
		try {
			migrateLegacyConfig(getAgentDir(), process.env);
		} catch {
			/* defensive */
		}
		rehydrateStats(ctx);
		// Cancel any in-flight recap or pending timer from the prior session,
		// and drop any session-scoped settings overrides set via /recap-settings
		// — overrides are explicitly per-pi-session.
		if (orchestratorCtx !== ctx) {
			orchestrator?.reset();
			sessionIdleOverride = undefined;
		}
		attachFocusReporting(ctx);
		if (!isAutoEnabled() || !ctx.hasUI) return;
		if (event.reason === "resume" || event.reason === "fork") {
			const orch = getOrchestrator(ctx);
			setTimeout(() => {
				void orch.runGenerateAndShow({ reason: "resume" });
			}, 300);
		}
	});

	// --- /recap status + help resolution ------------------------------------

	const activeModelSpec = (ctx: ExtensionContext): string => {
		const m = ctx.model;
		return m ? `${m.provider}/${m.id}` : "(no active model)";
	};

	const resolveStatusOptions = (ctx: ExtensionContext): StatusLineOptions => {
		const configured = configuredOverride();
		let override: StatusLineOptions["override"] = null;
		if (configured) {
			const parsed = splitModel(configured.spec);
			const resolved = Boolean(
				parsed &&
					(getModel as (provider: string, id: string) => Model | undefined)(
						parsed.provider,
						parsed.id,
					),
			);
			override = { source: configured.source, spec: configured.spec, resolved };
		}
		const focusOff = isFocusDisabled();
		const disabledFlags: DisabledFlag[] = [];
		if (focusOff) disabledFlags.push("--recap-disable-focus");
		return {
			override,
			activeModelSpec: activeModelSpec(ctx),
			autoRecapEnabled: isAutoEnabled(),
			idleSeconds: idleSeconds(),
			awaySeconds: focusOff ? null : awaySeconds(),
			disabledFlags,
			triggerCount,
			tokenUsage: totalInputTokens > 0 || totalOutputTokens > 0
				? { input: totalInputTokens, output: totalOutputTokens }
				: null,
		};
	};

	pi.registerCommand("recap", {
		description: "Generate a recap of recent session activity",
		handler: async (args, ctx) => {
			const sub = dispatchRecap(args);
			if (sub.kind === "generate") {
				await getOrchestrator(ctx).runGenerateAndShow({ reason: "manual" });
				return;
			}
			// Unknown args: transient toast, not chat scroll. `/recap` takes no
			// subcommands today — settings live behind `/recap-settings`.
			if (ctx.hasUI)
				ctx.ui.notify(
					`/recap takes no arguments (got "${sub.payload}"). For settings, run /recap-settings.`,
					"warning",
				);
		},
	});

	pi.registerCommand("recap-settings", {
		description: "Open the recap settings menu (read-only status + idle override)",
		handler: (_args, ctx) =>
			runRecapSettingsCommand(ctx, {
				idleSeconds,
				setIdleOverride: (value) => {
					sessionIdleOverride = value;
				},
				resolveStatusOptions: () => resolveStatusOptions(ctx),
			}),
	});
}
