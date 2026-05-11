/**
 * `DialogController` — pure state machine driving the ask_user_question UI.
 *
 * The controller owns everything that survives a repaint: the current tab,
 * row cursor, per-tab multi-select bitmap, per-option notes, recorded answers,
 * and which free-text input mode (if any) is active. It exposes small,
 * intention-revealing methods (`moveUp`, `enter`, `toggle`, `submitText`, …)
 * so the TUI glue in `dialog.ts` only needs to translate keystrokes — and
 * tests can drive the same methods directly.
 *
 * No imports from `@earendil-works/pi-tui` or `@earendil-works/pi-coding-agent`
 * are allowed in this file. Keeping those dependencies out is what lets us
 * unit-test the whole interaction model deterministically.
 */

import type { Answer, Result } from "./format.js";
import { buildRows, type Row } from "./rows.js";
import type { TQuestion } from "./schema.js";

export type InputMode = "none" | "text" | "note" | "chat";

export type DialogStatus =
	| { kind: "open" }
	| { kind: "done"; result: Result };

export interface DialogState {
	/** Index of the active tab. `questions.length` means the Submit tab. */
	currentTab: number;
	/** Zero-based row cursor within the active tab's rows. */
	rowIndex: number;
	inputMode: InputMode;
	/** When inputMode === "note", the option being annotated in the current tab. */
	noteTargetOptionIndex: number | null;
	answers: (Answer | null)[];
	/** Set of selected option indices per multi-select tab. */
	multiSel: Set<number>[];
	/** Per-tab optionIndex -> note text map. */
	notesByTab: Record<number, string>[];
}

export class DialogController {
	readonly questions: TQuestion[];
	readonly rowsByTab: Row[][];
	readonly totalTabs: number;

	private state: DialogState;
	private finished = false;
	private finalResult: Result | null = null;

	constructor(questions: TQuestion[]) {
		this.questions = questions;
		this.rowsByTab = questions.map((q) => buildRows(q));
		this.totalTabs = questions.length + 1; // last tab = Submit
		this.state = {
			currentTab: 0,
			rowIndex: 0,
			inputMode: "none",
			noteTargetOptionIndex: null,
			answers: questions.map(() => null),
			multiSel: questions.map(() => new Set<number>()),
			notesByTab: questions.map(() => ({})),
		};
	}

	// ---- public state accessors ------------------------------------------

	getState(): DialogState {
		return this.state;
	}

	getStatus(): DialogStatus {
		if (this.finished && this.finalResult !== null) {
			return { kind: "done", result: this.finalResult };
		}
		return { kind: "open" };
	}

	isDone(): boolean {
		return this.finished;
	}

	/** Rows for the active tab, or [] on the Submit tab. */
	currentRows(): Row[] {
		const s = this.state;
		if (s.currentTab >= this.questions.length) return [];
		return this.rowsByTab[s.currentTab] ?? [];
	}

	/** The currently highlighted row, or undefined on the Submit tab. */
	currentRow(): Row | undefined {
		return this.currentRows()[this.state.rowIndex];
	}

	/** True once every question has an answer (Submit becomes actionable). */
	allAnswered(): boolean {
		return this.state.answers.every((a) => a !== null);
	}

	/** True when the active tab's question is multi-select. */
	isMultiSelect(): boolean {
		const q = this.questions[this.state.currentTab];
		return q?.multiSelect === true;
	}

	/** Convenience: is the Submit/review tab active? */
	isSubmitTab(): boolean {
		return this.state.currentTab === this.questions.length;
	}

	// ---- navigation ------------------------------------------------------

	/** Move to the next tab with wraparound. */
	nextTab(): void {
		if (this.state.inputMode !== "none") return;
		this.state.currentTab = (this.state.currentTab + 1) % this.totalTabs;
		this.state.rowIndex = 0;
	}

	/** Move to the previous tab with wraparound. */
	prevTab(): void {
		if (this.state.inputMode !== "none") return;
		this.state.currentTab = (this.state.currentTab - 1 + this.totalTabs) % this.totalTabs;
		this.state.rowIndex = 0;
	}

	moveUp(): void {
		if (this.state.inputMode !== "none") return;
		this.state.rowIndex = Math.max(0, this.state.rowIndex - 1);
	}

	moveDown(): void {
		if (this.state.inputMode !== "none") return;
		const rows = this.currentRows();
		if (rows.length === 0) return;
		this.state.rowIndex = Math.min(rows.length - 1, this.state.rowIndex + 1);
	}

	// ---- selection / actions --------------------------------------------

	/**
	 * Primary action on the current row. Implements the Enter semantics from
	 * the reference extension:
	 *  - on the Submit tab: completes with success if all answered
	 *  - on "chat" / "text": opens the matching input mode
	 *  - on "next" (multi-select sentinel): advances when at least one option
	 *    is selected, otherwise no-op
	 *  - on an option row:
	 *     - single-select: record answer, advance to next tab / Submit
	 *     - multi-select: toggle the index (like Space)
	 */
	enter(): void {
		if (this.state.inputMode !== "none") return;

		if (this.isSubmitTab()) {
			if (this.allAnswered()) this.finish(false);
			return;
		}

		const row = this.currentRow();
		if (!row) return;

		if (row.kind === "chat") {
			this.state.inputMode = "chat";
			return;
		}
		if (row.kind === "text") {
			this.state.inputMode = "text";
			return;
		}
		if (row.kind === "next") {
			if (this.state.multiSel[this.state.currentTab]?.size ?? 0) this.advanceAfterAnswer();
			return;
		}
		// kind === "option"
		if (this.isMultiSelect()) {
			this.toggleCurrent();
			return;
		}
		this.recordSingle(row.optionIndex as number, row.label);
		this.advanceAfterAnswer();
	}

	/** Toggle the currently highlighted option in multi-select mode. No-op otherwise. */
	toggleCurrent(): void {
		if (this.state.inputMode !== "none") return;
		if (!this.isMultiSelect()) return;
		const row = this.currentRow();
		if (!row || row.kind !== "option" || row.optionIndex === undefined) return;
		const set = this.state.multiSel[this.state.currentTab];
		if (!set) return;
		if (set.has(row.optionIndex)) set.delete(row.optionIndex);
		else set.add(row.optionIndex);
		if (set.size > 0) this.recordMulti();
		else this.state.answers[this.state.currentTab] = null;
	}

	/**
	 * Open the note editor for the currently highlighted option. No-op when the
	 * cursor is not on a real option row, or when an input mode is already open.
	 */
	beginNote(): boolean {
		if (this.state.inputMode !== "none") return false;
		const row = this.currentRow();
		if (!row || row.kind !== "option" || row.optionIndex === undefined) return false;
		this.state.inputMode = "note";
		this.state.noteTargetOptionIndex = row.optionIndex;
		return true;
	}

	/** Current note text for the option under the cursor (used to prefill the editor). */
	getCurrentNoteDraft(): string {
		const target = this.state.noteTargetOptionIndex;
		if (target === null) return "";
		return this.state.notesByTab[this.state.currentTab]?.[target] ?? "";
	}

	/** Cancel whichever input mode is currently open. */
	cancelInput(): void {
		this.state.inputMode = "none";
		this.state.noteTargetOptionIndex = null;
	}

	/** Submit the text editor's value; behaviour depends on the active input mode. */
	submitInput(text: string): void {
		const trimmed = text.trim();
		const mode = this.state.inputMode;
		if (mode === "text") {
			this.recordText(trimmed || "(no response)");
			this.state.inputMode = "none";
			this.advanceAfterAnswer();
			return;
		}
		if (mode === "note") {
			const target = this.state.noteTargetOptionIndex;
			if (target !== null) {
				const notes = this.state.notesByTab[this.state.currentTab];
				if (notes !== undefined) {
					if (trimmed !== "") notes[target] = trimmed;
					else delete notes[target];
				}
				const q = this.questions[this.state.currentTab];
				if (q?.multiSelect === true && (this.state.multiSel[this.state.currentTab]?.size ?? 0) > 0) {
					this.recordMulti();
				}
				if (q?.multiSelect !== true) {
					const a = this.state.answers[this.state.currentTab];
					if (a && a.kind === "single" && a.index === target) {
						if (trimmed !== "") a.note = trimmed;
						else delete a.note;
					}
				}
			}
			this.state.inputMode = "none";
			this.state.noteTargetOptionIndex = null;
			return;
		}
		if (mode === "chat") {
			// Empty / whitespace-only chat submit: close the dialog as a plain
			// cancel, without attaching an empty `chat` field. Prevents the
			// downstream tool-result from reading "Chat: " with no content
			// (#0002).
			if (trimmed === "") {
				this.state.inputMode = "none";
				this.finish(true);
				return;
			}
			this.recordChat(trimmed);
			this.state.inputMode = "none";
			this.finish(true, trimmed);
		}
	}

	/** Cancel the questionnaire entirely (Esc on a non-input row). */
	cancel(): void {
		if (this.state.inputMode !== "none") {
			// Esc in an input mode only closes the editor; the controller still lives.
			this.cancelInput();
			return;
		}
		this.finish(true);
	}

	// ---- internals --------------------------------------------------------

	private advanceAfterAnswer(): void {
		const s = this.state;
		if (s.currentTab < this.questions.length - 1) {
			s.currentTab++;
			s.rowIndex = 0;
		} else {
			s.currentTab = this.questions.length; // Submit tab
		}
	}

	private recordSingle(optIndex: number, label: string): void {
		const tab = this.state.currentTab;
		const prevNote = this.state.notesByTab[tab]?.[optIndex];
		const a: Answer = { kind: "single", index: optIndex, label };
		if (prevNote !== undefined && prevNote !== "") a.note = prevNote;
		this.state.answers[tab] = a;
	}

	private recordMulti(): void {
		const tab = this.state.currentTab;
		const set = this.state.multiSel[tab];
		const q = this.questions[tab];
		if (!set || !q) return;
		const indices = [...set].sort((a, b) => a - b);
		const labels = indices.map((i) => q.options[i]?.label ?? "");
		const notesForTab = this.state.notesByTab[tab] ?? {};
		const notes: Record<number, string> = {};
		for (const i of indices) {
			const n = notesForTab[i];
			if (n !== undefined && n !== "") notes[i] = n;
		}
		this.state.answers[tab] = { kind: "multi", indices, labels, notes };
	}

	private recordText(text: string): void {
		this.state.answers[this.state.currentTab] = { kind: "text", text };
	}

	private recordChat(text: string): void {
		this.state.answers[this.state.currentTab] = { kind: "chat", text };
	}

	private finish(cancelled: boolean, chat?: string): void {
		const result: Result = { answers: this.state.answers, cancelled };
		if (chat !== undefined) result.chat = chat;
		this.finalResult = result;
		this.finished = true;
	}
}
