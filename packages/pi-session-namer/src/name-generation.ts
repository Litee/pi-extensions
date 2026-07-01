/**
 * Auto-generate a session name from recent conversation turns via an LLM call.
 *
 * Pattern follows pi-session-recap: import completeSimple/getModel from
 * @earendil-works/pi-ai, resolve auth from ctx.modelRegistry, fire the
 * completion, and parse the response.
 */

import type { completeSimple as completeSimpleFn } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Infer the Model type from the completeSimple function signature. */
type Model = Parameters<typeof completeSimpleFn>[0];

// ---------------------------------------------------------------------------
// Transcript helpers (lightweight copy of pi-session-recap helpers)
// ---------------------------------------------------------------------------

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

export type Entry = {
	id?: string;
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
	};
};

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const b = part as ContentBlock;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const b = part as ContentBlock;
		if (b.type !== "toolCall" || typeof b.name !== "string") continue;
		const args = b.arguments ?? {};
		const summary = JSON.stringify(args).slice(0, 280);
		out.push(`- ${b.name}(${summary})`);
	}
	return out;
}

/**
 * Compact transcript: first 3 and last 3 messages, each truncated to 5K chars.
 * This gives the LLM a sense of the session's start and current context without
 * flooding it with the entire conversation.
 */
const MESSAGE_LIMIT = 5000;

export function buildTranscript(entries: Entry[]): string {
	// Select first 3 and last 3 entries (deduplicated)
	const selected: Entry[] = [];
	const seen = new Set<number>();

	for (let i = 0; i < Math.min(3, entries.length); i++) {
		if (!seen.has(i)) { selected.push(entries[i]!); seen.add(i); }
	}
	for (let i = Math.max(0, entries.length - 3); i < entries.length; i++) {
		if (!seen.has(i)) { selected.push(entries[i]!); seen.add(i); }
	}

	const lines: string[] = [];
	for (const e of selected) {
		if (e.type !== "message" || !e.message?.role) continue;
		const role = e.message.role;
		if (role === "user") {
			const t = extractText(e.message.content).trim();
			if (t) lines.push(`User: ${t.slice(0, MESSAGE_LIMIT)}`);
		} else if (role === "assistant") {
			const t = extractText(e.message.content).trim();
			if (t) lines.push(`Assistant: ${t.slice(0, MESSAGE_LIMIT)}`);
			const calls = extractToolCalls(e.message.content);
			if (calls.length) lines.push(...calls);
		} else if (role === "toolResult") {
			const t = extractText(e.message.content).trim();
			const name = e.message.toolName ?? "tool";
			if (t) lines.push(`Result(${name}): ${t.slice(0, MESSAGE_LIMIT)}`);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
	"You are a session naming assistant. Given a conversation transcript, " +
	"produce a short session name that captures the topic or goal.\n\n" +
	"Rules:\n" +
	"- Output ONLY the name — no quotes, no punctuation, no explanation.\n" +
	"- All lowercase English words, separated by single spaces.\n" +
	"- Maximum 5 words; fewer is better (aim for 2-3).\n" +
	"- Be specific and concrete, not generic (e.g. 'fix auth bug' not 'coding task').\n" +
	"- No articles (a, an, the) unless essential.\n" +
	"- No trailing period or newline.\n";

const TRANSCRIPT_MAX_CHARS = 12000;

/**
 * Generate a session name from recent conversation turns via an LLM call.
 * Returns the generated name string, or `undefined` on failure.
 */
export async function generateSessionName(
	transcript: string,
	deps: {
		completeSimple: typeof completeSimpleFn;
		ctx: ExtensionContext;
	},
	signal: AbortSignal,
): Promise<string | undefined> {
	const { completeSimple, ctx } = deps;

	const model: Model | undefined = ctx.model;
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return undefined;

	const response = await completeSimple(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildNamePrompt(transcript) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			...(auth.headers ? { headers: auth.headers } : {}),
			signal,
			...(model.reasoning ? { reasoning: "minimal" as const } : {}),
			cacheRetention: "none" as const,
		},
	);

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	return parseName(text);
}

function buildNamePrompt(transcript: string): string {
	return (
		"Generate a short session name from the conversation below.\n\n" +
		"<transcript>\n" +
		transcript.slice(0, TRANSCRIPT_MAX_CHARS) +
		"\n</transcript>"
	);
}

/**
 * Parse and clean the LLM response into a valid session name.
 * - Takes the first line
 * - Lowercases everything
 * - Strips quotes, punctuation
 * - Splits into words, keeps only alphabetic words
 * - Truncates to max 5 words
 */
export function parseName(raw: string): string {
	if (!raw) return "";
	// Take first line
	let line = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (!line) return "";

	// Lowercase
	line = line.toLowerCase();

	// Strip surrounding quotes
	line = line.replace(/^["']|["']$/g, "").trim();

	// Keep only letters, digits, and spaces
	line = line.replace(/[^a-z0-9\s]/g, " ");

	// Collapse whitespace
	line = line.replace(/\s+/g, " ").trim();

	// Split into words, filter empty, take first 5
	const words = line.split(/\s+/).filter(Boolean).slice(0, 5);
	return words.join(" ");
}
