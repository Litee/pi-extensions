/**
 * TUI glue for the ask_user_question dialog.
 *
 * All routing and layout logic lives in:
 *   - `controller.ts`  — pure state machine
 *   - `inputRouter.ts` — pure key-dispatch
 *   - `renderPanel.ts` — pure layout helpers (tab bar, option list, submit, help)
 *
 * This file only owns the pieces that need a live pi-tui runtime: the
 * `Editor` component, the `Markdown` preview cache, the side-by-side
 * option/preview composition, and translation of {@link KeyAction} values
 * into concrete controller + editor + `done()` calls.
 *
 * Excluded from v8 coverage (see `vitest.config.ts`) because exercising it
 * requires the real pi-tui stack (Kitty keyboard protocol, Markdown
 * highlighter, etc.), which we intentionally do not mock.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { DialogController } from "./controller.js";
import type { Result } from "./format.js";
import { dispatchKey, type KeyAction, type KeyId, type KeyProbe } from "./inputRouter.js";
import {
	padRight,
	renderHelp,
	renderOptionList,
	renderSubmitTab,
	renderTabBar,
	type LayoutProbe,
	type PanelTheme,
} from "./renderPanel.js";
import type { Row } from "./rows.js";
import type { TQuestion } from "./schema.js";

/** Bridge from router `KeyId` strings onto pi-tui's `matchesKey` + `Key` constants. */
const keyProbe: KeyProbe = {
	matches(data, keyId: KeyId) {
		switch (keyId) {
			case "tab": return matchesKey(data, Key.tab);
			case "shift-tab": return matchesKey(data, Key.shift("tab"));
			case "left": return matchesKey(data, Key.left);
			case "right": return matchesKey(data, Key.right);
			case "up": return matchesKey(data, Key.up);
			case "down": return matchesKey(data, Key.down);
			case "enter": return matchesKey(data, Key.enter);
			case "escape": return matchesKey(data, Key.escape);
			case "space": return matchesKey(data, Key.space);
		}
	},
};

export function runDialog(ctx: ExtensionContext, questions: TQuestion[]): Promise<Result> {
	return ctx.ui.custom((tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (v: Result) => void) => {
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

		const panelTheme: PanelTheme = theme as unknown as PanelTheme;
		const layout: LayoutProbe = { truncateToWidth, visibleWidth };

		function openEditorForNote(): void {
			editor.setText(ctrl.getCurrentNoteDraft());
			tui.requestRender();
		}

		function finishIfDone(): boolean {
			const status = ctrl.getStatus();
			if (status.kind === "done") {
				done(status.result);
				return true;
			}
			return false;
		}

		function applyAction(action: KeyAction, data: string): void {
			switch (action.kind) {
				case "cancel-input":
					ctrl.cancelInput();
					editor.setText("");
					tui.requestRender();
					return;
				case "editor-input":
					editor.handleInput(data);
					tui.requestRender();
					return;
				case "next-tab":
					ctrl.nextTab();
					tui.requestRender();
					return;
				case "prev-tab":
					ctrl.prevTab();
					tui.requestRender();
					return;
				case "move-up":
					ctrl.moveUp();
					tui.requestRender();
					return;
				case "move-down":
					ctrl.moveDown();
					tui.requestRender();
					return;
				case "begin-note":
					if (ctrl.beginNote()) openEditorForNote();
					return;
				case "toggle-current":
					ctrl.toggleCurrent();
					tui.requestRender();
					return;
				case "enter": {
					ctrl.enter();
					if (finishIfDone()) return;
					if (ctrl.getState().inputMode !== "none") editor.setText("");
					tui.requestRender();
					return;
				}
				case "cancel":
					ctrl.cancel();
					if (finishIfDone()) return;
					tui.requestRender();
					return;
				case "ignore":
					return;
			}
		}

		function handleInput(data: string): void {
			applyAction(dispatchKey(ctrl.getState(), questions, data, keyProbe), data);
		}

		// ---- rendering --------------------------------------------------------

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

		function renderSideBySide(rows: Row[], activePreview: string, width: number): string[] {
			const s = ctrl.getState();
			const q = questions[s.currentTab];
			const multi = q?.multiSelect === true;
			const leftWidth = Math.max(20, Math.floor(width * 0.5));
			const rightWidth = Math.max(20, width - leftWidth - 3);
			const leftLines = renderOptionList({
				rows,
				state: s,
				multi,
				width: leftWidth,
				theme: panelTheme,
				layout,
			});
			const maxH = leftLines.length;
			const rightLines = renderPreviewPane(activePreview, rightWidth, maxH);
			const out: string[] = [];
			for (let i = 0; i < maxH; i++) {
				const l = leftLines[i] ?? "";
				const r = rightLines[i] ?? "";
				const sep = theme.fg("dim", "│");
				out.push(padRight(l, leftWidth, layout) + " " + sep + " " + padRight(r, rightWidth, layout));
			}
			return out;
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

		function render(width: number): string[] {
			const s = ctrl.getState();
			const lines: string[] = [];
			const sep = theme.fg("accent", "─".repeat(Math.max(4, width)));
			lines.push(sep);
			for (const l of renderTabBar({
				state: s,
				questions,
				isSubmitTab: ctrl.isSubmitTab(),
				allAnswered: ctrl.allAnswered(),
				width,
				theme: panelTheme,
				layout,
			})) {
				lines.push(l);
			}

			if (ctrl.isSubmitTab()) {
				for (const l of renderSubmitTab({
					state: s,
					questions,
					allAnswered: ctrl.allAnswered(),
					width,
					theme: panelTheme,
					layout,
				})) {
					lines.push(l);
				}
				lines.push("");
				for (const l of renderHelp({
					state: s,
					activeQuestion: undefined,
					isSubmitTab: true,
					hasMultipleQuestions: questions.length > 1,
					width,
					theme: panelTheme,
					layout,
				})) {
					lines.push(l);
				}
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
				for (const l of renderOptionList({
					rows,
					state: s,
					multi: q.multiSelect === true,
					width,
					theme: panelTheme,
					layout,
				})) {
					lines.push(l);
				}
			}

			if (s.inputMode === "text") {
				for (const l of renderInputPanel("Your answer", width)) lines.push(l);
			} else if (s.inputMode === "note") {
				for (const l of renderInputPanel("Note for this option", width)) lines.push(l);
			} else if (s.inputMode === "chat") {
				for (const l of renderInputPanel("What would you like to chat about?", width)) lines.push(l);
			}

			lines.push("");
			for (const l of renderHelp({
				state: s,
				activeQuestion: q,
				isSubmitTab: false,
				hasMultipleQuestions: questions.length > 1,
				width,
				theme: panelTheme,
				layout,
			})) {
				lines.push(l);
			}
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
