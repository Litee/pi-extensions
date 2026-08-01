/**
 * Prompt template for the recap model call. Factored out of `index.ts`
 * so it can be pinned via snapshot tests without mocking pi-ai.
 *
 * See src/index.ts for upstream attribution.
 */

/**
 * System prompt sent with the recap completion. Some providers (notably
 * openai-codex-responses) require a non-empty top-level instruction string
 * even for simple one-shot completions.
 */
export const RECAP_SYSTEM_PROMPT =
	"You write terse, concrete session recaps for a coding agent UI.";

/** Max characters of session transcript embedded in the user prompt. */
const TRANSCRIPT_MAX_CHARS = 12000;

/**
 * Compose the user-message prompt for the recap model call. The transcript
 * is truncated to {@link TRANSCRIPT_MAX_CHARS} characters to stay inside
 * typical context budgets.
 *
 * The framing mirrors Claude Code's away-summary: orient the user in the
 * high-level task, don't produce a status report — the last assistant
 * message is already visible in scrollback.
 */
export function buildRecapPrompt(transcript: string): string {
	return (
		"The user stepped away from this coding-agent session and is coming back. " +
		"Write a short recap so they can re-enter flow.\n\n" +
		"Rules:\n" +
		"- Write 1-3 short sentences of plain text. No preamble, no markdown, no bullets.\n" +
		"- Start by stating the high-level task — what the user is building, fixing, or " +
		"debugging — not implementation minutiae.\n" +
		"- End with the concrete next step, if there is one.\n" +
		"- Skip status reports and commit recaps; orient the reader instead.\n" +
		"- If the last turn was aborted or errored, say so explicitly " +
		'(e.g. "aborted during X", "errored at Y").\n' +
		"- Use file/function names where they matter. Max ~400 characters.\n\n" +
		"<transcript>\n" +
		transcript.slice(0, TRANSCRIPT_MAX_CHARS) +
		"\n</transcript>"
	);
}
