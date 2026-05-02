/**
 * TUI glue for the ask_user_question dialog.
 *
 * The business logic lives in `DialogController` (state machine, pure) and in
 * the `rows` / `format` / `render` helpers. This file is the thin wrapper
 * that wires the controller to the real pi-tui components:
 *
 *  - an `Editor` for free-text input (Type something / note / chat)
 *  - a `Markdown` cache for side-by-side option previews
 *  - keystroke routing (`matchesKey(data, Key.*)`) → controller methods
 *  - rendering controller state into an array of styled lines
 *
 * The file is excluded from v8 coverage (via `vitest.config.ts`) because
 * exercising it requires a real pi-tui stack (Kitty keyboard protocol,
 * Markdown highlighter, etc.) which we deliberately do not mock. Every piece
 * of logic worth testing has been factored into the modules above.
 */

import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";

import { DialogController } from "./controller.js";
import type { Result } from "./format.js";
import type { Row } from "./rows.js";
import type { TQuestion } from "./schema.js";

export function runDialog(
	ctx: any,
	questions: TQuestion[],
): Promise<Result> {
	return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: Result) => void) => {
		const ctrl = new DialogController(questions);

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);
		editor.onSubmit = (value: string) => {
			ctrl.submitInput(value);
			editor.setText("");
			const status = ctrl.getStatus();
			if (status.kind === "done") done(status.result);
			else tui.requestRender();
		};

		const previewCache = new Map<string, Markdown>();
		const mdTheme = getMarkdownTheme();
		const getPreview = (preview: string): Markdown => {
			let m = previewCache.get(preview);
			if (m === undefined) {
				m = new Markdown(preview, 0, 0, mdTheme);
				previewCache.set(preview, m);
			}
			return m;
		};

		function openEditorForNote(): void {
			editor.setText(ctrl.getCurrentNoteDraft());
			tui.requestRender();
		}

		function handleInput(data: string): void {
			const state = ctrl.getState();

			if (state.inputMode !== "none") {
				if (matchesKey(data, Key.escape)) {
					ctrl.cancelInput();
					editor.setText("");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
				return;
			}

			if (ctrl.isSubmitTab()) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					ctrl.nextTab();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					ctrl.prevTab();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					ctrl.enter();
					const status = ctrl.getStatus();
					if (status.kind === "done") done(status.result);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					ctrl.cancel();
					const status = ctrl.getStatus();
					if (status.kind === "done") done(status.result);
					return;
				}
				return;
			}

			// Regular question tab.
			if (questions.length > 1) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					ctrl.nextTab();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					ctrl.prevTab();
					tui.requestRender();
					return;
				}
			}

			if (matchesKey(data, Key.up)) {
				ctrl.moveUp();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				ctrl.moveDown();
				tui.requestRender();
				return;
			}

			if (data === "n") {
				if (ctrl.beginNote()) {
					openEditorForNote();
					return;
				}
			}

			if (ctrl.isMultiSelect() && matchesKey(data, Key.space)) {
				ctrl.toggleCurrent();
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				ctrl.enter();
				const status = ctrl.getStatus();
				if (status.kind === "done") {
					done(status.result);
					return;
				}
				// Text / chat mode may have been opened; clear the editor.
				if (ctrl.getState().inputMode !== "none") editor.setText("");
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				ctrl.cancel();
				const status = ctrl.getStatus();
				if (status.kind === "done") done(status.result);
				return;
			}
		}

		// ---- rendering --------------------------------------------------------

		function renderTabBar(width: number): string[] {
			if (questions.length < 2) return [];
			const s = ctrl.getState();
			const parts: string[] = [];
			for (let i = 0; i < questions.length; i++) {
				const isActive = i === s.currentTab;
				const isDone = s.answers[i] !== null;
				const box = isDone ? "■" : "□";
				const label = ` ${box} Q${i + 1} `;
				const styled = isActive
					? theme.bg("selectedBg", theme.fg("text", label))
					: theme.fg(isDone ? "success" : "muted", label);
				parts.push(`${styled} `);
			}
			const isSubmit = ctrl.isSubmitTab();
			const submitLabel = " ✓ Submit ";
			const submitStyled = isSubmit
				? theme.bg("selectedBg", theme.fg("text", submitLabel))
				: theme.fg(ctrl.allAnswered() ? "success" : "dim", submitLabel);
			parts.push(submitStyled);
			return [truncateToWidth(` ${parts.join("")}`, width), ""];
		}

		function renderOptionList(rows: Row[], width: number): string[] {
			const s = ctrl.getState();
			const q = questions[s.currentTab];
			const multi = q?.multiSelect === true;
			const lines: string[] = [];
			for (let i = 0; i < rows.length; i++) {
				const r = rows[i]!;
				const isCursor = i === s.rowIndex;
				const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
				let checkbox = "";
				if (r.kind === "option" && multi) {
					const set = s.multiSel[s.currentTab]!;
					checkbox = set.has(r.optionIndex!) ? theme.fg("success", "[x] ") : theme.fg("muted", "[ ] ");
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
					r.kind === "option" ? s.notesByTab[s.currentTab]?.[r.optionIndex!] : undefined;
				const noteTag = note ? theme.fg("dim", "  ✎") : "";
				lines.push(truncateToWidth(`${prefix}${checkbox}${theme.fg(sentinelColor, labelText)}${noteTag}`, width));
				if (r.description) lines.push(truncateToWidth(`     ${theme.fg("muted", r.description)}`, width));
				if (note) lines.push(truncateToWidth(`     ${theme.fg("dim", `note: ${note}`)}`, width));
			}
			return lines;
		}

		function renderPreviewPane(preview: string, width: number, maxHeight: number): string[] {
			const md = getPreview(preview);
			md.invalidate();
			let mdLines: string[] = [];
			try {
				mdLines = md.render(Math.max(10, width));
			} catch {
				mdLines = preview.split("\n");
			}
			if (mdLines.length > maxHeight) mdLines = mdLines.slice(0, maxHeight);
			while (mdLines.length < maxHeight) mdLines.push("");
			return mdLines.map((l) => truncateToWidth(l, width));
		}

		function padRight(s: string, width: number): string {
			const w = visibleWidth(s);
			if (w >= width) return truncateToWidth(s, width);
			return s + " ".repeat(width - w);
		}

		function renderSideBySide(rows: Row[], activePreview: string, width: number): string[] {
			const leftWidth = Math.max(20, Math.floor(width * 0.5));
			const rightWidth = Math.max(20, width - leftWidth - 3);
			const leftLines = renderOptionList(rows, leftWidth);
			const maxH = leftLines.length;
			const rightLines = renderPreviewPane(activePreview, rightWidth, maxH);
			const out: string[] = [];
			for (let i = 0; i < maxH; i++) {
				const l = leftLines[i] ?? "";
				const r = rightLines[i] ?? "";
				const sep = theme.fg("dim", "│");
				out.push(padRight(l, leftWidth) + " " + sep + " " + padRight(r, rightWidth));
			}
			return out;
		}

		function renderSubmitTab(width: number): string[] {
			const s = ctrl.getState();
			const lines: string[] = [];
			lines.push(truncateToWidth(theme.fg("accent", theme.bold(" Review your answers")), width));
			lines.push("");
			for (let i = 0; i < questions.length; i++) {
				const q = questions[i]!;
				const a = s.answers[i];
				lines.push(truncateToWidth(theme.fg("muted", ` Q${i + 1}. ${q.question}`), width));
				if (!a) {
					lines.push(truncateToWidth(`    ${theme.fg("warning", "(unanswered)")}`, width));
				} else if (a.kind === "single") {
					const tail = a.note ? theme.fg("dim", ` (note: ${a.note})`) : "";
					lines.push(truncateToWidth(`    ${theme.fg("text", `${a.index + 1}. ${a.label}`)}${tail}`, width));
				} else if (a.kind === "multi") {
					for (let k = 0; k < a.indices.length; k++) {
						const idx = a.indices[k]!;
						const lbl = a.labels[k];
						const note = a.notes[idx];
						const tail = note ? theme.fg("dim", ` (note: ${note})`) : "";
						lines.push(truncateToWidth(`    ${theme.fg("text", `[x] ${idx + 1}. ${lbl}`)}${tail}`, width));
					}
				} else if (a.kind === "text") {
					lines.push(truncateToWidth(`    ${theme.fg("text", `"${a.text}"`)}`, width));
				} else {
					lines.push(truncateToWidth(`    ${theme.fg("warning", `chat: ${a.text}`)}`, width));
				}
				lines.push("");
			}
			if (ctrl.allAnswered()) {
				lines.push(truncateToWidth(theme.fg("success", " Press Enter to submit"), width));
			} else {
				const missing = questions
					.map((_, i) => (s.answers[i] ? null : `Q${i + 1}`))
					.filter(Boolean)
					.join(", ");
				lines.push(truncateToWidth(theme.fg("warning", ` Unanswered: ${missing}`), width));
			}
			return lines;
		}

		function renderInputPanel(label: string, width: number): string[] {
			const lines: string[] = [];
			lines.push("");
			lines.push(truncateToWidth(theme.fg("muted", ` ${label}:`), width));
			for (const l of editor.render(Math.max(10, width - 2))) {
				lines.push(truncateToWidth(` ${l}`, width));
			}
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", " Enter to submit • Esc to cancel"), width));
			return lines;
		}

		function renderHelp(width: number): string[] {
			const s = ctrl.getState();
			if (s.inputMode !== "none") return [];
			const q = questions[s.currentTab];
			const multi = questions.length > 1;
			const parts: string[] = [];
			if (ctrl.isSubmitTab()) {
				if (multi) parts.push("Tab/←→ switch tab");
				parts.push("Enter submit");
				parts.push("Esc cancel");
			} else if (q?.multiSelect === true) {
				if (multi) parts.push("Tab/←→ tabs");
				parts.push("↑↓ move");
				parts.push("Space/Enter toggle");
				parts.push("n note");
				parts.push("Next row to advance");
				parts.push("Esc cancel");
			} else {
				if (multi) parts.push("Tab/←→ tabs");
				parts.push("↑↓ move");
				parts.push("Enter select");
				parts.push("n note");
				parts.push("Esc cancel");
			}
			return [truncateToWidth(theme.fg("dim", ` ${parts.join(" • ")}`), width)];
		}

		function render(width: number): string[] {
			const s = ctrl.getState();
			const lines: string[] = [];
			const sep = theme.fg("accent", "─".repeat(Math.max(4, width)));
			lines.push(sep);
			for (const l of renderTabBar(width)) lines.push(l);

			if (ctrl.isSubmitTab()) {
				for (const l of renderSubmitTab(width)) lines.push(l);
				lines.push("");
				for (const l of renderHelp(width)) lines.push(l);
				lines.push(sep);
				return lines;
			}

			const q = questions[s.currentTab]!;
			const rows = ctrl.currentRows();
			lines.push(truncateToWidth(theme.fg("text", theme.bold(` ${q.question}`)), width));
			if (q.description) lines.push(truncateToWidth(theme.fg("muted", ` ${q.description}`), width));
			lines.push("");

			const activeRow = rows[s.rowIndex];
			const activePreview = activeRow?.kind === "option" ? activeRow.preview : undefined;
			if (activePreview) {
				for (const l of renderSideBySide(rows, activePreview, width)) lines.push(l);
			} else {
				for (const l of renderOptionList(rows, width)) lines.push(l);
			}

			if (s.inputMode === "text") {
				for (const l of renderInputPanel("Your answer", width)) lines.push(l);
			} else if (s.inputMode === "note") {
				for (const l of renderInputPanel("Note for this option", width)) lines.push(l);
			} else if (s.inputMode === "chat") {
				for (const l of renderInputPanel("What would you like to chat about?", width)) lines.push(l);
			}

			lines.push("");
			for (const l of renderHelp(width)) lines.push(l);
			lines.push(sep);
			return lines;
		}

		return {
			render,
			invalidate: () => {
				for (const m of previewCache.values()) m.invalidate();
			},
			handleInput,
		};
	});
}
