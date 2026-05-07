import type { Preset } from "./types.js";

/**
 * Compiled bash command filter for a single preset.
 *
 * Allowlist patterns are compiled with no flags (case-sensitive).
 * Blocklist patterns are compiled case-insensitively, matching pi-plan-mode
 * behaviour where destructive command names like `RM` should also be caught.
 *
 * Filtering logic:
 * 1. If the command matches any blocklist pattern → blocked.
 * 2. If an allowlist is configured and the command matches none of its
 *    patterns → blocked.
 * 3. Otherwise → allowed.
 *
 * When neither list is configured `hasRules` is false and the filter is a
 * no-op; callers should skip the check entirely in that case.
 */
export class BashFilter {
	private readonly allowlist: RegExp[];
	private readonly blocklist: RegExp[];

	constructor(preset: Preset) {
		this.allowlist = (preset.bashAllowlist ?? []).map((p) => new RegExp(p));
		this.blocklist = (preset.bashBlocklist ?? []).map((p) => new RegExp(p, "i"));
	}

	/** True when at least one allow or block pattern is configured. */
	get hasRules(): boolean {
		return this.allowlist.length > 0 || this.blocklist.length > 0;
	}

	/** Returns true when the command is safe to run under this preset's rules. */
	isSafe(command: string): boolean {
		if (this.blocklist.some((p) => p.test(command))) return false;
		if (this.allowlist.length > 0 && !this.allowlist.some((p) => p.test(command))) return false;
		return true;
	}
}
