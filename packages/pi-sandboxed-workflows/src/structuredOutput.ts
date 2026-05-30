/**
 * Structured-output helpers for pi-sandboxed-workflows v2.
 *
 * Three pure utilities used by `src/agent.ts`:
 *
 * 1. `injectTagFooter` — append the fixed framework footer (one canonical
 *    phrasing per §11 Q6) that tells the model to wrap its answer in the
 *    structured-output tag. No-ops when the tag is already in the prompt.
 *
 * 2. `extractTaggedJson` — find the **last** `<tag>…</tag>` block in the
 *    combined agent stdout. Throws `TagNotFoundError` when none is present.
 *
 * 3. `validateJson` — ajv-validate against a JSON Schema. Throws
 *    `ValidationError` with the formatted error text (including instancePath)
 *    when validation fails.
 *
 * The constant `PI_SW_RESULT_TAG` is the canonical tag literal. Export it
 * here so every file has one import point.
 */
import { Ajv } from "ajv";

/** JSON Schema object — forwarded to AJV. */
export type JsonSchema = Record<string, unknown>;

/** Constant XML tag for pi-sandboxed-workflows structured output. */
export const PI_SW_RESULT_TAG = "pi_sw_result";

/** Tag for agent-reported blockers that short-circuit the retry loop. */
export const PI_SW_BLOCKER_TAG = "pi_sw_blocker";

// Module-level AJV instance. Compiled schemas are cached by reference.
const _ajv = new Ajv({ strict: false });

// ── Error types ────────────────────────────────────────────────────────────

/** Thrown when the agent stdout contains no matching tag block. */
export class TagNotFoundError extends Error {
	constructor(tag: string) {
		super(`Tag <${tag}> not found in agent stdout`);
		this.name = "TagNotFoundError";
	}
}

/** Thrown when extracted JSON fails AJV schema validation. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Append the fixed structured-output footer to a prompt.
 *
 * If the prompt already contains `<tag>` the prompt is returned unchanged
 * (idempotent). Otherwise, a standardised footer is appended that instructs
 * the model to emit its answer wrapped in `<tag>…</tag>` containing JSON
 * matching the supplied schema.
 *
 * @deprecated Prefer `buildStructuredOutputInstruction` + `--append-system-prompt`.
 * Kept for tests and any caller that injects into the user prompt directly.
 */
export function injectTagFooter(
	prompt: string,
	tag: string,
	schema: JsonSchema,
): string {
	if (prompt.includes(`<${tag}>`)) return prompt;

	return prompt + "\n\n" + buildStructuredOutputInstruction(tag, schema);
}

/**
 * Build the structured-output system-level instruction.
 *
 * This is the canonical phrasing injected via `--append-system-prompt` so
 * the sub-agent receives it at system priority rather than buried in the
 * user message. Workflow authors cannot override it.
 */
export function buildStructuredOutputInstruction(
	tag: string,
	schema: JsonSchema,
): string {
	const schemaJson = JSON.stringify(schema, null, 2);
	return (
		`<!-- pi-sandboxed-workflows: structured output -->\n` +
		`When you have completed the task, emit the final result wrapped in\n` +
		`<${tag}>...</${tag}> as a single JSON block matching this schema:\n` +
		"```json\n" +
		schemaJson +
		"\n```\n" +
		`The framework reads the LAST <${tag}> block in your output. Do not\n` +
		`include trailing prose after the closing tag.` +
		`\n\nIf you encounter a condition that makes it impossible to complete ` +
		`the task (required tool unavailable, missing context, permission denied), ` +
		`emit a blocker instead of the result tag:\n` +
		`<${PI_SW_BLOCKER_TAG}>brief reason you cannot proceed</${PI_SW_BLOCKER_TAG}>\n` +
		`A blocker is final — do not emit both tags.`
	);
}

/**
 * Scan `stdout` for the **last** `<tag>…</tag>` block and return its inner
 * string (trimmed). Simple last-occurrence regex — the tag literal
 * `pi_sw_result` is namespaced enough to avoid collisions.
 *
 * Throws `TagNotFoundError` when no matching block is found.
 */
export function extractTaggedJson(stdout: string, tag: string): string {
	// Build a global regex so we can iterate all matches and keep the last.
	const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
	let lastInner: string | undefined;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stdout)) !== null) {
		lastInner = m[1];
	}
	if (lastInner === undefined) {
		throw new TagNotFoundError(tag);
	}
	return lastInner.trim();
}

/**
 * Scan `stdout` for a `<pi_sw_blocker>…</pi_sw_blocker>` tag.
 * Returns the trimmed inner text when present, otherwise `undefined`.
 * Blockers are checked before schema extraction so the framework can
 * propagate them immediately without retrying.
 */
export function extractBlocker(stdout: string): string | undefined {
	const re = new RegExp(
		`<${PI_SW_BLOCKER_TAG}>([\\s\\S]*?)<\\/${PI_SW_BLOCKER_TAG}>`,
	);
	const m = re.exec(stdout);
	return m?.[1]?.trim();
}

/**
 * AJV-validate `parsed` against `schema`.
 * Throws `ValidationError` carrying `ajv.errorsText()` (≤ 512 chars, with
 * instancePath) when validation fails.
 */
export function validateJson(parsed: unknown, schema: JsonSchema): void {
	const validate = _ajv.compile(schema);
	if (!validate(parsed)) {
		const msg = _ajv
			.errorsText(validate.errors, { separator: "; " })
			.slice(0, 512);
		throw new ValidationError(`Schema validation failed: ${msg}`);
	}
}
