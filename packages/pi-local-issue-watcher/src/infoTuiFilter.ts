/**
 * Pure substring-filter helper for the `/local-issue-watcher browse`
 * TUI. The stock `SelectList.setFilter` matches
 * `value.toLowerCase().startsWith(filter)` which is wrong for us —
 * the value is an absolute file path, not the user-visible text.
 * We want a case-insensitive substring match over the label.
 *
 * Keeping this as a pure function lets `infoTui.ts` collapse its
 * previous inline `any`-cast patch to a single scoped site that only
 * writes `filteredItems` / `selectedIndex` back onto the component.
 */
export function filterItemsBySubstring<T>(
	items: readonly T[],
	needle: string,
	getText: (t: T) => string,
): T[] {
	const n = needle.toLowerCase();
	if (n === "") return items.slice();
	return items.filter((it) => getText(it).toLowerCase().includes(n));
}
