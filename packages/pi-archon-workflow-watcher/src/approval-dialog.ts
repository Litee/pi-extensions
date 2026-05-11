/**
 * TUI overlay component for human approval gates.
 *
 * Shown when a watched archon run transitions to "paused" on an
 * `approval`-type gate (plan-gate, commit-gate, etc.). The LLM never sees
 * this interaction — the human reviews and decides directly.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │  ⏸  pi-extension-feature — commit-gate  │
 *   │                                         │
 *   │  <scrollable gate message body>         │
 *   │                                         │
 *   │  ─────────────────────────────────────  │
 *   │  > Approve                              │
 *   │    Reject with feedback                 │
 *   │                                         │
 *   │  ↑↓ select  enter confirm  esc dismiss  │
 *   └─────────────────────────────────────────┘
 *
 * When "Reject with feedback" is chosen a second sub-view appears with an
 * Input field. Enter confirms the feedback; Escape returns to the list.
 */

import { Container, Input, SelectList, Spacer, Text, type SelectItem, matchesKey, Key, wrapTextWithAnsi, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

import type { ApprovalDialogParams, ApprovalResult } from "./runtime.js";

// ---------------------------------------------------------------------------
// Minimal theme interface (subset used here)
// ---------------------------------------------------------------------------

interface DialogTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	bg(color: string, text: string): string;
}

interface Tui {
	requestRender(): void;
}

// ---------------------------------------------------------------------------
// Scrollable text block
// ---------------------------------------------------------------------------

class ScrollableText {
	private lines: string[] = [];
	private offset = 0;
	private visibleLines: number;
	private cachedWidth?: number;
	private cachedWrapped?: string[];

	constructor(
		private readonly rawText: string,
		visibleLines: number,
	) {
		this.visibleLines = visibleLines;
	}

	private wrap(width: number): string[] {
		if (this.cachedWrapped && this.cachedWidth === width) return this.cachedWrapped;
		const inner = Math.max(1, width - 2); // account for padding
		const out: string[] = [];
		for (const raw of this.rawText.split("\n")) {
			if (raw.trim() === "") {
				out.push("");
			} else {
				out.push(...wrapTextWithAnsi(raw, inner));
			}
		}
		this.cachedWrapped = out;
		this.cachedWidth = width;
		this.lines = out;
		return out;
	}

	scrollUp(): void {
		if (this.offset > 0) this.offset--;
	}

	scrollDown(): void {
		const max = Math.max(0, this.lines.length - this.visibleLines);
		if (this.offset < max) this.offset++;
	}

	canScrollDown(): boolean {
		return this.offset < Math.max(0, this.lines.length - this.visibleLines);
	}

	render(width: number): string[] {
		const wrapped = this.wrap(width);
		const slice = wrapped.slice(this.offset, this.offset + this.visibleLines);
		// Pad to visibleLines so the layout is stable
		while (slice.length < this.visibleLines) slice.push("");
		const inner = Math.max(1, width - 2);
		return slice.map((l) => " " + truncateToWidth(l, inner));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedWrapped = undefined;
	}
}

// ---------------------------------------------------------------------------
// Main dialog component
// ---------------------------------------------------------------------------

type DialogPhase = "select" | "reject-input";

export function createApprovalDialog(
	params: ApprovalDialogParams,
	done: (result: ApprovalResult) => void,
	tui: Tui,
	theme: DialogTheme,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	const MSG_VISIBLE_LINES = 12;
	const scrollable = new ScrollableText(params.message, MSG_VISIBLE_LINES);
	const rejectInput = new Input();

	let phase: DialogPhase = "select";
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	const selectItems: SelectItem[] = [
		{ value: "approve", label: "Approve", description: "Accept and proceed to next step" },
		{ value: "reject", label: "Reject with feedback", description: "Send feedback for rework" },
	];

	const selectList = new SelectList(selectItems, 2, {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	});

	selectList.onSelect = (item) => {
		if (item.value === "approve") {
			done({ decision: "approve" });
		} else {
			phase = "reject-input";
			rejectInput.setText("");
			invalidate();
			tui.requestRender();
		}
	};
	selectList.onCancel = () => done(null);

	function buildLines(width: number): string[] {
		const lines: string[] = [];
		const hr = theme.fg("border", "─".repeat(Math.max(0, width - 2)));

		// Header
		const title = `⏸  ${params.workflowName} — ${params.nodeId}`;
		lines.push(" " + theme.fg("accent", theme.bold(truncateToWidth(title, width - 2))));
		lines.push("");

		if (phase === "select") {
			// Scrollable body
			lines.push(...scrollable.render(width));

			// Scroll hint
			if (scrollable.canScrollDown()) {
				lines.push(" " + theme.fg("dim", "↓ more…"));
			} else {
				lines.push("");
			}

			// Separator
			lines.push(" " + hr);
			lines.push("");

			// SelectList
			lines.push(...selectList.render(width));
			lines.push("");

			// Help text
			lines.push(" " + theme.fg("dim", "↑↓ navigate  enter confirm  esc dismiss"));
		} else {
			// Rejection feedback sub-view
			lines.push(" " + theme.fg("warning", "Provide feedback for the rework pass:"));
			lines.push("");
			lines.push(" " + hr);

			// Input field
			const inputLines = rejectInput.render(width - 2);
			lines.push(...inputLines.map((l) => " " + l));

			lines.push(" " + hr);
			lines.push("");
			lines.push(" " + theme.fg("dim", "enter submit  esc back"));
		}

		return lines.map((l) => {
			const vw = visibleWidth(l);
			if (vw > width) return truncateToWidth(l, width);
			return l;
		});
	}

	function invalidate(): void {
		cachedWidth = undefined;
		cachedLines = undefined;
		scrollable.invalidate();
		selectList.invalidate();
		rejectInput.invalidate();
	}

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			cachedLines = buildLines(width);
			cachedWidth = width;
			return cachedLines;
		},

		handleInput(data: string): void {
			if (phase === "select") {
				if (matchesKey(data, Key.up)) {
					scrollable.scrollUp();
					invalidate();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down) && scrollable.canScrollDown()) {
					scrollable.scrollDown();
					invalidate();
					tui.requestRender();
					return;
				}
				selectList.handleInput(data);
				invalidate();
				tui.requestRender();
			} else {
				// reject-input phase
				if (matchesKey(data, Key.escape)) {
					phase = "select";
					invalidate();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const feedback = rejectInput.getText().trim();
					done({ decision: "reject", feedback: feedback || "(no feedback provided)" });
					return;
				}
				rejectInput.handleInput(data);
				invalidate();
				tui.requestRender();
			}
		},

		invalidate,
	};
}
