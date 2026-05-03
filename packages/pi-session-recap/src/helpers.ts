/**
 * Pure helpers extracted from session-recap index.ts so they can be covered
 * by unit tests without mocking pi-tui, pi-ai, or the terminal.
 *
 * See src/index.ts for upstream attribution.
 */

export type ContentBlock = {
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

/**
 * Split a `provider/id` model spec into its components. Returns `undefined`
 * when the string has no slash, has an empty provider (`/foo`), or is empty.
 */
export function splitModel(spec: string): { provider: string; id: string } | undefined {
	const idx = spec.indexOf("/");
	if (idx <= 0) return undefined;
	return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

/**
 * Flatten a pi message `content` value into plain text.
 *
 *  - string values are returned verbatim
 *  - arrays are walked; only `{ type: "text", text: string }` parts contribute
 *  - anything else returns `""`.
 */
export function extractText(content: unknown): string {
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

/**
 * Extract a compact one-line summary for every `{ type: "toolCall" }` block
 * in a pi message `content` value. Arguments JSON is truncated to 280 chars.
 */
export function extractToolCalls(content: unknown): string[] {
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
 * Compact transcript of the assistant's activity since the last user message.
 *
 * When `fromLastUser` is false (used for `/resume`), the whole branch is
 * formatted. User/assistant text is truncated to 1200 chars per message,
 * tool results to 400 chars.
 */
export function buildRecentTranscript(entries: Entry[], fromLastUser = true): string {
	let slice = entries;
	if (fromLastUser) {
		let lastUserIdx = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e && e.type === "message" && e.message?.role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx >= 0) slice = entries.slice(lastUserIdx);
	}

	const lines: string[] = [];
	for (const e of slice) {
		if (e.type !== "message" || !e.message?.role) continue;
		const role = e.message.role;
		if (role === "user") {
			const t = extractText(e.message.content).trim();
			if (t) lines.push(`User: ${t.slice(0, 1200)}`);
		} else if (role === "assistant") {
			const t = extractText(e.message.content).trim();
			if (t) lines.push(`Assistant: ${t.slice(0, 1200)}`);
			const calls = extractToolCalls(e.message.content);
			if (calls.length) lines.push(...calls);
		} else if (role === "toolResult") {
			const t = extractText(e.message.content).trim();
			const name = e.message.toolName ?? "tool";
			if (t) lines.push(`Result(${name}): ${t.slice(0, 400)}`);
		}
	}
	return lines.join("\n");
}

/**
 * True when there has been real agent activity since the last user message:
 * at least one tool call, or ~30+ words of assistant text. Used as the gate
 * before we spend a model call on drafting a recap.
 */
export function hasMeaningfulActivity(entries: Entry[]): boolean {
	let lastUserIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e && e.type === "message" && e.message?.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	const tail = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries;
	let assistantWords = 0;
	let toolCalls = 0;
	for (const e of tail) {
		if (e.type !== "message") continue;
		if (e.message?.role === "assistant") {
			const t = extractText(e.message.content);
			assistantWords += t.split(/\s+/).filter(Boolean).length;
			toolCalls += extractToolCalls(e.message.content).length;
		}
	}
	return toolCalls > 0 || assistantWords >= 30;
}

/**
 * Keep only the first line of a model response, trimmed. Used as a belt-and-
 * braces guard against multi-line recap outputs.
 */
export function firstLine(text: string): string | undefined {
	if (!text) return undefined;
	return text.split(/\r?\n/, 1)[0]?.trim();
}
