/**
 * TypeBox schemas for the ask_user_question tool parameters.
 *
 * The schema mirrors what the LLM sees in the tool's JSON schema, so this
 * module is intentionally a thin declarative description; behavioural rules
 * (duplicates, reserved labels, etc.) live in `validate.ts`.
 */

import { type Static, Type } from "typebox";

import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, MIN_QUESTIONS } from "./constants.js";

export const OptionSchema = Type.Object({
	label: Type.String({ description: "Short option label (1-5 words ideally)." }),
	description: Type.Optional(Type.String({ description: "Explanation or trade-off for this option." })),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown/ASCII preview. Single-select questions only. Triggers side-by-side layout. Use for mockups, code snippets, diagrams or configs users need to visually compare.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question text shown to the user." }),
	description: Type.Optional(Type.String({ description: "Additional context shown below the question." })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections. Default: false." })),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: `Between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.`,
	}),
});

export const ParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: MIN_QUESTIONS,
		maxItems: MAX_QUESTIONS,
		description: `Up to ${MAX_QUESTIONS} questions per invocation.`,
	}),
});

export type TParams = Static<typeof ParamsSchema>;
export type TQuestion = Static<typeof QuestionSchema>;
export type TOption = Static<typeof OptionSchema>;
