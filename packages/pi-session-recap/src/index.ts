/**
 * session-recap
 *
 * Upstream source: https://github.com/tmustier/pi-extensions/tree/main/session-recap
 * Design-of-record:  https://github.com/tmustier/pi-extensions/blob/main/session-recap/DESIGN.md
 * Copied verbatim from tmustier/pi-extensions @ session-recap v0.1.1.
 * Original author: Thomas Mustier. MIT licensed.
 * This copy lives in pi-extensions/packages/pi-session-recap for easier
 * local experimentation and tests; any upstream fixes should be pulled
 * through via a diff against the link above.
 *
 * Claude-Code-style session recap for pi. Two complementary triggers:
 *
 *   1) True terminal focus reporting via DECSET ?1004. When the terminal
 *      loses focus we start drafting a recap in the background; when it
 *      regains focus we reveal it in a widget above the editor. Mirrors
 *      Claude Code's "refocus the tab" moment.
 *
 *   2) Idle-return fallback: if the terminal doesn't support focus events,
 *      or the user stays in the same window, we still generate a recap N
 *      seconds after the last `turn_end` so something is waiting above the
 *      editor when they look back at the session. `turn_end` (not
 *      `agent_end`) is used so the fallback fires even when a turn ends
 *      in an error or is aborted by the user.
 *
 * Also fires on `/resume` (session_start reason="resume") to recap where
 * the prior session left off.
 *
 * Model: defaults to the user's currently active model with
 * `reasoning: "minimal"` when the model advertises reasoning support. This
 * piggybacks on whatever auth the user already has configured (including
 * custom providers) so there are no login surprises. Override explicitly
 * with `--recap-model "<provider>/<id>"` if you want a specific model.
 *
 * Flags:
 *   --recap-idle-seconds <n>      Seconds after turn_end for idle recap (default 120)
 *   --recap-focus-min-seconds <n> Min focus-out duration to show a recap (default 3)
 *   --recap-disable-focus         Disable DECSET ?1004 focus reporting
 *   --recap-disable               Disable the automatic recap entirely
 *   --recap-model <p/id>          Override the default (active) model
 *
 * Command:
 *   /recap                        Force-generate a recap right now
 */

import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import {
	buildRecentTranscript,
	buildStatusLine,
	type DisabledFlag,
	type Entry,
	firstLine,
	hasMeaningfulActivity,
	splitModel,
	type StatusLineOptions,
} from "./helpers.js";
import { migrateLegacyConfig, readUserRecapModel } from "./settings.js";

type Model = Parameters<typeof completeSimple>[0];

type RecapReason = "idle" | "manual" | "resume" | "focus";

/**
 * Namespace key for this extension's above-editor widget (`ctx.ui.setWidget`).
 * Prefixed with the full package name per tracker issue #0003 so keys in
 * the shared pi widget namespace are unambiguously attributable to their
 * owning package. Pre-#0003 builds used the bare literal `"session-recap"`.
 */
export const WIDGET_KEY = "pi-session-recap";
/**
 * Status-row namespace key for this extension. Prefixed with the full
 * package name so keys in the shared pi status-row namespace are
 * unambiguously attributable to their owning package (see tracker
 * issue #0002). `WIDGET_KEY` deliberately keeps its shorter form for
 * now — a separate follow-up would apply the same convention to the
 * `setWidget` namespace if desired.
 */
export const STATUS_KEY = "pi-session-recap";

const DEFAULT_IDLE_SECONDS = 180;
const DEFAULT_FOCUS_MIN_SECONDS = 3;

// DECSET 1004 focus reporting — https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN_SEQ = "\x1b[I";
const FOCUS_OUT_SEQ = "\x1b[O";

// --- helpers ---
// Pure string/content helpers live in ./helpers.ts so they can be unit-
// tested without pi-tui, pi-ai, or the terminal. Imported at the top.

async function generateRecap(
	transcript: string,
	ctx: ExtensionContext,
	overrideSpec: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	// Prefer explicit override flag; otherwise use the active model.
	let model: Model | undefined = ctx.model;
	if (overrideSpec) {
		const parsed = splitModel(overrideSpec);
		if (parsed) {
			const found = (getModel as (provider: string, id: string) => Model | undefined)(
				parsed.provider,
				parsed.id,
			);
			if (found) model = found;
		}
	}
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return undefined;

	const prompt =
		"You produce a single-line recap of what the coding agent just did, " +
		"so the user can re-enter flow after switching focus back to this session.\n\n" +
		"Rules:\n" +
		"- Output ONE line, no preamble, no markdown.\n" +
		"- Do not prefix with `recap:` — the UI already renders that label.\n" +
		"- Format: `goal: <overall goal>. <what just happened, past tense, concrete>. Next: <one-line next step>.`\n" +
		"- If the overall goal is unclear from the transcript, omit the `goal:` clause.\n" +
		"- If there is no meaningful next step, omit the `Next:` clause.\n" +
		"- If the transcript shows the turn was aborted or errored, say so explicitly " +
		'(e.g. "aborted during X", "errored at Y").\n' +
		"- Use file/function names where relevant. Be concrete, not vague.\n" +
		"- Skip: root-cause narrative, fix internals, secondary to-dos, em-dash tangents, motivational framing.\n" +
		"- Max ~220 characters.\n\n" +
		"<transcript>\n" +
		transcript.slice(0, 12000) +
		"\n</transcript>";

	const response = await completeSimple(
		model,
		{
			// Some providers (notably openai-codex-responses) require a non-empty
			// top-level instruction string even for simple one-shot completions.
			systemPrompt: "You write terse, concrete session recaps for a coding agent UI.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			...(auth.headers ? { headers: auth.headers } : {}),
			...(signal ? { signal } : {}),
			// Only request reasoning on reasoning-capable models. Non-reasoning
			// models ignore unknown params but we keep this clean.
			...(model.reasoning ? { reasoning: "minimal" as const } : {}),
		},
	);

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	return firstLine(text);
}

function showRecap(ctx: ExtensionContext, recap: string) {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const header = theme.fg("accent", theme.bold("✦ recap"));
	ctx.ui.setWidget(WIDGET_KEY, [header, theme.fg("dim", recap)], { placement: "aboveEditor" });
}

function clearRecap(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

// --- extension ---------------------------------------------------------------

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

	let idleTimer: NodeJS.Timeout | undefined;

	// Active recap request state. Only one request is ever in flight; starting
	// a new one aborts the previous. We track both the controller and the
	// reason so we can ask questions like "is there a focus draft running?"
	// without a separate boolean that can go out of sync on late completions.
	let activeController: AbortController | undefined;
	let activeReason: RecapReason | undefined;

	// Focus reporting state.
	let focusListener: ((chunk: Buffer) => void) | undefined;
	let focusEnabled = false;
	let focusedOutAt: number | undefined;
	let pendingRecap: string | undefined; // drafted while away, shown on refocus

	// Leaf-id of the branch state we last drafted for. Lets us skip regen on
	// refocus churn when nothing has happened in the session.
	let lastDraftedLeafId: string | undefined;

	const idleSeconds = (): number => {
		const n = Number(pi.getFlag("recap-idle-seconds") ?? DEFAULT_IDLE_SECONDS);
		return Math.max(5, Number.isFinite(n) ? n : DEFAULT_IDLE_SECONDS);
	};
	const focusMinSeconds = (): number => {
		const n = Number(pi.getFlag("recap-focus-min-seconds") ?? DEFAULT_FOCUS_MIN_SECONDS);
		return Math.max(0, Number.isFinite(n) ? n : DEFAULT_FOCUS_MIN_SECONDS);
	};
	const idleMs = (): number => idleSeconds() * 1000;
	const focusMinMs = (): number => focusMinSeconds() * 1000;
	const isDisabled = (): boolean => Boolean(pi.getFlag("recap-disable"));
	const isFocusDisabled = (): boolean => Boolean(pi.getFlag("recap-disable-focus"));
	/** Configured override spec — CLI flag wins over the config file; `null` when neither is set. */
	const configuredOverride = (): { source: "--recap-model" | "pi-session-recap.json"; spec: string } | null => {
		// `pi.registerFlag` stores keys without the `--` prefix; `pi.getFlag`
		// must use the same bare name. The user-facing label (`--recap-model`)
		// below stays prefixed because that IS how the user types it on the CLI.
		const cli = String(pi.getFlag("recap-model") ?? "").trim();
		if (cli.length > 0) return { source: "--recap-model", spec: cli };
		const fromFile = readUserRecapModel();
		if (fromFile) return { source: "pi-session-recap.json", spec: fromFile };
		return null;
	};
	const modelOverride = (): string | undefined => configuredOverride()?.spec;

	const clearTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};

	const cancelActive = () => {
		if (activeController) {
			activeController.abort();
			activeController = undefined;
			activeReason = undefined;
		}
	};

	const scheduleRecap = (ctx: ExtensionContext) => {
		clearTimer();
		if (isDisabled() || !ctx.hasUI) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			void generateAndShow(ctx, { reason: "idle" });
		}, idleMs());
	};

	const getLeafId = (ctx: ExtensionContext): string | undefined => {
		try {
			return ctx.sessionManager.getLeafId() ?? undefined;
		} catch {
			return undefined;
		}
	};

	const generateAndShow = async (ctx: ExtensionContext, opts: { reason: RecapReason }) => {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		if (!hasMeaningfulActivity(entries) && opts.reason !== "manual") return;

		const transcript = buildRecentTranscript(entries, opts.reason !== "resume");
		if (!transcript.trim()) return;

		// Snapshot the leaf we're summarising BEFORE we await. If the branch
		// advances while the model call is in flight, the recap reflects stale
		// content — we must discard it rather than stamp the wrong leaf.
		const startLeaf = getLeafId(ctx);

		// Take ownership of the active-request slot. Any prior request is
		// cancelled; we'll only clear shared state in the finally if we're
		// still the current owner, so a late-completing aborted call can't
		// stomp on a newer in-flight request.
		cancelActive();
		const controller = new AbortController();
		activeController = controller;
		activeReason = opts.reason;

		const showStatus = opts.reason !== "resume" && opts.reason !== "focus";
		if (showStatus && ctx.hasUI)
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "✦ drafting recap…"));

		try {
			const recap = await generateRecap(transcript, ctx, modelOverride(), controller.signal);
			if (!recap || controller.signal.aborted) return;
			// Discard the recap if the branch moved on while we were drafting.
			if (getLeafId(ctx) !== startLeaf) return;

			// Stamp with the leaf we actually summarised, not the live one.
			lastDraftedLeafId = startLeaf;
			// Another trigger has now produced a recap for this leaf — kill the
			// idle fallback so we don't issue a second call 120s later.
			clearTimer();

			if (opts.reason === "focus") {
				if (focusedOutAt === undefined) showRecap(ctx, recap);
				else pendingRecap = recap;
			} else {
				showRecap(ctx, recap);
			}
		} catch (err) {
			if (!controller.signal.aborted) console.error("[session-recap] failed:", err);
		} finally {
			if (activeController === controller) {
				activeController = undefined;
				activeReason = undefined;
				if (showStatus && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}
	};

	// --- focus reporting wiring -------------------------------------------

	const handleFocusOut = (ctx: ExtensionContext) => {
		focusedOutAt = Date.now();
		if (isDisabled() || activeController) return;

		// Skip regen if we already have a fresh recap for the current session
		// state — regardless of whether it's still parked in pendingRecap or
		// already shown in the widget. The stamp is invalidated on any new
		// turn_end / input / agent_start.
		const leaf = getLeafId(ctx);
		if (lastDraftedLeafId && leaf === lastDraftedLeafId) return;

		const entries = ctx.sessionManager.getBranch() as Entry[];
		if (!hasMeaningfulActivity(entries)) return;
		void generateAndShow(ctx, { reason: "focus" });
	};

	const handleFocusIn = (ctx: ExtensionContext) => {
		const outAt = focusedOutAt;
		focusedOutAt = undefined;
		if (outAt === undefined) return; // spurious focus-in before we saw focus-out
		const duration = Date.now() - outAt;
		if (duration < focusMinMs()) {
			// Quick glance — discard any parked recap AND cancel an in-flight
			// focus draft so a slow model response can't bypass min-seconds.
			// Also clear the leaf stamp, otherwise a later real absence at the
			// same leaf would skip regen and never surface a recap.
			pendingRecap = undefined;
			lastDraftedLeafId = undefined;
			if (activeReason === "focus") cancelActive();
			return;
		}
		if (pendingRecap) {
			const recap = pendingRecap;
			pendingRecap = undefined;
			showRecap(ctx, recap);
		}
		// Still drafting? generateAndShow's success-path will reveal it when done.
	};

	const attachFocusReporting = (ctx: ExtensionContext) => {
		if (focusEnabled || isFocusDisabled() || !ctx.hasUI) return;
		if (!process.stdout.isTTY || !process.stdin.isTTY) return;

		try {
			process.stdout.write(FOCUS_ENABLE);
		} catch {
			return;
		}

		// Scan stdin for ESC[I / ESC[O. Sequences can straddle chunks, so we
		// keep unconsumed trailing bytes in `buf` between calls. Consume each
		// match by advancing `i`, so a completed sequence never fires twice.
		// Adding a 'data' listener is safe: Node dispatches to all listeners
		// and pi is already in flowing mode — we don't steal bytes from the
		// TUI's input layer.
		const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);
		let buf = "";
		const listener = (chunk: Buffer) => {
			try {
				buf += chunk.toString("binary");
				let i = 0;
				while (i + MAX_SEQ <= buf.length) {
					if (buf.startsWith(FOCUS_IN_SEQ, i)) {
						handleFocusIn(ctx);
						i += FOCUS_IN_SEQ.length;
					} else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
						handleFocusOut(ctx);
						i += FOCUS_OUT_SEQ.length;
					} else {
						i++;
					}
				}
				buf = buf.slice(i);
				// Safety net — never let buf grow unbounded if we're reading a
				// long non-escape stream on a terminal that streams ahead of us.
				if (buf.length > 64) buf = buf.slice(-(MAX_SEQ - 1));
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
		focusedOutAt = undefined;
		pendingRecap = undefined;
	};

	// Lifecycle: idle timer arms on turn_end (fires even on error/abort),
	// and is cleared on anything that indicates new activity or input.

	pi.on("turn_end", async (_event, ctx) => {
		// A new turn (successful or not) invalidates any prior draft.
		lastDraftedLeafId = undefined;
		scheduleRecap(ctx);
	});

	pi.on("turn_start", async () => {
		// Another turn is starting in the same agent loop — clear the idle timer
		// we armed on the previous turn_end; it'll re-arm on the next turn_end.
		clearTimer();
	});

	pi.on("input", async (_event, ctx) => {
		clearTimer();
		cancelActive();
		pendingRecap = undefined;
		lastDraftedLeafId = undefined;
		clearRecap(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		clearTimer();
		cancelActive();
		pendingRecap = undefined;
		lastDraftedLeafId = undefined;
		clearRecap(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		cancelActive();
		detachFocusReporting();
	});

	// Session start: wire up focus reporting; on resume, show a recap.
	pi.on("session_start", async (event, ctx) => {
		// One-shot, silent migration to `<agentDir>/pi-session-recap.json`
		// (tracker issues #0005 + #0006). Must run before any read path so
		// `configuredOverride` sees the migrated file on first session after
		// upgrade. Never raises; legacy sources are ignored from here on.
		try {
			migrateLegacyConfig(getAgentDir(), process.env);
		} catch {
			/* defensive — migrateLegacyConfig swallows internally, but belt-and-braces */
		}
		attachFocusReporting(ctx);
		if (isDisabled()) return;
		if (event.reason === "resume" || event.reason === "fork") {
			setTimeout(() => {
				void generateAndShow(ctx, { reason: "resume" });
			}, 300);
		}
	});

	// Resolve the active model's display spec for the status line. Falls back
	// to a sentinel when pi hasn't bound a model yet (e.g. headless/no-auth
	// dry runs) so the status output stays informative.
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
	/**
	 * customType for both `/recap status` and `/recap help` chat-scroll output.
	 * These are informational replies, not a recap emission — the "subcommand"
	 * suffix keeps them distinguishable from any future recap-message payloads
	 * this extension might grow without forking a fresh renderer per sub.
	 */
	const SUBCOMMAND_MESSAGE_TYPE = "pi-session-recap:subcommand";

	// #0008: chromeless renderer for /recap status and /recap help so pi's
	// default custom-message display doesn't stamp the literal
	// `[pi-session-recap:subcommand]` routing-key label into the user's
	// transcript. The customType is kept on the message itself for future
	// filtering / persistence; we just stop letting pi paint its name on
	// the user's screen. Padding is 0/0 to match how pi's own plain info
	// messages render — no border, no header, no decoration.
	pi.registerMessageRenderer(SUBCOMMAND_MESSAGE_TYPE, (message) => {
		// `CustomMessage.content` is typed as `string | (TextContent | ImageContent)[]`;
		// this extension only ever sends string content via `pi.sendMessage`, but
		// narrow defensively so a stray array form can't crash the renderer.
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		return new Text(text, 0, 0);
	});

	// Manual command.
	pi.registerCommand("recap", {
		description: "Generate a one-line recap, or show status (/recap status)",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "") {
				await generateAndShow(ctx, { reason: "manual" });
				return;
			}
			if (sub === "status") {
				// Chat-scroll message (not a toast) so the configuration sticks
				// around for the user to scroll back to. `triggerTurn: false`
				// because this is informational — it must never cause an agent
				// turn to fire.
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
			if (sub === "help") {
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
			// Unknown subcommand: user-input error, keep as a transient toast so
			// typos don't pollute the chat scroll.
			if (ctx.hasUI)
				ctx.ui.notify(
					`Unknown /recap subcommand: "${sub}". Valid subcommands: ${VALID_SUBCOMMANDS.join(", ")}.`,
					"warning",
				);
		},
	});
}
