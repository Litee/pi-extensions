/**
 * Row model for a single question tab.
 *
 * Each visible row in the UI is a `Row`: either one of the author-supplied
 * options or an auto-appended sentinel ("Type something.", "Next",
 * "Chat about this"). Centralising this mapping here keeps `dialog.ts`
 * focused on glue and makes the row-selection rules easy to unit-test.
 */

import type { TQuestion } from "./schema.js";

export type RowKind = "option" | "text" | "next" | "chat";

export interface Row {
	kind: RowKind;
	label: string;
	description?: string;
	preview?: string;
	/** Index into the original question.options array. Only set when kind === "option". */
	optionIndex?: number;
}

/**
 * Build the row list shown for a question, including auto-appended sentinels.
 *
 * Rules:
 *  - author options always come first, preserving order
 *  - multi-select questions append a "Next" sentinel (Enter advances the tab)
 *  - single-select questions append "Type something." *only* when no option
 *    has a preview — the side-by-side preview layout leaves no room for a
 *    free-text fallback row
 *  - every question appends "Chat about this" as the final escape hatch
 */
export function buildRows(q: TQuestion): Row[] {
	const rows: Row[] = q.options.map((o, i) => {
		const row: Row = {
			kind: "option",
			label: o.label,
			optionIndex: i,
		};
		if (typeof o.description === "string") row.description = o.description;
		if (typeof o.preview === "string" && o.preview.length > 0) row.preview = o.preview;
		return row;
	});

	const hasPreview = rows.some((r) => r.preview !== undefined);
	if (q.multiSelect === true) {
		rows.push({ kind: "next", label: "Next" });
	} else if (!hasPreview) {
		rows.push({ kind: "text", label: "Type something." });
	}
	rows.push({ kind: "chat", label: "Chat about this" });
	return rows;
}
