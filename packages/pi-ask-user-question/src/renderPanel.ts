/**
 * Pure render helpers for the ask_user_question dialog.
 *
 * Every function here returns an array of styled strings (one per visual
 * row). Theme colouring, `truncateToWidth`, `visibleWidth`, and
 * `wrapTextWithAnsi` are passed as parameters so tests can inject
 * deterministic fakes without booting pi-tui.
 *
 * The live shell in `dialog.ts` handles the non-pure pieces the panel
 * cannot: the `Editor` component for free-text modes, the `Markdown`
 * preview cache + side-by-side layout, and the separator/overall frame.
 *
 * No imports from `@earendil-works/pi-tui` are allowed here.
 */

import type { DialogState } from "./controller.js";
import type { Row } from "./rows.js";
import type { TQuestion } from "./schema.js";

export type { DialogState } from "./controller.js";

/** Minimal theme surface the panel helpers need. */
export interface PanelTheme {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/** Layout primitives normally sourced from pi-tui; injected for testability. */
export interface LayoutProbe {
	truncateToWidth: (s: string, width: number) => string;
	visibleWidth: (s: string) => number;
	wrapTextWithAnsi: (s: string, width: number) => string[];
}

/** Pad `s` on the right to `width` columns (uses `visibleWidth`). */
export function padRight(s: string, width: number, layout: LayoutProbe): string {
	const w = layout.visibleWidth(s);
	if (w >= width) return layout.truncateToWidth(s, width);
	return s + " ".repeat(width - w);
}

/**
 * Wrap `text` to at most `width` visible columns using the layout probe.
 * Returns an array of lines each <= `width`; floors `width` at 1.
 */
export function wrapToWidth(text: string, width: number, layout: LayoutProbe): string[] {
	return layout.wrapTextWithAnsi(text, Math.max(1, width));
}

/**
 * Hanging-indent wrap: wrap `text` to `width - visibleWidth(prefix)` columns,
 * prepend `prefix` to the first line, and indent continuation lines by the
 * same number of spaces.
 *
 * Falls back to wrapping the whole `prefix + text` when the prefix alone
 * fills or exceeds `width`.
 */
export function wrapWithPrefix(
	prefix: string,
	text: string,
	width: number,
	layout: LayoutProbe,
): string[] {
	const w = Math.max(1, width);
	const prefixW = layout.visibleWidth(prefix);
	if (prefixW >= w) {
		// Prefix alone fills the column — wrap prefix+text as a unit
		return layout.wrapTextWithAnsi(prefix + text, w);
	}
	const textWidth = Math.max(1, w - prefixW);
	const wrapped = layout.wrapTextWithAnsi(text, textWidth);
	const indent = " ".repeat(prefixW);
	return wrapped.map((line, i) => (i === 0 ? prefix + line : indent + line));
}

// ---------------------------------------------------------------------------
// Side-by-side / stacked composition
// ---------------------------------------------------------------------------

/** Minimum column widths for the two-column side-by-side preview layout. */
export const SIDE_BY_SIDE_LEFT_MIN = 24;
export const SIDE_BY_SIDE_RIGHT_MIN = 24;

export interface ComposeSideBySideOpts {
	/**
	 * Called with the appropriate column width — `leftWidth` in side-by-side
	 * mode, or `Math.max(1, width)` in stacked mode.
	 */
	getOptionLines: (width: number) => string[];
	/**
	 * Called with the preview width and, in side-by-side mode, the option-list
	 * height to cap and pad the preview column. In stacked mode `height` is
	 * omitted so the preview renders at its natural height.
	 */
	getPreviewLines: (width: number, height?: number) => string[];
	width: number;
	theme: PanelTheme;
	layout: LayoutProbe;
}

/**
 * Compose option lines and a markdown preview into a final set of output
 * lines at the given terminal `width`.
 *
 * When `width >= SIDE_BY_SIDE_LEFT_MIN + 3 + SIDE_BY_SIDE_RIGHT_MIN` the
 * layout is two columns separated by `│`.  Below that threshold the option
 * list and preview are stacked vertically at the full `width`.
 *
 * `leftWidth + rightWidth + 3 === width` always holds in side-by-side mode.
 * A belt-and-suspenders `truncateToWidth(composed, width)` guards against
 * any rounding edge cases.
 */
export function composeSideBySide(opts: ComposeSideBySideOpts): string[] {
	const { getOptionLines, getPreviewLines, width, theme, layout } = opts;
	const threshold = SIDE_BY_SIDE_LEFT_MIN + 3 + SIDE_BY_SIDE_RIGHT_MIN;

	if (width >= threshold) {
		const leftWidth = Math.floor((width - 3) / 2);
		const rightWidth = width - leftWidth - 3;
		const optionLines = getOptionLines(leftWidth);
		const maxH = optionLines.length;
		const previewLines = getPreviewLines(rightWidth, maxH);
		const out: string[] = [];
		for (let i = 0; i < maxH; i++) {
			const l = optionLines[i] ?? "";
			const r = previewLines[i] ?? "";
			const sep = theme.fg("dim", "│");
			const composed =
				padRight(l, leftWidth, layout) + " " + sep + " " + padRight(r, rightWidth, layout);
			// Belt-and-suspenders: clamp to width in case of rounding
			out.push(layout.truncateToWidth(composed, width));
		}
		return out;
	} else {
		// Stacked layout: option list at full width, blank line, then preview at
		// natural height (no height argument → fitPreviewLines does no cap/pad).
		const effectiveWidth = Math.max(1, width);
		const optionLines = getOptionLines(effectiveWidth);
		const previewLines = getPreviewLines(effectiveWidth);
		return [...optionLines, "", ...previewLines];
	}
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

export interface RenderTabBarOpts {
	state: DialogState;
	questions: TQuestion[];
	isSubmitTab: boolean;
	allAnswered: boolean;
	width: number;
	theme: PanelTheme;
	layout: LayoutProbe;
}

/**
 * Tab-bar strip at the top of the dialog. Returns `[]` when there is only a
 * single question, matching the original live behaviour.
 */
export function renderTabBar(opts: RenderTabBarOpts): string[] {
	const { state, questions, isSubmitTab, allAnswered, width, theme, layout } = opts;
	if (questions.length < 2) return [];

	const parts: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const isActive = i === state.currentTab;
		const isDone = state.answers[i] !== null;
		const box = isDone ? "■" : "□";
		const label = ` ${box} Q${i + 1} `;
		const styled = isActive
			? theme.bg("selectedBg", theme.fg("text", label))
			: theme.fg(isDone ? "success" : "muted", label);
		parts.push(`${styled} `);
	}
	const submitLabel = " ✓ Submit ";
	const submitStyled = isSubmitTab
		? theme.bg("selectedBg", theme.fg("text", submitLabel))
		: theme.fg(allAnswered ? "success" : "dim", submitLabel);
	parts.push(submitStyled);
	return [...wrapToWidth(` ${parts.join("")}`, width, layout), ""];
}

// ---------------------------------------------------------------------------
// Option list
// ---------------------------------------------------------------------------

export interface RenderOptionListOpts {
	rows: Row[];
	state: DialogState;
	multi: boolean;
	width: number;
	theme: PanelTheme;
	layout: LayoutProbe;
}

/**
 * Render the option rows for a question tab. Handles the cursor `> `
 * prefix, multi-select `[x] / [ ]` checkbox, the `✎` note-present marker,
 * and the per-row description / note sub-lines.
 */
export function renderOptionList(opts: RenderOptionListOpts): string[] {
	const { rows, state, multi, width, theme, layout } = opts;
	const lines: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i]!;
		const isCursor = i === state.rowIndex;
		const cursorPrefix = isCursor ? theme.fg("accent", "> ") : "  ";
		let checkbox = "";
		if (r.kind === "option" && multi) {
			const set = state.multiSel[state.currentTab]!;
			checkbox = set.has(r.optionIndex!)
				? theme.fg("success", "[x] ")
				: theme.fg("muted", "[ ] ");
		}
		const sentinelColor =
			r.kind === "option"
				? isCursor
					? "accent"
					: "text"
				: r.kind === "chat"
					? "warning"
					: "accent";
		const labelText = `${r.kind === "option" && r.optionIndex !== undefined ? `${r.optionIndex + 1}. ` : ""}${r.label}`;
		const note =
			r.kind === "option" ? state.notesByTab[state.currentTab]?.[r.optionIndex!] : undefined;
		const noteTag = note ? theme.fg("dim", "  ✎") : "";
		lines.push(
			...wrapWithPrefix(
				`${cursorPrefix}${checkbox}`,
				`${theme.fg(sentinelColor, labelText)}${noteTag}`,
				width,
				layout,
			),
		);
		if (r.description) {
			lines.push(...wrapWithPrefix("     ", theme.fg("muted", r.description), width, layout));
		}
		if (note) {
			lines.push(...wrapWithPrefix("     ", theme.fg("dim", `note: ${note}`), width, layout));
		}
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Submit tab
// ---------------------------------------------------------------------------

export interface RenderSubmitTabOpts {
	state: DialogState;
	questions: TQuestion[];
	allAnswered: boolean;
	width: number;
	theme: PanelTheme;
	layout: LayoutProbe;
}

/**
 * Render the review / submit tab: one block per question (either the
 * captured answer or `(unanswered)`), plus a trailing "Press Enter to
 * submit" or "Unanswered: Qn, Qm" summary.
 */
export function renderSubmitTab(opts: RenderSubmitTabOpts): string[] {
	const { state, questions, allAnswered, width, theme, layout } = opts;
	const lines: string[] = [];
	lines.push(...wrapToWidth(theme.fg("accent", theme.bold(" Review your answers")), width, layout));
	lines.push("");
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const a = state.answers[i];
		lines.push(...wrapToWidth(theme.fg("muted", ` Q${i + 1}. ${q.question}`), width, layout));
		if (!a) {
			lines.push(...wrapWithPrefix("    ", theme.fg("warning", "(unanswered)"), width, layout));
		} else if (a.kind === "single") {
			const tail = a.note ? theme.fg("dim", ` (note: ${a.note})`) : "";
			lines.push(
				...wrapWithPrefix(
					"    ",
					`${theme.fg("text", `${a.index + 1}. ${a.label}`)}${tail}`,
					width,
					layout,
				),
			);
		} else if (a.kind === "multi") {
			for (let k = 0; k < a.indices.length; k++) {
				const idx = a.indices[k]!;
				const lbl = a.labels[k];
				const note = a.notes[idx];
				const tail = note ? theme.fg("dim", ` (note: ${note})`) : "";
				lines.push(
					...wrapWithPrefix(
						"    ",
						`${theme.fg("text", `[x] ${idx + 1}. ${lbl}`)}${tail}`,
						width,
						layout,
					),
				);
			}
		} else if (a.kind === "text") {
			lines.push(...wrapWithPrefix("    ", theme.fg("text", `"${a.text}"`), width, layout));
		} else {
			lines.push(...wrapWithPrefix("    ", theme.fg("warning", `chat: ${a.text}`), width, layout));
		}
		lines.push("");
	}
	if (allAnswered) {
		lines.push(...wrapToWidth(theme.fg("success", " Press Enter to submit"), width, layout));
	} else {
		const missing = questions
			.map((_, i) => (state.answers[i] ? null : `Q${i + 1}`))
			.filter(Boolean)
			.join(", ");
		lines.push(...wrapToWidth(theme.fg("warning", ` Unanswered: ${missing}`), width, layout));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Help bar
// ---------------------------------------------------------------------------

export interface RenderHelpOpts {
	state: DialogState;
	activeQuestion: TQuestion | undefined;
	isSubmitTab: boolean;
	hasMultipleQuestions: boolean;
	width: number;
	theme: PanelTheme;
	layout: LayoutProbe;
}

/**
 * Render the dim help row at the bottom of the panel. Returns `[]` while
 * any free-text input mode is open (the input panel renders its own hints).
 */
export function renderHelp(opts: RenderHelpOpts): string[] {
	const { state, activeQuestion, isSubmitTab, hasMultipleQuestions, width, theme, layout } = opts;
	if (state.inputMode !== "none") return [];

	const parts: string[] = [];
	if (isSubmitTab) {
		if (hasMultipleQuestions) parts.push("Tab/←→ switch tab");
		parts.push("Enter submit");
		parts.push("Esc cancel");
	} else if (activeQuestion?.multiSelect === true) {
		if (hasMultipleQuestions) parts.push("Tab/←→ tabs");
		parts.push("↑↓ move");
		parts.push("Space/Enter toggle");
		parts.push("n note");
		parts.push("Next row to advance");
		parts.push("Esc cancel");
	} else {
		if (hasMultipleQuestions) parts.push("Tab/←→ tabs");
		parts.push("↑↓ move");
		parts.push("Enter select");
		parts.push("n note");
		parts.push("Esc cancel");
	}
	return wrapToWidth(theme.fg("dim", ` ${parts.join(" • ")}`), width, layout);
}

// ---------------------------------------------------------------------------
// fitPreviewLines — pure tail of renderPreviewPane
// ---------------------------------------------------------------------------

/**
 * Cap, pad and truncate an array of markdown-rendered lines.
 *
 * - When `maxHeight` is a number: slice to `maxHeight` lines and pad with `""`
 *   to reach exactly `maxHeight` (keeps side-by-side columns aligned).
 * - When `maxHeight` is `undefined`: natural height — no cap, no pad.
 * - Every line is truncated to `width` via `layout.truncateToWidth`.
 */
export function fitPreviewLines(
	mdLines: string[],
	width: number,
	maxHeight: number | undefined,
	layout: LayoutProbe,
): string[] {
	let lines = mdLines;
	if (maxHeight !== undefined) {
		lines = lines.slice(0, maxHeight);
		while (lines.length < maxHeight) lines.push("");
	}
	return lines.map((l) => layout.truncateToWidth(l, width));
}

// ---------------------------------------------------------------------------
// renderInputPanel — pure framing for free-text input modes
// ---------------------------------------------------------------------------

/**
 * Render the framed input-panel block shown below the option list when the
 * dialog is in `text`, `note`, or `chat` input mode.
 *
 * `editorLines` must already be rendered at the appropriate width (typically
 * `width - 2`) by the caller before being passed here.
 */
export function renderInputPanel(
	label: string,
	editorLines: string[],
	width: number,
	theme: PanelTheme,
	layout: LayoutProbe,
): string[] {
	const lines: string[] = [];
	lines.push("");
	lines.push(layout.truncateToWidth(theme.fg("muted", ` ${label}:`), width));
	for (const l of editorLines) {
		lines.push(layout.truncateToWidth(` ${l}`, width));
	}
	lines.push("");
	lines.push(layout.truncateToWidth(theme.fg("dim", " Enter to submit • Esc to cancel"), width));
	return lines;
}

// ---------------------------------------------------------------------------
// composePanel — the full dialog body, pure
// ---------------------------------------------------------------------------

export interface ComposePanelOpts {
	state: DialogState;
	questions: TQuestion[];
	isSubmitTab: boolean;
	allAnswered: boolean;
	rows: Row[];
	width: number;
	theme: PanelTheme;
	layout: LayoutProbe;
	/** Injected live editor renderer; called with the editor width. */
	getEditorLines: (width: number) => string[];
	/**
	 * Injected live markdown renderer. In side-by-side mode called with
	 * `(rightWidth, optionListHeight)` so the preview column is capped/padded
	 * to match the option list. In stacked mode called with `(effectiveWidth)`
	 * — no height — so the preview renders at its natural height.
	 */
	getPreviewLines: (width: number, height?: number) => string[];
}

/**
 * Assemble the full dialog panel from pure data.  No pi-tui imports needed
 * here — all live primitives are injected via `opts`.
 */
export function composePanel(opts: ComposePanelOpts): string[] {
	const {
		state,
		questions,
		isSubmitTab,
		allAnswered,
		rows,
		width,
		theme,
		layout,
		getEditorLines,
		getPreviewLines,
	} = opts;

	const lines: string[] = [];
	const sep = theme.fg("accent", "─".repeat(Math.max(1, width)));
	lines.push(sep);

	for (const l of renderTabBar({ state, questions, isSubmitTab, allAnswered, width, theme, layout })) {
		lines.push(l);
	}

	if (isSubmitTab) {
		for (const l of renderSubmitTab({ state, questions, allAnswered, width, theme, layout })) {
			lines.push(l);
		}
		lines.push("");
		for (const l of renderHelp({
			state,
			activeQuestion: undefined,
			isSubmitTab: true,
			hasMultipleQuestions: questions.length > 1,
			width,
			theme,
			layout,
		})) {
			lines.push(l);
		}
		lines.push(sep);
		return lines;
	}

	const q = questions[state.currentTab]!;
	lines.push(layout.truncateToWidth(theme.fg("text", theme.bold(` ${q.question}`)), width));
	if (q.description) {
		lines.push(layout.truncateToWidth(theme.fg("muted", ` ${q.description}`), width));
	}
	lines.push("");

	const activeRow = rows[state.rowIndex];
	const activePreview = activeRow?.kind === "option" ? activeRow.preview : undefined;
	if (activePreview) {
		for (const l of composeSideBySide({
			getOptionLines: (w) =>
				renderOptionList({ rows, state, multi: q.multiSelect === true, width: w, theme, layout }),
			getPreviewLines,
			width,
			theme,
			layout,
		})) {
			lines.push(l);
		}
	} else {
		for (const l of renderOptionList({
			rows,
			state,
			multi: q.multiSelect === true,
			width,
			theme,
			layout,
		})) {
			lines.push(l);
		}
	}

	const editorWidth = Math.max(1, width - 2);
	if (state.inputMode === "text") {
		for (const l of renderInputPanel("Your answer", getEditorLines(editorWidth), width, theme, layout)) {
			lines.push(l);
		}
	} else if (state.inputMode === "note") {
		for (const l of renderInputPanel("Note for this option", getEditorLines(editorWidth), width, theme, layout)) {
			lines.push(l);
		}
	} else if (state.inputMode === "chat") {
		for (const l of renderInputPanel(
			"What would you like to chat about?",
			getEditorLines(editorWidth),
			width,
			theme,
			layout,
		)) {
			lines.push(l);
		}
	}

	lines.push("");
	for (const l of renderHelp({
		state,
		activeQuestion: q,
		isSubmitTab: false,
		hasMultipleQuestions: questions.length > 1,
		width,
		theme,
		layout,
	})) {
		lines.push(l);
	}
	lines.push(sep);
	return lines;
}
