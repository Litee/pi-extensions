/**
 * get_session_debug_info tool
 *
 * Lets the agent introspect the current session in configurable detail:
 * metadata, token usage, extension entries by customType, or the full
 * assembled system prompt.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry, ContextUsage } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ParamsSchema = Type.Object({
	metadata: Type.Optional(
		Type.Boolean({
			description: "Include session ID, leaf ID, CWD, and session file. Default true.",
		}),
	),
	usage: Type.Optional(
		Type.Boolean({
			description: "Include token usage (from ctx.getContextUsage()). Default true.",
		}),
	),
	entries: Type.Optional(
		Type.Boolean({
			description:
				"Include session entries grouped by customType. Default true.",
		}),
	),
	system_prompt: Type.Optional(
		Type.Boolean({
			description:
				"Include the full assembled system prompt. Potentially large — default false.",
		}),
	),
	filter: Type.Optional(
		Type.String({
			description:
				"Filter custom entries by customType prefix (e.g. 'goal:' or 'pi-plan'). Only applies when entries is true.",
		}),
	),
});

export type Params = Static<typeof ParamsSchema>;

// ---------------------------------------------------------------------------
// Pure formatting helper (extracted for testability)
// ---------------------------------------------------------------------------

export interface CustomGroupSummary {
	count: number;
	latestData: unknown;
}

/**
 * Typed options for the pure formatter.
 * All data is passed in by the thin execute() wrapper so tests don't need to
 * mock ExtensionContext.
 */
export interface FormatSessionDebugInfoOpts {
	// Data
	sessionId: string;
	leafId: string | null;
	cwd: string;
	sessionFile: string | undefined;
	contextUsage: ContextUsage | undefined;
	entries: readonly SessionEntry[];
	/** System prompt text, or undefined if not fetched. */
	systemPrompt: string | undefined;
	// Section flags
	metadata: boolean;
	usage: boolean;
	showEntries: boolean;
	showSystemPrompt: boolean;
	filter?: string | undefined;
}

/**
 * Pure function: given all data and section flags, returns a formatted
 * inspection string with ## Section headings.
 */
export function formatSessionDebugInfo(opts: FormatSessionDebugInfoOpts): string {
	const {
		sessionId,
		leafId,
		cwd,
		sessionFile,
		contextUsage,
		entries,
		systemPrompt,
		metadata,
		usage,
		showEntries,
		showSystemPrompt,
		filter,
	} = opts;

	// Guard: if nothing requested, return helpful hint
	if (!metadata && !usage && !showEntries && !showSystemPrompt && !filter) {
		return (
			"No sections requested. Pass one or more flags to select what to include.\n" +
			"Available sections: metadata, usage, entries, system_prompt."
		);
	}

	const lines: string[] = [];

	// ── Metadata ─────────────────────────────────────────────────────────────
	if (metadata) {
		lines.push("## Metadata");
		lines.push("");
		lines.push(`**Session ID:** ${sessionId}`);
		lines.push(`**Leaf ID:** ${leafId ?? "(none)"}`);
		lines.push(`**CWD:** ${cwd}`);
		lines.push(`**Session file:** ${sessionFile ?? "(none)"}`);
		lines.push("");
	}

	// ── Token Usage ──────────────────────────────────────────────────────────
	if (usage) {
		lines.push("## Token Usage");
		lines.push("");
		if (contextUsage) {
			const pct =
				contextUsage.percent != null ? `${contextUsage.percent.toFixed(1)}%` : "unknown";
			const tok =
				contextUsage.tokens != null
					? contextUsage.tokens.toLocaleString()
					: "unknown";
			lines.push(
				`- Tokens used: ${tok} / ${contextUsage.contextWindow.toLocaleString()} (${pct})`,
			);
		} else {
			lines.push("- Not available");
		}
		lines.push("");
	}

	// ── Session Entries ───────────────────────────────────────────────────────
	if (showEntries) {
		// Count entries by type
		const countsByType: Record<string, number> = {};
		for (const entry of entries) {
			countsByType[entry.type] = (countsByType[entry.type] ?? 0) + 1;
		}

		// Group custom entries by customType
		const customGroups: Record<string, CustomGroupSummary> = {};
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			const { customType, data } = entry;

			// Apply prefix filter if provided
			if (filter && !customType.startsWith(filter)) continue;

			if (!customGroups[customType]) {
				customGroups[customType] = { count: 0, latestData: undefined };
			}
			customGroups[customType].count += 1;
			customGroups[customType].latestData = data;
		}

		lines.push("## Session Entries");
		lines.push("");

		lines.push("### Entry Counts by Type");
		if (Object.keys(countsByType).length === 0) {
			lines.push("- (no entries)");
		} else {
			for (const [type, count] of Object.entries(countsByType).sort()) {
				lines.push(`- ${type}: ${count}`);
			}
		}
		lines.push("");

		const filterNote = filter ? ` (filtered by prefix: "${filter}")` : "";
		lines.push(`### Custom Extension Entries${filterNote}`);
		if (Object.keys(customGroups).length === 0) {
			lines.push("- (none)");
		} else {
			for (const [customType, summary] of Object.entries(customGroups).sort()) {
				lines.push(`#### ${customType} (${summary.count} entry/entries)`);
				lines.push("Latest data:");
				lines.push("```json");
				lines.push(JSON.stringify(summary.latestData, null, 2));
				lines.push("```");
			}
		}
		lines.push("");
	}

	// ── System Prompt ─────────────────────────────────────────────────────────
	if (showSystemPrompt) {
		const text = systemPrompt ?? "";
		const charCount = text.length.toLocaleString();
		lines.push(`## System Prompt (${charCount} chars)`);
		lines.push("");
		lines.push("```");
		lines.push(text);
		lines.push("```");
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSessionDebugInfoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "get_session_debug_info",
		label: "Get Session Debug Info",
		description:
			"Get debug info about the current pi agent session. Pick which details to include: metadata, " +
			"token usage, session entries grouped by customType, or the assembled system prompt. " +
			"Use this for debugging extension behavior, checking what extensions wrote into the " +
			"session, or seeing what instructions the agent is running with.",
		promptSnippet:
			"get_session_debug_info: view session metadata, token usage, extension entries, or system prompt",
		parameters: ParamsSchema,
		// eslint-disable-next-line @typescript-eslint/require-await -- Tool execute() must return a Promise; the work itself is synchronous.
		async execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<{ debugInfo: string }>> {
			// Resolve section flags (defaults: metadata/usage/entries = true, system_prompt = false)
			const wantMetadata = params.metadata ?? true;
			const wantUsage = params.usage ?? true;
			const wantEntries = params.entries ?? true;
			const wantSystemPrompt = params.system_prompt ?? false;

			const text = formatSessionDebugInfo({
				sessionId: ctx.sessionManager.getSessionId(),
				leafId: ctx.sessionManager.getLeafId(),
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile(),
				contextUsage: ctx.getContextUsage(),
				entries: wantEntries ? ctx.sessionManager.getEntries() : [],
				systemPrompt: wantSystemPrompt ? ctx.getSystemPrompt() : undefined,
				metadata: wantMetadata,
				usage: wantUsage,
				showEntries: wantEntries,
				showSystemPrompt: wantSystemPrompt,
				filter: params.filter,
			});

			return {
				content: [{ type: "text", text }],
				details: { debugInfo: text },
			};
		},
	});
}
