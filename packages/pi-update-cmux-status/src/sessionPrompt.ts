/**
 * Build the summariser prompt for `/cmux-rename` from the current session
 * branch (entries from root → leaf, i.e. what the LLM has actually seen
 * this conversation). Not the one-off first-prompt \u2014 the *current* state
 * of the conversation, so re-running /cmux-rename later generates names
 * that reflect what the session has become.
 *
 * Kept in its own file so the logic is trivially unit-testable and the
 * extension's index.ts stays focused on event wiring.
 */

/** Narrow shape matching pi's SessionEntry for message-kind entries. */
interface MinimalMessageEntry {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

/**
 * Cap on the size of the prompt handed to the summariser. Matches
 * `names.MAX_PROMPT_CHARS` so the downstream trim is a no-op when our
 * caller has already sized things correctly; we trim to the *tail* here
 * so the newest user messages always survive.
 */
export const MAX_PROMPT_CHARS = 2000;

/** Cap on how many recent user messages we include. */
export const MAX_USER_MESSAGES = 20;

/**
 * Extract plain-text content from a pi message-content value. Mirrors
 * pi-session-recap's helper — we duplicate the tiny function here rather
 * than cross-depend on the recap package.
 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/**
 * Collect up to {@link MAX_USER_MESSAGES} most-recent user-message texts
 * from the session branch, in chronological order. Slash commands and
 * empty messages are skipped.
 */
export function collectUserPrompts(entries: MinimalMessageEntry[]): string[] {
	const prompts: string[] = [];
	for (const e of entries) {
		if (!e || e.type !== "message" || e.message?.role !== "user") continue;
		const text = extractText(e.message.content).trim();
		if (!text) continue;
		if (text.startsWith("/")) continue;
		prompts.push(text);
	}
	if (prompts.length > MAX_USER_MESSAGES) {
		return prompts.slice(prompts.length - MAX_USER_MESSAGES);
	}
	return prompts;
}

/**
 * Build a summariser prompt from the session branch. Returns `null` when
 * the branch contains no eligible user messages \u2014 callers should warn the
 * user to send something first.
 *
 * The resulting string is capped at {@link MAX_PROMPT_CHARS}; older
 * prompts are dropped first, then (if still over) the remaining head is
 * truncated. This keeps the latest user intent intact.
 */
export function buildSessionRenamePrompt(
	entries: MinimalMessageEntry[],
): string | null {
	const prompts = collectUserPrompts(entries);
	if (prompts.length === 0) return null;
	// Join newest messages first so truncation drops older context.
	let joined = prompts.join("\n\n");
	if (joined.length <= MAX_PROMPT_CHARS) return joined;

	// Drop oldest prompts until we fit (but keep at least the last one).
	let start = 0;
	while (start < prompts.length - 1 && joined.length > MAX_PROMPT_CHARS) {
		start += 1;
		joined = prompts.slice(start).join("\n\n");
	}
	if (joined.length > MAX_PROMPT_CHARS) {
		joined = joined.slice(joined.length - MAX_PROMPT_CHARS);
	}
	return joined;
}

/** Lightweight accessor for the session branch, with safe fallbacks. */
export function getBranchSafely(
	sessionManager: unknown,
): MinimalMessageEntry[] {
	const sm = sessionManager as
		| { getBranch?: () => unknown[]; getEntries?: () => unknown[] }
		| undefined;
	if (!sm) return [];
	try {
		if (typeof sm.getBranch === "function") {
			return (sm.getBranch() as MinimalMessageEntry[]) ?? [];
		}
		if (typeof sm.getEntries === "function") {
			return (sm.getEntries() as MinimalMessageEntry[]) ?? [];
		}
	} catch {
		return [];
	}
	return [];
}
