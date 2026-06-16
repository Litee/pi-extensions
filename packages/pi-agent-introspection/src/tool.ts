/**
 * get_session_debug_info tool
 *
 * Lets the agent introspect the current session in configurable detail:
 * metadata, token usage, extension entries by customType, the full
 * assembled system prompt, or the structured system prompt inputs.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BuildSystemPromptOptions,
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
	system_prompt_options: Type.Optional(
		Type.Boolean({
			description:
				"Include structured system prompt inputs: skill names/paths, context file paths, " +
				"selected tools, appendSystemPrompt length, and guidelines count. Default false.",
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
	/** Structured system prompt inputs, or undefined if not fetched / API unavailable. */
	systemPromptOptions: BuildSystemPromptOptions | undefined;
	// Section flags
	metadata: boolean;
	usage: boolean;
	showEntries: boolean;
	showSystemPrompt: boolean;
	showSystemPromptOptions: boolean;
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
		systemPromptOptions,
		metadata,
		usage,
		showEntries,
		showSystemPrompt,
		showSystemPromptOptions,
		filter,
	} = opts;

	// Guard: if nothing requested, return helpful hint
	if (!metadata && !usage && !showEntries && !showSystemPrompt && !showSystemPromptOptions && !filter) {
		return (
			"No sections requested. Pass one or more flags to select what to include.\n" +
			"Available sections: metadata, usage, entries, system_prompt, system_prompt_options."
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

	// ── System Prompt Inputs ──────────────────────────────────────────────────
	if (showSystemPromptOptions) {
		lines.push("## System Prompt Inputs");
		lines.push("");

		if (!systemPromptOptions) {
			lines.push("- Not available (ctx.getSystemPromptOptions() is not supported by this version of pi)");
		} else {
			const skills = systemPromptOptions.skills ?? [];
			const contextFiles = systemPromptOptions.contextFiles ?? [];
			const selectedTools = systemPromptOptions.selectedTools ?? [];
			const appendLen = systemPromptOptions.appendSystemPrompt?.length ?? 0;
			const guidelinesCount = systemPromptOptions.promptGuidelines?.length ?? 0;

			// Skills
			lines.push(`**Skills:** ${skills.length}`);
			if (skills.length > 0) {
				for (const skill of skills) {
					// Skill type from system-prompt.d.ts has `name` and `filePath`
					const skillPath = (skill as { name: string; filePath?: string; path?: string }).filePath
						?? (skill as { name: string; filePath?: string; path?: string }).path
						?? "(unknown path)";
					lines.push(`- ${skill.name} (${skillPath})`);
				}
			}
			lines.push("");

			// Context files (paths only — not content)
			lines.push(`**Context files:** ${contextFiles.length}`);
			if (contextFiles.length > 0) {
				for (const cf of contextFiles) {
					lines.push(`- ${cf.path}`);
				}
			}
			lines.push("");

			// Selected tools
			lines.push(`**Selected tools:** ${selectedTools.length > 0 ? selectedTools.join(", ") : "(none)"}`);
			lines.push("");

			// Append system prompt
			lines.push(
				`**Append system prompt:** ${appendLen > 0 ? `${appendLen.toLocaleString()} chars` : "(none)"}`,
			);
			lines.push("");

			// Prompt guidelines
			lines.push(`**Prompt guidelines:** ${guidelinesCount}`);
		}
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
			"token usage, session entries grouped by customType, the assembled system prompt, or " +
			"structured system prompt inputs (skills, context files, selected tools, guidelines). " +
			"Use this for debugging extension behavior, checking what extensions wrote into the " +
			"session, or seeing what instructions the agent is running with.",
		promptSnippet:
			"get_session_debug_info: view session metadata, token usage, extension entries, system prompt, or system prompt inputs",
		parameters: ParamsSchema,
		execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<{ debugInfo: string }>> {
			// Resolve section flags (defaults: metadata/usage/entries = true, system_prompt/system_prompt_options = false)
			const wantMetadata = params.metadata ?? true;
			const wantUsage = params.usage ?? true;
			const wantEntries = params.entries ?? true;
			const wantSystemPrompt = params.system_prompt ?? false;
			const wantSystemPromptOptions = params.system_prompt_options ?? false;

			// getSystemPromptOptions() is a new API (pi 0.78.0) — fall back gracefully
			let systemPromptOptions: BuildSystemPromptOptions | undefined;
			if (wantSystemPromptOptions) {
				try {
					const ctxAny = ctx as unknown as Record<string, unknown>;
					if (typeof ctxAny["getSystemPromptOptions"] === "function") {
						systemPromptOptions = (ctxAny["getSystemPromptOptions"] as () => BuildSystemPromptOptions)();
					}
				} catch {
					// API unavailable — leave undefined
				}
			}

			const text = formatSessionDebugInfo({
				sessionId: ctx.sessionManager.getSessionId(),
				leafId: ctx.sessionManager.getLeafId(),
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile(),
				contextUsage: ctx.getContextUsage(),
				entries: wantEntries ? ctx.sessionManager.getEntries() : [],
				systemPrompt: wantSystemPrompt ? ctx.getSystemPrompt() : undefined,
				systemPromptOptions,
				metadata: wantMetadata,
				usage: wantUsage,
				showEntries: wantEntries,
				showSystemPrompt: wantSystemPrompt,
				showSystemPromptOptions: wantSystemPromptOptions,
				filter: params.filter,
			});

			return Promise.resolve({
				content: [{ type: "text", text }],
				details: { debugInfo: text },
			});
		},
	});
}
