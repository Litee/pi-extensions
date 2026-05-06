/**
 * pi-context-window-analysis
 *
 * Adds a `/context` command that renders a per-component token breakdown
 * widget above the editor — similar to Claude Code's `/context` command.
 *
 * Commands:
 *   /context            Toggle the breakdown widget on/off.
 *   /context refresh    Force-refresh the widget without toggling.
 *   /context help       Post a help message to chat.
 *
 * The widget shows:
 *  - System prompt: core instructions / tools / guidelines / context files /
 *    skills catalog
 *  - Conversation: user messages / assistant output / tool results
 *  - Last turn (actual): input, cache read/write, output, cost
 *  - Total context vs window size
 *
 * Security notes
 * ──────────────
 *   No network calls, no filesystem writes, no process spawns.
 *   APIs touched: pi.registerCommand, pi.on, ctx.ui.setWidget,
 *   ctx.sessionManager.getBranch, ctx.getContextUsage.
 */

import type {
	BeforeAgentStartEvent,
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, Text } from "@mariozechner/pi-tui";

import {
	buildConversationBreakdown,
	buildSystemPromptBreakdown,
	type BranchEntry,
	type SystemPromptOptions,
} from "./breakdown.js";
import { buildWidgetLines, type LastTurnUsage, NO_THEME, type RenderTheme } from "./render.js";

const WIDGET_KEY = "pi-context-window-analysis";

const HELP_TEXT = [
	"Context Window Analysis",
	"",
	"Commands:",
	"  /context           Toggle the breakdown widget on/off",
	"  /context refresh   Force-refresh without toggling",
	"  /context help      Show this help text",
	"",
	"The widget shows a per-component token breakdown of the system prompt,",
	"conversation history, and the last turn's actual API usage.",
].join("\n");

function adaptOptions(raw: BuildSystemPromptOptions): SystemPromptOptions {
	const result: SystemPromptOptions = {};
	if (raw.appendSystemPrompt !== undefined) result.appendSystemPrompt = raw.appendSystemPrompt;
	if (raw.contextFiles !== undefined) result.contextFiles = raw.contextFiles;
	return result;
}

function collectLastUsage(ctx: ExtensionContext): LastTurnUsage | undefined {
	try {
		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		// Walk backwards to find the last assistant message with usage.
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "message") continue;
			const msg = (entry as { type: "message"; message: AssistantMessage }).message;
			if (msg.role !== "assistant") continue;
			if (!msg.usage) continue;
			return {
				input: msg.usage.input,
				output: msg.usage.output,
				cacheRead: msg.usage.cacheRead,
				cacheWrite: msg.usage.cacheWrite,
				cost: msg.usage.cost.total,
			};
		}
	} catch {
		/* best-effort */
	}
	return undefined;
}

function renderWidget(
	systemPrompt: string,
	options: SystemPromptOptions | undefined,
	ctx: ExtensionContext,
	theme: RenderTheme,
): string[] {
	const sp = buildSystemPromptBreakdown(systemPrompt, options);
	const branch = ctx.sessionManager.getBranch() as BranchEntry[];
	const conv = buildConversationBreakdown(branch);
	const usage = collectLastUsage(ctx);
	const ctxUsage = ctx.getContextUsage();
	const ctxWindow = ctxUsage?.contextWindow ?? 200_000;
	return buildWidgetLines(sp, conv, usage, ctxWindow, theme);
}

export default function contextWindowAnalysis(pi: ExtensionAPI): void {
	let widgetVisible = false;
	let lastSystemPrompt = "";
	let lastOptions: SystemPromptOptions | undefined;

	/**
	 * Render the widget using the factory-function overload of setWidget so the
	 * content is not subject to pi's MAX_WIDGET_LINES = 10 line cap that applies
	 * to the string-array overload.
	 */
	function setWidget(ctx: ExtensionContext, systemPrompt: string, options: SystemPromptOptions | undefined): void {
		ctx.ui.setWidget(WIDGET_KEY, (_tui, widgetTheme) => {
			const lines = renderWidget(systemPrompt, options, ctx, widgetTheme as unknown as RenderTheme);
			const container = new Container();
			for (const line of lines) {
				container.addChild(new Text(line, 1, 0));
			}
			return container;
		});
	}

	// Capture system prompt + options from the start of each agent run.
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
		lastSystemPrompt = event.systemPrompt;
		lastOptions = adaptOptions(event.systemPromptOptions);
	});

	// Refresh widget after each turn ends (if visible).
	pi.on("turn_end", async (_event, ctx) => {
		if (!widgetVisible || !ctx.hasUI) return;
		setWidget(ctx, lastSystemPrompt, lastOptions);
	});

	// Clear on session shutdown.
	pi.on("session_shutdown", async () => {
		widgetVisible = false;
	});

	pi.registerCommand("context", {
		description:
			"Toggle a per-component context-window breakdown widget (use 'refresh' to force-refresh, 'help' for help)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();

			if (sub === "help") {
				if (ctx.hasUI) {
					ctx.ui.notify(HELP_TEXT, "info");
				}
				return;
			}

			const forceRefresh = sub === "refresh";

			if (!forceRefresh) {
				// Toggle
				widgetVisible = !widgetVisible;
			}

			if (!widgetVisible && !forceRefresh) {
				// Turning off: clear the widget.
				if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}

			// Show/refresh widget.
			widgetVisible = true;

			if (!ctx.hasUI) {
				// Non-interactive mode: print to stdout as plain text.
				const lines = renderWidget(lastSystemPrompt, lastOptions, ctx, NO_THEME);
				for (const line of lines) {
					process.stdout.write(line + "\n");
				}
				return;
			}

			setWidget(ctx, lastSystemPrompt, lastOptions);
		},
	});
}
