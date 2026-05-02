/**
 * Result types for the ask_user_question tool and the pure formatter that
 * turns a `Result` into the `{ content, details }` payload the LLM sees.
 *
 * Keeping this split from the tool registration makes it straightforward to
 * unit-test the wording of every result variant (error / cancelled / single /
 * multi / text / chat) without going anywhere near the TUI.
 */

import type { TQuestion } from "./schema.js";

/**
 * A single answer for a question tab. `null` means the user advanced through
 * the tab without supplying an answer (only reachable for intermediate tabs).
 */
export type Answer =
	| { kind: "single"; index: number; label: string; note?: string }
	| { kind: "multi"; indices: number[]; labels: string[]; notes: Record<number, string> }
	| { kind: "text"; text: string }
	| { kind: "chat"; text: string };

export interface Result {
	answers: (Answer | null)[];
	cancelled: boolean;
	chat?: string;
	error?: string;
}

/** Construct a fresh empty result, typically used for validation / no-UI failure paths. */
export function emptyResult(cancelled: boolean, error?: string): Result {
	const r: Result = { answers: [], cancelled };
	if (error !== undefined) r.error = error;
	return r;
}

export interface ToolResultPayload {
	content: { type: "text"; text: string }[];
	details: Result;
}

/**
 * Format a `Result` as the tool-call reply the LLM reads.
 *
 * The structure matches pi's generic tool-result shape:
 *  - `content[0].text` is a human-readable summary the model sees inline
 *  - `details` is the raw Result so downstream renderers / loggers can
 *    introspect individual answers
 */
export function formatToolResult(result: Result, questions: TQuestion[]): ToolResultPayload {
	if (result.error !== undefined && result.error !== "") {
		return { content: [{ type: "text", text: result.error }], details: result };
	}
	if (result.cancelled) {
		const chat = result.chat !== undefined && result.chat !== "" ? ` Chat: ${result.chat}` : "";
		return {
			content: [{ type: "text", text: `User cancelled the questionnaire.${chat}` }],
			details: result,
		};
	}

	const lines: string[] = ["User has answered your questions:"];
	for (let qi = 0; qi < questions.length; qi++) {
		const q = questions[qi];
		const a = result.answers[qi] ?? null;
		const header = `Q${qi + 1} (${q?.question ?? ""}):`;
		if (a === null) {
			lines.push(`${header} (no answer)`);
			continue;
		}
		if (a.kind === "single") {
			const note = a.note !== undefined && a.note !== "" ? ` — note: ${a.note}` : "";
			lines.push(`${header} selected ${a.index + 1}. ${a.label}${note}`);
		} else if (a.kind === "multi") {
			const parts = a.indices.map((idx, k) => {
				const noteText = a.notes[idx];
				const note = noteText !== undefined && noteText !== "" ? ` — note: ${noteText}` : "";
				return `${idx + 1}. ${a.labels[k] ?? "?"}${note}`;
			});
			lines.push(`${header} selected [${parts.join(", ")}]`);
		} else if (a.kind === "text") {
			lines.push(`${header} user typed: ${a.text}`);
		} else {
			// kind === "chat"
			lines.push(`${header} user chose 'Chat about this': ${a.text}`);
		}
	}
	return { content: [{ type: "text", text: lines.join("\n") }], details: result };
}
