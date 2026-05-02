/**
 * Shared limits and reserved labels for the ask_user_question tool.
 *
 * Kept in a standalone module so the same values can be referenced from the
 * schema, the validator, and the prompt text without risk of drift.
 */

/** Minimum number of questions allowed per tool invocation. */
export const MIN_QUESTIONS = 1;
/** Maximum number of questions allowed per tool invocation. */
export const MAX_QUESTIONS = 5;
/** Minimum number of options allowed per question. */
export const MIN_OPTIONS = 2;
/** Maximum number of options allowed per question. */
export const MAX_OPTIONS = 6;

/**
 * Labels that collide with auto-appended sentinel rows and are therefore
 * rejected at validation time (case-insensitive match after trimming).
 *
 * Exposed as a RegExp (rather than a Set) so consumers can test arbitrary
 * strings without normalising casing themselves.
 */
export const RESERVED_LABEL_RE = /^(other|type something\.?|chat about this|next)$/i;
