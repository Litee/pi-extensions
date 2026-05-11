/**
 * TUI overlay component for human approval gates.
 *
 * Shown when a watched archon run transitions to "paused" on an
 * `approval`-type gate (plan-gate, commit-gate, etc.). The LLM never sees
 * this interaction — the human reviews and decides directly.
 *
 * Layout (with content file):
 *   ┌─────────────────────────────────────────┐
 *   │  ⏸  pi-extension-feature — plan-gate    │
 *   │  plan.md                                │
 *   │  <scrollable plan content, 20 lines>    │
 *   │  ─────────────────────────────────────  │
 *   │  Gate message (4 lines collapsed)       │
 *   │  ─────────────────────────────────────  │
 *   │  > Approve                              │
 *   │    Reject with feedback                 │
 *   │  Ctrl-B/F page  ↑↓ line  enter confirm  │
 *   └─────────────────────────────────────────┘
 *
 * Layout (without content file — gate message only):
 *   ┌─────────────────────────────────────────┐
 *   │  ⏸  pi-extension-feature — commit-gate  │
 *   │  <scrollable gate message, 12 lines>    │
 *   │  ─────────────────────────────────────  │
 *   │  > Approve                              │
 *   │    Reject with feedback                 │
 *   │  Ctrl-B/F page  ↑↓ line  enter confirm  │
 *   └─────────────────────────────────────────┘
 *
 * When "Reject with feedback" is chosen a second sub-view appears with an
 * Input field. Enter confirms the feedback; Escape returns to the list.
 */

import { readFileSync } from "node:fs";
import { Input, SelectList, type SelectItem, matchesKey, Key, wrapTextWithAnsi, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

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
// Width guard — applied to manually-constructed lines only (NOT Input output)
// ---------------------------------------------------------------------------

function guardWidth(line: string, maxWidth: number): string {
	return visibleWidth(line) > maxWidth ? truncateToWidth(line, maxWidth) : line;
}

// ---------------------------------------------------------------------------
// Scrollable text block
// ---------------------------------------------------------------------------

class ScrollableText {
	private lines: string[] = [];
	private offset = 0;
	private visibleLines: number;
	private cachedWidth: number | undefined;
	private cachedWrapped: string[] | undefined;

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

	scrollPageUp(): void {
		this.offset = Math.max(0, this.offset - this.visibleLines);
	}

	scrollPageDown(): void {
		const max = Math.max(0, this.lines.length - this.visibleLines);
		this.offset = Math.min(max, this.offset + this.visibleLines);
	}

	canScrollDown(): boolean {
		// Re-use cached lines if available; they are populated during render.
		return this.offset < Math.max(0, this.lines.length - this.visibleLines);
	}

	canScrollUp(): boolean {
		return this.offset > 0;
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

	/** Total line count (after wrapping at given width). Used by tests. */
	lineCount(width: number): number {
		return this.wrap(width).length;
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
	// Load content file if provided.
	let contentText: string | undefined;
	if (params.contentFile) {
		try {
			contentText = readFileSync(params.contentFile, "utf8");
		} catch {
			contentText = undefined;
		}
	}

	const CONTENT_VISIBLE_LINES = 20;
	const MSG_VISIBLE_LINES = contentText !== undefined ? 4 : 12;

	const contentScrollable = contentText !== undefined
		? new ScrollableText(contentText, CONTENT_VISIBLE_LINES)
		: null;
	const msgScrollable = new ScrollableText(params.message, MSG_VISIBLE_LINES);
	const rejectInput = new Input();

	// Which scrollable is "active" (receives Ctrl-B/F / arrow scroll keys).
	// When content is shown, content scrollable is primary; message is secondary.
	const primaryScrollable = contentScrollable ?? msgScrollable;

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
			rejectInput.setValue("");
			invalidate();
			tui.requestRender();
		}
	};
	selectList.onCancel = () => done(null);

	function buildSelectPhaseLines(width: number): string[] {
		const lines: string[] = [];
		const hr = theme.fg("border", "─".repeat(Math.max(0, width - 2)));

		// Header
		const title = `⏸  ${params.workflowName} — ${params.nodeId}`;
		lines.push(guardWidth(" " + theme.fg("accent", theme.bold(truncateToWidth(title, width - 2))), width));
		lines.push("");

		if (contentScrollable !== null) {
			// Content section (primary — plan.md / commit-message.txt)
			const label = params.contentLabel ?? "content";
			lines.push(guardWidth(" " + theme.fg("accent", label), width));
			lines.push(guardWidth(" " + hr, width));
			lines.push(...contentScrollable.render(width));
			if (contentScrollable.canScrollDown()) {
				lines.push(guardWidth(" " + theme.fg("dim", "↓ more content…"), width));
			} else {
				lines.push("");
			}
			lines.push("");

			// Gate message (collapsed — secondary context)
			lines.push(guardWidth(" " + theme.fg("muted", "Gate message:"), width));
			lines.push(guardWidth(" " + hr, width));
			lines.push(...msgScrollable.render(width));
			lines.push("");
		} else {
			// Gate message only (full height)
			lines.push(...msgScrollable.render(width));
			if (msgScrollable.canScrollDown()) {
				lines.push(guardWidth(" " + theme.fg("dim", "↓ more…"), width));
			} else {
				lines.push("");
			}
		}

		// Separator + choices
		lines.push(guardWidth(" " + hr, width));
		lines.push("");
		lines.push(...selectList.render(width));
		lines.push("");

		// Help text
		const hint = contentScrollable !== null
			? " " + theme.fg("dim", "Ctrl-B/F page  ↑↓ line  enter confirm  esc dismiss")
			: " " + theme.fg("dim", "Ctrl-B/F page  ↑↓ line  enter confirm  esc dismiss");
		lines.push(guardWidth(hint, width));

		return lines;
	}

	function buildRejectPhaseLines(width: number): string[] {
		const hr = theme.fg("border", "─".repeat(Math.max(0, width - 2)));

		const header = guardWidth(" " + theme.fg("accent", theme.bold(`⏸  ${params.workflowName} — ${params.nodeId}`)), width);
		const promptLine = guardWidth(" " + theme.fg("warning", "Provide feedback for the rework pass:"), width);
		const hrLine = guardWidth(" " + hr, width);
		const helpLine = guardWidth(" " + theme.fg("dim", "enter submit  esc back"), width);

		// Input lines are NOT passed through guardWidth — they contain CURSOR_MARKER
		const inputLines = rejectInput.render(width - 2).map((l) => " " + l);

		return [
			header,
			"",
			promptLine,
			"",
			hrLine,
			...inputLines,
			hrLine,
			"",
			helpLine,
		];
	}

	function invalidate(): void {
		cachedWidth = undefined;
		cachedLines = undefined;
		contentScrollable?.invalidate();
		msgScrollable.invalidate();
		selectList.invalidate();
		rejectInput.invalidate();
	}

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			cachedLines = phase === "select"
				? buildSelectPhaseLines(width)
				: buildRejectPhaseLines(width);
			cachedWidth = width;
			return cachedLines;
		},

		handleInput(data: string): void {
			if (phase === "select") {
				// Ctrl-B: page up on primary scrollable
				if (matchesKey(data, Key.ctrl("b"))) {
					primaryScrollable.scrollPageUp();
					invalidate();
					tui.requestRender();
					return;
				}
				// Ctrl-F: page down on primary scrollable
				if (matchesKey(data, Key.ctrl("f"))) {
					primaryScrollable.scrollPageDown();
					invalidate();
					tui.requestRender();
					return;
				}
				// Up arrow: line-scroll primary scrollable; swallow even at top
				if (matchesKey(data, Key.up)) {
					if (primaryScrollable.canScrollUp()) {
						primaryScrollable.scrollUp();
						invalidate();
						tui.requestRender();
					}
					return; // never pass up-arrow to SelectList
				}
				// Down arrow: line-scroll primary scrollable when it has more content;
				// otherwise fall through to let SelectList move the selection.
				if (matchesKey(data, Key.down) && primaryScrollable.canScrollDown()) {
					primaryScrollable.scrollDown();
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
					const feedback = rejectInput.getValue().trim();
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
