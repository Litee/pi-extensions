/**
 * Pure helpers for rendering the compaction status line.
 *
 * The status line is shown in the pi footer/status bar. To make context
 * pressure visible at a glance, the usage tail (`… · 42.0% (…)` etc.) is
 * tinted via the theme:
 *   - `muted`   when usage < 80% of the effective context window
 *   - `warning` when usage ≥ 80%
 *
 * The prefix (extension name, profile, retention) is left untinted so the
 * label stays readable across themes; only the percentage tail changes
 * colour.
 */

/** Theme accent applied to the usage tail of the status line. */
export type StatusAccent = "muted" | "warning";

/**
 * Threshold (inclusive) at which the status flips from `muted` to
 * `warning`. Expressed as a percentage of the effective context window
 * (i.e. `min(policy.trigger.maxTokens, ctx.contextWindow)`).
 */
export const WARNING_THRESHOLD_PERCENT = 80;

/**
 * Pick the accent for a given usage percentage. `pct` is expected to be
 * `(tokens / limit) * 100` — same value used in the rendered tail.
 *
 * Boundary case: exactly `WARNING_THRESHOLD_PERCENT` returns `"warning"`,
 * matching "≥ 80%" wording. Negative or NaN inputs fall back to `"muted"`
 * so a malformed usage never produces a yellow status by accident.
 */
export function pickUsageAccent(pct: number): StatusAccent {
	if (!Number.isFinite(pct)) return "muted";
	return pct >= WARNING_THRESHOLD_PERCENT ? "warning" : "muted";
}
