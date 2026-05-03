/**
 * Semantic validation for ask_user_question parameters.
 *
 * The TypeBox schema in `schema.ts` handles structural shape; this module
 * catches domain rules that cannot be expressed in JSON Schema alone:
 *
 *  - duplicate question text across the invocation
 *  - missing/empty question or option labels
 *  - option labels that collide with the auto-appended sentinel rows
 *    ("Type something.", "Chat about this", "Next", "Other")
 *  - duplicate option labels within a question (case-insensitive)
 *  - `preview` on multi-select questions (unsupported by the side-by-side UI)
 *
 * The function is pure and side-effect-free so it is trivial to test.
 */

import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, MIN_QUESTIONS, RESERVED_LABEL_RE } from "./constants.js";
import type { TParams } from "./schema.js";

export type ValidateOk = { ok: true };
export type ValidateError = { ok: false; error: string; message: string };
export type ValidateResult = ValidateOk | ValidateError;

export function validate(p: TParams): ValidateResult {
	const qs = p.questions;
	if (!Array.isArray(qs) || qs.length < MIN_QUESTIONS || qs.length > MAX_QUESTIONS) {
		return {
			ok: false,
			error: "questions_out_of_range",
			message: `questions must have ${MIN_QUESTIONS}-${MAX_QUESTIONS} items`,
		};
	}

	// Reject duplicate question text across the invocation (matches reference
	// behaviour). Comparison is case-insensitive and whitespace-insensitive
	// (same policy as option labels below) so differing only in case or
	// surrounding whitespace still collides (#0001).
	const seenQuestions = new Set<string>();
	for (let qi = 0; qi < qs.length; qi++) {
		const q = qs[qi];
		if (q === undefined) continue;
		const text = typeof q.question === "string" ? q.question.trim() : "";
		if (text === "") continue;
		const key = text.toLowerCase();
		if (seenQuestions.has(key)) {
			return {
				ok: false,
				error: "duplicate_question",
				message: `question[${qi}] duplicates an earlier question text; question text must be unique within an invocation (case-insensitive)`,
			};
		}
		seenQuestions.add(key);
	}

	for (let qi = 0; qi < qs.length; qi++) {
		const q = qs[qi];
		if (q === undefined) {
			return {
				ok: false,
				error: "missing_question",
				message: `question[${qi}] is missing`,
			};
		}
		if (typeof q.question !== "string" || q.question.trim() === "") {
			return {
				ok: false,
				error: "missing_question",
				message: `question[${qi}].question is required`,
			};
		}
		if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
			return {
				ok: false,
				error: "options_out_of_range",
				message: `question[${qi}].options must have ${MIN_OPTIONS}-${MAX_OPTIONS} items`,
			};
		}

		const seen = new Set<string>();
		for (let oi = 0; oi < q.options.length; oi++) {
			const o = q.options[oi];
			if (o === undefined || typeof o.label !== "string" || o.label.trim() === "") {
				return {
					ok: false,
					error: "missing_label",
					message: `question[${qi}].options[${oi}].label is required`,
				};
			}
			const trimmed = o.label.trim();
			if (RESERVED_LABEL_RE.test(trimmed)) {
				return {
					ok: false,
					error: "reserved_label",
					message: `question[${qi}].options[${oi}].label "${o.label}" is reserved — pi auto-appends "Type something." / "Chat about this" / "Next" sentinels`,
				};
			}
			const key = trimmed.toLowerCase();
			if (seen.has(key)) {
				return {
					ok: false,
					error: "duplicate_label",
					message: `question[${qi}] has duplicate option label "${o.label}"`,
				};
			}
			seen.add(key);
			if (q.multiSelect === true && typeof o.preview === "string" && o.preview.length > 0) {
				return {
					ok: false,
					error: "preview_on_multiselect",
					message: `question[${qi}].options[${oi}].preview is not supported on multi-select questions`,
				};
			}
		}
	}

	return { ok: true };
}
