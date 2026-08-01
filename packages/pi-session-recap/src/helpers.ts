/**
 * Pure helpers extracted from session-recap index.ts so they can be covered
 * by unit tests without mocking pi-tui, pi-ai, or the terminal.
 *
 * See src/index.ts for upstream attribution.
 */

import { createHash } from "node:crypto";

export type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

export type Entry = {
	id?: string;
	type: string;
	/** compaction / branch_summary entries carry a distilled task summary. */
	summary?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
	};
};

/** Cap on transcript chars fed to the model AND hashed by the dedupe key. */
export const TRANSCRIPT_CHAR_CAP = 12000;

/** Task-framing context limits (tier 1 of the transcript). */
const COMPACTION_SUMMARY_CHARS = 600;
const EARLIER_USER_PROMPTS = 4;
const EARLIER_PROMPT_CHARS = 300;

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
 * Two-tier transcript:
 *
 *   Tier 1 — task framing (cheap): the most recent compaction/branch summary
 *   if present, plus the last few *user* prompts before the latest one,
 *   trimmed hard. This is what lets the model state the high-level task
 *   instead of parroting the last tool call. (Claude Code feeds the last 30
 *   raw messages to Haiku for this; we're on the active model, so we keep the
 *   framing to user prompts only — old tool results add cost, not
 *   orientation.)
 *
 *   Tier 2 — recent detail: everything since the last user message, with the
 *   same per-item trimming as before (assistant text, tool calls, results).
 */
export function buildTranscript(entries: Entry[]): string {
	const userIdxs: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e && e.type === "message" && e.message?.role === "user") userIdxs.push(i);
	}
	const lastUserIdx = userIdxs.length > 0 ? (userIdxs[userIdxs.length - 1] ?? -1) : -1;

	const lines: string[] = [];

	// Tier 1a: most recent compaction / branch summary — already-distilled task context.
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (
			e &&
			(e.type === "compaction" || e.type === "branch_summary") &&
			typeof e.summary === "string" &&
			e.summary.trim()
		) {
			lines.push(`Session summary so far: ${e.summary.trim().slice(0, COMPACTION_SUMMARY_CHARS)}`);
			break;
		}
	}

	// Tier 1b: earlier user prompts (task framing), oldest → newest.
	const earlier = userIdxs.slice(0, -1).slice(-EARLIER_USER_PROMPTS);
	const earlierLines: string[] = [];
	for (const i of earlier) {
		const t = extractText(entries[i]?.message?.content).trim();
		if (t) earlierLines.push(`- ${t.slice(0, EARLIER_PROMPT_CHARS)}`);
	}
	if (earlierLines.length > 0) {
		lines.push("Earlier user prompts (task framing):");
		lines.push(...earlierLines);
	}

	// Tier 2: full compact detail since the last user message (inclusive).
	const slice = lastUserIdx >= 0 ? entries.slice(lastUserIdx) : entries;
	const detail: string[] = [];
	for (const e of slice) {
		if (!e || e.type !== "message" || !e.message?.role) continue;
		const role = e.message.role;
		if (role === "user") {
			const t = extractText(e.message.content).trim();
			if (t) detail.push(`User: ${t.slice(0, 1200)}`);
		} else if (role === "assistant") {
			const t = extractText(e.message.content).trim();
			if (t) detail.push(`Assistant: ${t.slice(0, 1200)}`);
			const calls = extractToolCalls(e.message.content);
			if (calls.length) detail.push(...calls);
		} else if (role === "toolResult") {
			const t = extractText(e.message.content).trim();
			const name = e.message.toolName ?? "tool";
			if (t) detail.push(`Result(${name}): ${t.slice(0, 400)}`);
		}
	}
	if (detail.length > 0) {
		lines.push("Recent activity (since the user's last message):");
		lines.push(...detail);
	}

	return lines.join("\n");
}

/**
 * Fingerprint of the recap-relevant transcript. Hashes exactly the capped
 * prompt payload, so irrelevant session metadata or over-cap transcript
 * changes do not spend another recap call.
 */
export function recapStateKey(transcript: string): string {
	return createHash("sha256").update(transcript.slice(0, TRANSCRIPT_CHAR_CAP)).digest("hex");
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
		if (!e || e.type !== "message") continue;
		if (e.message?.role === "assistant") {
			const t = extractText(e.message.content);
			assistantWords += t.split(/\s+/).filter(Boolean).length;
			toolCalls += extractToolCalls(e.message.content).length;
		}
	}
	return toolCalls > 0 || assistantWords >= 30;
}

/**
 * Word-wrap `text` to `width` columns, then truncate to `maxLines` lines with
 * `" …"` appended to the last kept line when truncation happened. Used for
 * the recap widget body so a long draft doesn't sprawl above the editor.
 */
export function wrapText(text: string, width: number, maxLines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if (cur && cur.length + 1 + w.length > width) {
			lines.push(cur);
			cur = w;
		} else {
			cur = cur ? `${cur} ${w}` : w;
		}
	}
	if (cur) lines.push(cur);
	if (lines.length > maxLines) {
		const kept = lines.slice(0, maxLines);
		kept[maxLines - 1] = `${kept[maxLines - 1] ?? ""} …`;
		return kept;
	}
	return lines;
}

// ---------------------------------------------------------------------------
// /recap status line composition (tracker issue #0004)
// ---------------------------------------------------------------------------

/** Flags listed in the `Disabled flags:` row when active. */
export type DisabledFlag = "--recap-disable-focus";

/**
 * Fully-resolved inputs for `buildStatusLine`. Keeping this struct of plain
 * values (no model-registry lookups, no pi-tui, no fs reads) is what lets the
 * helper be unit-tested without mocks — the caller in `index.ts` does the
 * impure resolution once and hands the result in.
 */
export interface StatusLineOptions {
	/**
	 * Non-null when a recap-model override is configured, either via the
	 * `--recap-model` CLI flag or via `<agentDir>/pi-session-recap.json`.
	 * `resolved` mirrors whether `getModel()` returned a `Model` for the
	 * override's `spec` — `false` surfaces the otherwise-silent fallback
	 * `readUserRecapModel`/`generateAndShow` do today when the configured
	 * spec doesn't match the model registry.
	 */
	override: {
		source: "--recap-model" | "pi-session-recap.json";
		spec: string;
		resolved: boolean;
	} | null;
	/**
	 * Display string for the currently active model (e.g.
	 * `anthropic/claude-sonnet-4-6`). Used both as the sole Model line when
	 * there is no override, and as the fallback line when an override is
	 * configured but fails to resolve.
	 */
	activeModelSpec: string;
	/** `true` when `--recap-auto` is set — opt-in automatic recaps. */
	autoRecapEnabled: boolean;
	/** Whole seconds for the idle fallback after turn_end. */
	idleSeconds: number;
	/**
	 * Seconds of continuous terminal blur before an away recap is drafted.
	 * `null` when `--recap-disable-focus` is set — focus reporting is off
	 * entirely and the idle fallback is the only automatic trigger.
	 */
	awaySeconds: number | null;
	/** Active disabled-flags, in presentation order. */
	disabledFlags: ReadonlyArray<DisabledFlag>;
	/** Number of recap triggers fired this session (idle + away + manual). */
	triggerCount: number;
	/**
	 * Cumulative token usage for recap LLM calls this session.
	 * `null` when no successful recap call has completed yet.
	 */
	tokenUsage: { input: number; output: number } | null;
}

/**
 * Compose the multi-line body rendered by `/recap status`. Pure so the layout
 * is covered without standing up a pi runtime; see `/recap status` in
 * `src/index.ts` for the impure wiring that feeds it.
 */
export function buildStatusLine(opts: StatusLineOptions): string {
	const lines: string[] = ["recap status"];

	if (opts.override) {
		if (opts.override.resolved) {
			lines.push(`  Model:          ${opts.override.spec}  (from ${opts.override.source})`);
		} else {
			// Surface the silent fallback that `readUserRecapModel` / the
			// CLI-flag path does today when the configured spec isn't in the
			// model registry. The user has no other signal their spec is bad.
			lines.push(
				`  Model:          ${opts.override.spec}  (override failed to resolve, falling back to active)`,
			);
			lines.push(`                  ${opts.activeModelSpec}  (active model)`);
		}
	} else {
		lines.push(`  Model:          ${opts.activeModelSpec}  (active model)`);
	}

	lines.push(`  Auto-recap:     ${opts.autoRecapEnabled ? "enabled" : "disabled"}`);
	lines.push(`  Idle trigger:   ${opts.idleSeconds}s after turn_end`);
	if (opts.awaySeconds === null) {
		lines.push(`  Away trigger:   disabled`);
	} else {
		lines.push(`  Away trigger:   enabled (${opts.awaySeconds}s blur)`);
	}
	const flags = opts.disabledFlags.length > 0 ? opts.disabledFlags.join(", ") : "(none)";
	lines.push(`  Triggers:       ${opts.triggerCount} (this session)`);
	if (opts.tokenUsage !== null) {
		lines.push(`  Token usage:    ${opts.tokenUsage.input.toLocaleString()} in / ${opts.tokenUsage.output.toLocaleString()} out  (this session)`);
	}
	lines.push(`  Disabled flags: ${flags}`);

	return lines.join("\n");
}
