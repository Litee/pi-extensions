/** Thinking level values supported by pi. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * A single action shown in the post-turn completion prompt.
 * At most one of `sendMessage` / `promptUser` should be set; if both are set,
 * `sendMessage` takes precedence.
 */
export interface OnCompleteAction {
	/** Label shown in the selection UI. */
	label: string;
	/**
	 * Preset to switch to after this action is selected. The switch happens
	 * before any message is sent. If absent, advances to the next preset in
	 * the cycle order (same as Ctrl+Shift+U), which for a single-preset setup
	 * means clearing back to defaults.
	 */
	switchTo?: string;
	/** If set, auto-send this message as an agent turn after switching. */
	sendMessage?: string;
	/** If set, open a text editor so the user can type a follow-up message. */
	promptUser?: boolean;
}

/** A named preset configuration. All fields are optional. */
export interface Preset {
	/** Provider name, e.g. `"anthropic"`, `"openai-codex"`. Requires `model`. */
	provider?: string;
	/** Model ID, e.g. `"claude-sonnet-4-5"`. Requires `provider`. */
	model?: string;
	/** Thinking level to activate while this preset is active. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Replaces the active tool set. Unknown tool names produce a warning;
	 * an empty array is silently ignored.
	 */
	tools?: string[];
	/**
	 * Text injected as a hidden context message before each agent turn.
	 * Stripped from context history when the preset is cleared or switched.
	 */
	instructions?: string;
	/**
	 * Regex patterns (plain strings, compiled with no flags) for bash commands
	 * that are **allowed**. When set, a command must match at least one pattern;
	 * commands that match neither list are blocked.
	 * Evaluated after `bashBlocklist`.
	 */
	bashAllowlist?: string[];
	/**
	 * Regex patterns (plain strings, compiled case-insensitively) for bash
	 * commands that are **blocked**. Evaluated before `bashAllowlist`.
	 */
	bashBlocklist?: string[];
	/**
	 * Actions shown in a selection prompt after the agent finishes a turn.
	 * When absent or empty, no prompt is shown.
	 */
	onComplete?: OnCompleteAction[];
}

export interface PresetsConfig {
	[name: string]: Preset;
}
