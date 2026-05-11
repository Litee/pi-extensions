/**
 * Pure render helpers for the ask_user_question dialog.
 *
 * Every function here returns an array of styled strings (one per visual
 * row). Theme colouring, `truncateToWidth` and `visibleWidth` are passed
 * as parameters so tests can inject deterministic fakes without booting
 * pi-tui.
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
}

/** Pad `s` on the right to `width` columns (uses `visibleWidth`). */
export function padRight(s: string, width: number, layout: LayoutProbe): string {
	const w = layout.visibleWidth(s);
	if (w >= width) return layout.truncateToWidth(s, width);
	return s + " ".repeat(width - w);
}

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
	return [layout.truncateToWidth(` ${parts.join("")}`, width), ""];
}

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
		const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
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
			layout.truncateToWidth(
				`${prefix}${checkbox}${theme.fg(sentinelColor, labelText)}${noteTag}`,
				width,
			),
		);
		if (r.description) {
			lines.push(layout.truncateToWidth(`     ${theme.fg("muted", r.description)}`, width));
		}
		if (note) {
			lines.push(layout.truncateToWidth(`     ${theme.fg("dim", `note: ${note}`)}`, width));
		}
	}
	return lines;
}

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
	lines.push(layout.truncateToWidth(theme.fg("accent", theme.bold(" Review your answers")), width));
	lines.push("");
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const a = state.answers[i];
		lines.push(layout.truncateToWidth(theme.fg("muted", ` Q${i + 1}. ${q.question}`), width));
		if (!a) {
			lines.push(layout.truncateToWidth(`    ${theme.fg("warning", "(unanswered)")}`, width));
		} else if (a.kind === "single") {
			const tail = a.note ? theme.fg("dim", ` (note: ${a.note})`) : "";
			lines.push(
				layout.truncateToWidth(
					`    ${theme.fg("text", `${a.index + 1}. ${a.label}`)}${tail}`,
					width,
				),
			);
		} else if (a.kind === "multi") {
			for (let k = 0; k < a.indices.length; k++) {
				const idx = a.indices[k]!;
				const lbl = a.labels[k];
				const note = a.notes[idx];
				const tail = note ? theme.fg("dim", ` (note: ${note})`) : "";
				lines.push(
					layout.truncateToWidth(
						`    ${theme.fg("text", `[x] ${idx + 1}. ${lbl}`)}${tail}`,
						width,
					),
				);
			}
		} else if (a.kind === "text") {
			lines.push(layout.truncateToWidth(`    ${theme.fg("text", `"${a.text}"`)}`, width));
		} else {
			lines.push(layout.truncateToWidth(`    ${theme.fg("warning", `chat: ${a.text}`)}`, width));
		}
		lines.push("");
	}
	if (allAnswered) {
		lines.push(layout.truncateToWidth(theme.fg("success", " Press Enter to submit"), width));
	} else {
		const missing = questions
			.map((_, i) => (state.answers[i] ? null : `Q${i + 1}`))
			.filter(Boolean)
			.join(", ");
		lines.push(layout.truncateToWidth(theme.fg("warning", ` Unanswered: ${missing}`), width));
	}
	return lines;
}

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
	return [layout.truncateToWidth(theme.fg("dim", ` ${parts.join(" • ")}`), width)];
}
