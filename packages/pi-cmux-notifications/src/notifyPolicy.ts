/**
 * Notification policy for the `agent_end` event.
 *
 * Background: the original implementation never fired a desktop
 * notification when an agent turn finished, on the theory that the red
 * circle in the sidebar was sufficient. In practice, when the user is
 * running multiple pi sessions in parallel and switches to a different
 * app entirely (Slack, browser, another terminal), the sidebar pill is
 * invisible — they get no signal at all that a long-running agent
 * finished. This module adds a focus-aware policy: notify only when the
 * user is plausibly not looking at the pi pane.
 *
 * The policy is configurable via `PI_CMUX_NOTIFY_ON_DONE`:
 *   - `smart` (default) — notify only if focus reporting says the pane
 *     is unfocused, OR if focus reporting is unavailable (no TTY, can't
 *     tell — err on the side of telling the user).
 *   - `always` — notify on every `agent_end`. Loud, but useful for users
 *     who park pi sessions in the background and want every completion
 *     to ping.
 *   - `never` — preserve the pre-fix behaviour. Silent on `agent_end`;
 *     only the sidebar pill changes.
 *
 * Kept pure so the index.ts wiring is a one-liner and the policy table
 * can be exhaustively unit-tested.
 */

export type NotifyOnDoneMode = "smart" | "always" | "never";

/**
 * Parse `PI_CMUX_NOTIFY_ON_DONE`. Unknown / empty values fall back to
 * `smart` so the default behaviour is the recommended one without
 * requiring users to set the env var.
 */
export function resolveNotifyOnDoneMode(
	env: NodeJS.ProcessEnv = process.env,
): NotifyOnDoneMode {
	const v = (env["PI_CMUX_NOTIFY_ON_DONE"] ?? "").trim().toLowerCase();
	if (v === "always" || v === "never" || v === "smart") return v;
	return "smart";
}

/**
 * Decide whether `agent_end` should fire a desktop notification.
 *
 * @param mode           — parsed `PI_CMUX_NOTIFY_ON_DONE` value.
 * @param focusEnabled   — true if DECSET ?1004 focus reporting is wired
 *                         up (requires both stdin & stdout to be TTYs).
 *                         When false, we treat focus state as unknown.
 * @param focusedAway    — current focus state from the focus listener.
 *                         Meaningful only when `focusEnabled` is true.
 */
export function shouldNotifyOnDone(
	mode: NotifyOnDoneMode,
	focusEnabled: boolean,
	focusedAway: boolean,
): boolean {
	if (mode === "never") return false;
	if (mode === "always") return true;
	// smart: stay silent only when we have positive evidence the user is
	// looking at this pane (focus reporting on AND not focused away).
	if (!focusEnabled) return true;
	return focusedAway;
}
