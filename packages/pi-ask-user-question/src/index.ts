/**
 * Pi extension entry: register the `ask_user_question` tool.
 *
 * A feature-equivalent port of the single-file `ask-user-question` extension
 * (originally modelled on @juicesharp/rpiv-ask-user-question), reorganised as
 * a monorepo package so every piece of behaviour is covered by unit tests.
 *
 * The tool lets the LLM ask the user 1-5 structured clarifying questions
 * (2-6 options each) through a tabbed TUI dialog. Supports single/multi
 * select, per-option markdown preview, per-option free-text notes, a
 * "Type something." free-text fallback, and a "Chat about this" soft
 * escape hatch.
 *
 * Security notes
 * --------------
 *  - No network calls. No `fetch`, `http`, `https`, `net`, `dns`.
 *  - No filesystem writes. No `fs` import anywhere in the package.
 *  - No process spawns. No `child_process`, no `pi.exec`.
 *  - No dynamic imports, no `eval`, no `Function(...)`.
 *  - The only API touched at load time is `pi.registerTool({...})`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./constants.js";
import { runDialog } from "./dialog.js";
import { emptyResult, formatToolResult, type Result } from "./format.js";
import { renderCall, renderResult } from "./render.js";
import { ParamsSchema, type TParams } from "./schema.js";
import { validate } from "./validate.js";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can always type a custom answer ("Type something." row is auto-appended to single-select questions without previews) or pick "Chat about this" to abandon the questionnaire and continue in free-form conversation. Do NOT author "Other" / "Type something." / "Chat about this" / "Next" labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers. The "Type something." row is suppressed on multi-select questions, replaced by a "Next" sentinel that advances to the next tab.
- Preview feature: set options[].preview to a markdown/ASCII string for visual comparison (mockups, code snippets, diagrams, configs). Single-select only. Any non-empty preview on a single-select question suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the free-form escape hatch.
- If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`;

const PROMPT_GUIDELINES = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — up to ${MAX_QUESTIONS} questions per invocation, ${MIN_OPTIONS}-${MAX_OPTIONS} options each.`,
	`Every ask_user_question option needs a concise label (1-5 words) and a short description. The user can type a custom answer ("Type something.") or pick "Chat about this" to abandon the questionnaire.`,
	`Set ask_user_question multiSelect: true when multiple answers are valid (suppresses "Type something."). Provide options[].preview for richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. Recommended option goes first with "(Recommended)" in the label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

/**
 * Factory used by the `execute()` wrapper to run the dialog. Exposed so tests
 * can inject a stub instead of the real `runDialog` that requires pi-tui.
 */
export type RunDialogFn = (ctx: unknown, questions: TParams["questions"]) => Promise<Result>;

/** Options bag the default export accepts mostly for dependency injection in tests. */
export interface RegisterOptions {
	runDialog?: RunDialogFn;
}

export default function askUserQuestion(pi: ExtensionAPI, options: RegisterOptions = {}): void {
	const run = options.runDialog ?? (runDialog);

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: DESCRIPTION,
		promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return formatToolResult(emptyResult(true, ERROR_NO_UI), []);
			}
			const typed = params;
			const v = validate(typed);
			if (!v.ok) {
				return formatToolResult(emptyResult(true, v.message), typed.questions ?? []);
			}
			pi.events.emit("user_attention_requested", { title: "Needs your input" });
			try {
				const result = await run(ctx, typed.questions);
				return formatToolResult(result, typed.questions);
			} finally {
				pi.events.emit("user_attention_resolved", undefined);
			}
		},

		renderCall(args, theme) {
			return renderCall(args, theme);
		},
		renderResult(result, _opts, theme) {
			return renderResult(result as { content: { type: "text"; text: string }[]; details: Result | undefined }, theme);
		},
	});
}

export {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	MIN_QUESTIONS,
	RESERVED_LABEL_RE,
} from "./constants.js";
export { DialogController, type DialogState, type InputMode } from "./controller.js";
export { emptyResult, formatToolResult, type Answer, type Result, type ToolResultPayload } from "./format.js";
export { renderCall, renderResult, type RenderTheme } from "./render.js";
export { buildRows, type Row, type RowKind } from "./rows.js";
export { ParamsSchema, QuestionSchema, OptionSchema, type TParams, type TQuestion, type TOption } from "./schema.js";
export { validate, type ValidateError, type ValidateOk, type ValidateResult } from "./validate.js";
