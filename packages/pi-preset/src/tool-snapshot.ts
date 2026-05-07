/**
 * Remembers the active tool set before entering a preset so it can be
 * restored exactly when all presets are cleared, regardless of what was
 * active before the switch.
 */
export class ToolSnapshot {
	private saved: string[] | null = null;

	/** Snapshot the current tool names. Overwrites any previously saved snapshot. */
	save(tools: string[]): void {
		this.saved = [...tools];
	}

	/**
	 * Return the saved tools (clearing the snapshot) or `fallback` when nothing
	 * was saved.
	 */
	restore(fallback: string[]): string[] {
		const tools = this.saved ?? fallback;
		this.saved = null;
		return tools;
	}

	hasSaved(): boolean {
		return this.saved !== null;
	}
}
