/**
 * Pure token-estimation helpers for pi-context-window-analysis.
 *
 * No pi-ai / pi-coding-agent / pi-tui imports here so these functions
 * can be exercised by unit tests without a live pi runtime.
 */

/** Skill shape as expected from BuildSystemPromptOptions.skills */
export interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
}

/** Context file shape from BuildSystemPromptOptions.contextFiles */
export interface ContextFileEntry {
	path: string;
	content: string;
}

/**
 * Partial view of BuildSystemPromptOptions used for per-section estimation.
 * Mirrors the pi-coding-agent type but avoids a direct import so the module
 * can be loaded by unit tests without the full runtime.
 */
export interface SystemPromptOptions {
	appendSystemPrompt?: string;
	contextFiles?: ContextFileEntry[];
}

/** Per-context-file token estimate. */
export interface ContextFileBreakdown {
	path: string;
	tokens: number;
}

/** Token breakdown for the system prompt. */
export interface SystemPromptBreakdown {
	/** Total estimated tokens in the full system prompt. */
	total: number;
	/** Core pi instructions — the residual after removing all measured sections. */
	core: number;
	/** Tokens for the "Available tools:" section, measured from the prompt string. */
	tools: number;
	/** Number of tool entries in the "Available tools:" section. */
	toolCount: number;
	/** Tokens for the "Guidelines:" section. */
	guidelines: number;
	/** Tokens estimated from appendSystemPrompt (from options). */
	appendSystemPrompt: number;
	/** Per-file token estimates from contextFiles. */
	contextFiles: ContextFileBreakdown[];
	/** Tokens for the full skills catalog block, measured from the prompt string. */
	skillsCatalog: number;
	/** Number of skills in the catalog. */
	skillCount: number;
}

/** Token breakdown for the conversation history. */
export interface ConversationBreakdown {
	/** Total estimated conversation tokens. */
	total: number;
	/** Tokens from user messages. */
	userMessages: number;
	/** Tokens from assistant output messages. */
	assistantOutput: number;
	/** Tokens from tool result messages. */
	toolResults: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rough token estimate using the same chars/4 heuristic pi uses internally.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// System-prompt section scanners
//
// We scan the assembled systemPrompt string for known section markers rather
// than reconstructing sections from options. This is more accurate because
// options.toolSnippets does not include built-in tool snippets (they are
// managed internally by pi and never surfaced in systemPromptOptions).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the substring that starts at `startMarker` and ends just before the
 * first occurrence of any `endMarkers` (searching after startMarker). Returns
 * "" when startMarker is not found.
 */
function sliceBetween(text: string, startMarker: string, endMarkers: string[]): string {
	const start = text.indexOf(startMarker);
	if (start < 0) return "";
	let end = text.length;
	for (const m of endMarkers) {
		const idx = text.indexOf(m, start + startMarker.length);
		if (idx >= 0 && idx < end) end = idx;
	}
	return text.slice(start, end);
}

/** Extract the "Available tools:" section and count tool entries. */
function scanTools(systemPrompt: string): { tokens: number; count: number } {
	const section = sliceBetween(systemPrompt, "Available tools:\n", [
		"\n\nIn addition to the tools above",
		"\nIn addition to the tools above",
		"\n\nGuidelines:",
	]);
	const count = (section.match(/^- /gm) ?? []).length;
	return { tokens: estimateTokens(section), count };
}

/** Extract the "Guidelines:" section. */
function scanGuidelines(systemPrompt: string): number {
	const section = sliceBetween(systemPrompt, "Guidelines:\n", [
		"\n\nPi documentation",
		"\n\n# Project Context",
		"\n\nCurrent date:",
	]);
	return estimateTokens(section);
}

/** Extract the full skills catalog block and count skills. */
function scanSkills(systemPrompt: string): { tokens: number; count: number } {
	const PREAMBLE = "\n\nThe following skills provide specialized instructions";
	const END = "</available_skills>";
	const start = systemPrompt.indexOf(PREAMBLE);
	const end = systemPrompt.indexOf(END);
	if (start < 0 || end < 0 || end < start) return { tokens: 0, count: 0 };
	const section = systemPrompt.slice(start, end + END.length);
	const count = (section.match(/<skill>/g) ?? []).length;
	return { tokens: estimateTokens(section), count };
}

/**
 * Estimate the token contribution of each context file by finding its section
 * header in the assembled systemPrompt and measuring to the next header.
 * Falls back to estimating from the raw file content when the section is not
 * found (e.g. custom prompt that embeds files differently).
 */
function scanContextFiles(
	systemPrompt: string,
	contextFiles: ContextFileEntry[],
): ContextFileBreakdown[] {
	return contextFiles.map((f) => {
		const header = `## ${f.path}\n\n`;
		const headerIdx = systemPrompt.indexOf(header);
		if (headerIdx < 0) {
			return { path: f.path, tokens: estimateTokens(f.content) };
		}
		// Measure to the next "## " header or to a known post-context marker.
		const contentStart = headerIdx;
		const endMarkers = ["\n## ", "\n\nThe following skills", "\nCurrent date:"];
		let end = systemPrompt.length;
		for (const m of endMarkers) {
			const idx = systemPrompt.indexOf(m, headerIdx + header.length);
			if (idx >= 0 && idx < end) end = idx;
		}
		return { path: f.path, tokens: estimateTokens(systemPrompt.slice(contentStart, end)) };
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Public breakdown builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a per-section token breakdown for the system prompt.
 *
 * Sections are measured by scanning the assembled `systemPrompt` string for
 * known structural markers. This handles built-in tools correctly (their
 * snippets are not present in `options.toolSnippets`).
 *
 * @param systemPrompt  The fully-assembled system prompt string (from
 *                      `event.systemPrompt` in `before_agent_start`).
 * @param options       Structured options from `event.systemPromptOptions`.
 *                      Pass `undefined` when not available.
 */
export function buildSystemPromptBreakdown(
	systemPrompt: string,
	options: SystemPromptOptions | undefined,
): SystemPromptBreakdown {
	const total = estimateTokens(systemPrompt);

	if (!systemPrompt) {
		return {
			total: 0,
			core: 0,
			tools: 0,
			toolCount: 0,
			guidelines: 0,
			appendSystemPrompt: 0,
			contextFiles: [],
			skillsCatalog: 0,
			skillCount: 0,
		};
	}

	const toolsScan = scanTools(systemPrompt);
	const guidelines = scanGuidelines(systemPrompt);
	const skillsScan = scanSkills(systemPrompt);
	const contextFiles = scanContextFiles(systemPrompt, options?.contextFiles ?? []);
	const contextFilesTotal = contextFiles.reduce((sum, f) => sum + f.tokens, 0);
	const appendSP = estimateTokens(options?.appendSystemPrompt ?? "");

	const measured = toolsScan.tokens + guidelines + skillsScan.tokens + contextFilesTotal + appendSP;
	const core = Math.max(0, total - measured);

	return {
		total,
		core,
		tools: toolsScan.tokens,
		toolCount: toolsScan.count,
		guidelines,
		appendSystemPrompt: appendSP,
		contextFiles,
		skillsCatalog: skillsScan.tokens,
		skillCount: skillsScan.count,
	};
}

/** Minimal shape for a session branch entry understood by this module. */
export interface MessageEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		/** Text content — a string, or an array of content blocks. */
		content: string | Array<{ type: string; text?: string }> | unknown;
		/** Usage stats — only present on assistant messages. */
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		};
	};
}

export type BranchEntry = MessageEntry | { type: string };

/** Stringify any message content shape to a plain string for token estimation. */
function contentToText(
	content: string | Array<{ type: string; text?: string }> | unknown,
): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(c): c is { type: string; text: string } =>
					typeof c === "object" &&
					c !== null &&
					typeof (c as Record<string, unknown>)["text"] === "string",
			)
			.map((c) => c.text)
			.join("\n");
	}
	return String(content ?? "");
}

/**
 * Compute a per-role token breakdown for the current conversation branch.
 *
 * @param entries  Branch entries from `ctx.sessionManager.getBranch()`.
 */
export function buildConversationBreakdown(entries: BranchEntry[]): ConversationBreakdown {
	let userMessages = 0;
	let assistantOutput = 0;
	let toolResults = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = (entry as MessageEntry).message;

		if (msg.role === "user") {
			userMessages += estimateTokens(contentToText(msg.content));
		} else if (msg.role === "assistant") {
			if (msg.usage?.output !== undefined) {
				assistantOutput += msg.usage.output;
			} else {
				assistantOutput += estimateTokens(contentToText(msg.content));
			}
		} else if (msg.role === "toolResult") {
			toolResults += estimateTokens(contentToText(msg.content));
		}
	}

	return {
		total: userMessages + assistantOutput + toolResults,
		userMessages,
		assistantOutput,
		toolResults,
	};
}
