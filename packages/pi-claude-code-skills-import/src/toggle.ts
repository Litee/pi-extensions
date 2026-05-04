/**
 * Pure reducer for the `/cc-skills-info` toggle UI.
 *
 * Mutates `disabled` in place so the TUI callback can persist the same
 * reference. Returns `{ changed }` so the caller can decide whether a reload
 * is needed.
 */
export function applyToggle(
	id: string,
	newValue: "enabled" | "disabled",
	disabled: Set<string>,
): { changed: boolean } {
	if (newValue === "disabled") {
		if (disabled.has(id)) return { changed: false };
		disabled.add(id);
		return { changed: true };
	}
	if (!disabled.has(id)) return { changed: false };
	disabled.delete(id);
	return { changed: true };
}
