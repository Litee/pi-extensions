/**
 * session-recap
 *
 * Upstream source: https://github.com/tmustier/pi-extensions/tree/main/session-recap
 * Design-of-record:  https://github.com/tmustier/pi-extensions/blob/main/session-recap/DESIGN.md
 * Copied verbatim from tmustier/pi-extensions @ session-recap v0.1.1.
 * Original author: Thomas Mustier. MIT licensed.
 *
 * Claude-Code-style session recap for pi. See README.md for full docs;
 * the implementation is split across:
 *
 *   ./helpers.ts            — pure transcript / status-line helpers
 *   ./prompt.ts             — LLM prompt template (snapshot-tested)
 *   ./focusParser.ts        — pure DECSET ?1004 ESC-sequence scanner
 *   ./recapOrchestrator.ts  — active-request / leaf-id / idle-timer state machine
 *   ./subcommands.ts        — pure `/recap` subcommand classifier
 *   ./settings.ts           — user-config file read + legacy-env migration
 *
 * This file is now just flag registration + pi.on(...) subscriptions
 * delegating to the orchestrator + command dispatch.
 */

import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { feedFocusBytes } from "./focusParser.js";
import { buildStatusLine, type DisabledFlag, splitModel, type StatusLineOptions } from "./helpers.js";
import {
	createRecapOrchestrator,
	type RecapOrchestrator,
	type RecapOrchestratorConfig,
} from "./recapOrchestrator.js";
import { migrateLegacyConfig, readUserRecapModel } from "./settings.js";
import { dispatchRecap } from "./subcommands.js";

type Model = Parameters<typeof completeSimple>[0];

/** @see ./recapOrchestrator.ts for the widget/status key convention. */
export const WIDGET_KEY = "pi-session-recap";
export const STATUS_KEY = "pi-session-recap";

const DEFAULT_IDLE_SECONDS = 180;
const DEFAULT_FOCUS_MIN_SECONDS = 3;

const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("recap-idle-seconds", {
		description: "Seconds after turn_end before the session recap is generated",
		type: "string",
		default: String(DEFAULT_IDLE_SECONDS),
	});
	pi.registerFlag("recap-focus-min-seconds", {
		description: "Minimum focus-out duration (seconds) before showing a recap on refocus",
		type: "string",
		default: String(DEFAULT_FOCUS_MIN_SECONDS),
	});
	pi.registerFlag("recap-disable-focus", {
		description: "Disable DECSET ?1004 focus reporting (idle fallback still runs)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-disable", {
		description: "Disable the automatic session recap",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-model", {
		description: "Override the default (active) model, e.g. anthropic/claude-sonnet-4-6",
		type: "string",
		default: "",
	});

	// --- flag accessors ------------------------------------------------------

	const idleSeconds = (): number => {
		const n = Number(pi.getFlag("recap-idle-seconds") ?? DEFAULT_IDLE_SECONDS);
		return Math.max(5, Number.isFinite(n) ? n : DEFAULT_IDLE_SECONDS);
	};
	const focusMinSeconds = (): number => {
		const n = Number(pi.getFlag("recap-focus-min-seconds") ?? DEFAULT_FOCUS_MIN_SECONDS);
		return Math.max(0, Number.isFinite(n) ? n : DEFAULT_FOCUS_MIN_SECONDS);
	};
	const isDisabled = (): boolean => Boolean(pi.getFlag("recap-disable"));
	const isFocusDisabled = (): boolean => Boolean(pi.getFlag("recap-disable-focus"));
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
		isDisabled,
		isFocusDisabled,
		idleMs: () => idleSeconds() * 1000,
		focusMinMs: () => focusMinSeconds() * 1000,
		modelOverride,
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
		});
		return orchestrator;
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
		const orch = getOrchestrator(ctx);
		orch.invalidateDraft();
		orch.scheduleRecap();
	});

	pi.on("turn_start", (_event, ctx) => {
		getOrchestrator(ctx).clearTimer();
	});

	pi.on("input", (_event, ctx) => {
		const orch = getOrchestrator(ctx);
		orch.reset();
		clearRecapWidget(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		const orch = getOrchestrator(ctx);
		orch.reset();
		clearRecapWidget(ctx);
	});

	pi.on("session_shutdown", () => {
		orchestrator?.reset();
		detachFocusReporting();
	});

	pi.on("session_start", (event, ctx) => {
		try {
			migrateLegacyConfig(getAgentDir(), process.env);
		} catch {
			/* defensive */
		}
		// Cancel any in-flight recap or pending timer from the prior session.
		if (orchestratorCtx !== ctx) orchestrator?.reset();
		attachFocusReporting(ctx);
		if (isDisabled()) return;
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
		if (isDisabled()) disabledFlags.push("--recap-disable");
		if (focusOff) disabledFlags.push("--recap-disable-focus");
		return {
			override,
			activeModelSpec: activeModelSpec(ctx),
			autoRecapEnabled: !isDisabled(),
			idleSeconds: idleSeconds(),
			focusMinSeconds: focusOff ? null : focusMinSeconds(),
			disabledFlags,
		};
	};

	const VALID_SUBCOMMANDS = ["status", "help"] as const;
	const SUBCOMMAND_HELP =
		"/recap subcommands:\n" +
		"  (no args)       Generate a recap of recent session activity.\n" +
		"  status          Show the current recap configuration (model, triggers, flags).\n" +
		"  help            Show this help text.";
	const SUBCOMMAND_MESSAGE_TYPE = "pi-session-recap:subcommand";

	pi.registerMessageRenderer(SUBCOMMAND_MESSAGE_TYPE, (message) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		return new Text(text, 0, 0);
	});

	pi.registerCommand("recap", {
		description: "Generate a one-line recap, or show status (/recap status)",
		handler: async (args, ctx) => {
			const sub = dispatchRecap(args);
			if (sub.kind === "generate") {
				await getOrchestrator(ctx).runGenerateAndShow({ reason: "manual" });
				return;
			}
			if (sub.kind === "status") {
				pi.sendMessage(
					{
						customType: SUBCOMMAND_MESSAGE_TYPE,
						content: buildStatusLine(resolveStatusOptions(ctx)),
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
				return;
			}
			if (sub.kind === "help") {
				pi.sendMessage(
					{
						customType: SUBCOMMAND_MESSAGE_TYPE,
						content: SUBCOMMAND_HELP,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
				return;
			}
			// Unknown subcommand: transient toast, not chat scroll.
			if (ctx.hasUI)
				ctx.ui.notify(
					`Unknown /recap subcommand: "${sub.payload}". Valid subcommands: ${VALID_SUBCOMMANDS.join(", ")}.`,
					"warning",
				);
		},
	});
}
