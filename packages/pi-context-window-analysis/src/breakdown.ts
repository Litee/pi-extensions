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
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	contextFiles?: ContextFileEntry[];
	skills?: SkillEntry[];
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
	/** Core pi instructions + tools list — the "residual" after removing all known sections. */
	core: number;
	/** Tokens estimated from toolSnippets. */
	tools: number;
	/** Tokens estimated from promptGuidelines. */
	guidelines: number;
	/** Tokens estimated from appendSystemPrompt. */
	appendSystemPrompt: number;
	/** Per-file token estimates from contextFiles. */
	contextFiles: ContextFileBreakdown[];
	/** Tokens estimated from the skills catalog XML block. */
	skillsCatalog: number;
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

// ────────────────────────────────────────────────────────────────────────────
// Core helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Rough token estimate using the same chars/4 heuristic pi uses internally.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

// ────────────────────────────────────────────────────────────────────────────
// Section reconstruction helpers (package-internal)
// ────────────────────────────────────────────────────────────────────────────

/** Reconstruct the tools section text from toolSnippets. */
function toolsText(options: SystemPromptOptions): string {
	const snippets = options.toolSnippets ?? {};
	const entries = Object.entries(snippets);
	if (entries.length === 0) return "";
	return entries.map(([name, snippet]) => `${name}: ${snippet}`).join("\n");
}

/** Reconstruct the guidelines section text. */
function guidelinesText(options: SystemPromptOptions): string {
	return (options.promptGuidelines ?? []).join("\n");
}

/** Reconstruct each context file's section text (mirrors buildSystemPrompt). */
function contextFileSectionText(file: ContextFileEntry): string {
	return `## ${file.path}\n\n${file.content}\n\n`;
}

/** Reconstruct the skills catalog XML block. */
function skillsCatalogText(skills: SkillEntry[]): string {
	if (skills.length === 0) return "";
	const items = skills
		.map(
			(s) =>
				`  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.filePath}</location>\n  </skill>`,
		)
		.join("\n");
	return `<available_skills>\n${items}\n</available_skills>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Public breakdown builders
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute a per-section token breakdown for the system prompt.
 *
 * @param systemPrompt  The fully-assembled system prompt string.
 * @param options       Structured options used to build it (from
 *                      `event.systemPromptOptions` in `before_agent_start`).
 *                      Pass `undefined` when not available.
 */
export function buildSystemPromptBreakdown(
	systemPrompt: string,
	options: SystemPromptOptions | undefined,
): SystemPromptBreakdown {
	const total = estimateTokens(systemPrompt);

	if (!options) {
		return {
			total,
			core: total,
			tools: 0,
			guidelines: 0,
			appendSystemPrompt: 0,
			contextFiles: [],
			skillsCatalog: 0,
		};
	}

	const tools = estimateTokens(toolsText(options));
	const guidelines = estimateTokens(guidelinesText(options));
	const appendSP = estimateTokens(options.appendSystemPrompt ?? "");
	const contextFiles: ContextFileBreakdown[] = (options.contextFiles ?? []).map((f) => ({
		path: f.path,
		tokens: estimateTokens(contextFileSectionText(f)),
	}));
	const contextFilesTotal = contextFiles.reduce((sum, f) => sum + f.tokens, 0);
	const skillsCatalog = estimateTokens(skillsCatalogText(options.skills ?? []));

	const components = tools + guidelines + appendSP + contextFilesTotal + skillsCatalog;
	const core = Math.max(0, total - components);

	return {
		total,
		core,
		tools,
		guidelines,
		appendSystemPrompt: appendSP,
		contextFiles,
		skillsCatalog,
	};
}

/** Minimal shape for a session branch entry understood by this module. */
export interface MessageEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		/** Text content — a string, or an array of content blocks. */
		content:
			| string
			| Array<{ type: string; text?: string }>
			| unknown;
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
			.filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && typeof (c as Record<string,unknown>)["text"] === "string")
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
			// Use actual token count from usage when available; fall back to estimate.
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
