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
 */
export function buildRecapPrompt(transcript: string): string {
	return (
		"You produce a single-line recap of what the coding agent just did, " +
		"so the user can re-enter flow after switching focus back to this session.\n\n" +
		"Rules:\n" +
		"- Output ONE line, no preamble, no markdown.\n" +
		"- Do not prefix with `recap:` — the UI already renders that label.\n" +
		"- Format: `goal: <overall goal>. <what just happened, past tense, concrete>. Next: <one-line next step>.`\n" +
		"- If the overall goal is unclear from the transcript, omit the `goal:` clause.\n" +
		"- If there is no meaningful next step, omit the `Next:` clause.\n" +
		"- If the transcript shows the turn was aborted or errored, say so explicitly " +
		'(e.g. "aborted during X", "errored at Y").\n' +
		"- Use file/function names where relevant. Be concrete, not vague.\n" +
		"- Skip: root-cause narrative, fix internals, secondary to-dos, em-dash tangents, motivational framing.\n" +
		"- Max ~220 characters.\n\n" +
		"<transcript>\n" +
		transcript.slice(0, TRANSCRIPT_MAX_CHARS) +
		"\n</transcript>"
	);
}
