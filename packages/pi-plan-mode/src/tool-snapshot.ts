/**
 * Remembers the active tool set before entering plan mode so it can be
 * restored exactly when plan mode exits, regardless of what was active
 * before the switch.
 */
export class ToolSnapshot {
	private saved: string[] | null = null;

	/** Snapshot the current tool names. Overwrites any previously saved snapshot. */
	save(tools: string[]): void {
		this.saved = [...tools];
	}

	/**
	 * Return the saved tools (clearing the snapshot) or `fallback` if nothing
	 * was saved.
	 */
	restore(fallback: string[]): string[] {
		const tools = this.saved ?? fallback;
		this.saved = null;
		return tools;
	}

	/** Returns a copy of the saved tool names, or null if nothing is saved. Does not clear the snapshot. */
	getSaved(): string[] | null {
		return this.saved === null ? null : [...this.saved];
	}

	hasSaved(): boolean {
		return this.saved !== null;
	}
}
