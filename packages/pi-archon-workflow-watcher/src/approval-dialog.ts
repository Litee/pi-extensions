/**
 * TUI overlay component for human approval gates.
 *
 * Shown when a watched archon run transitions to "paused" on an
 * `approval`-type gate (plan-gate, commit-gate, etc.). The LLM never sees
 * this interaction — the human reviews and decides directly.
 *
 * The dialog is workflow-agnostic: callers supply a list of `DialogSection`
 * entries in `params.sections`. The dialog renders them verbatim.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────────┐
 *   │  ⏸  pi-extension-feature — plan-gate                  │
 *   │                                                       │
 *   │  plan.md [primary]                                    │
 *   │  ───────────────────────────────────────────────────  │
 *   │  <18-line scrollable content; Ctrl-B/F pages>         │
 *   │                                                       │
 *   │  Context                                              │
 *   │  ───────────────────────────────────────────────────  │
 *   │  <up to 6 lines; "… N more" hint if truncated>        │
 *   │                                                       │
 *   │  Gate message                                         │
 *   │  ───────────────────────────────────────────────────  │
 *   │  <up to 4 lines>                                      │
 *   │                                                       │
 *   │  ───────────────────────────────────────────────────  │
 *   │  > Approve                                            │
 *   │    Reject with feedback                               │
 *   │                                                       │
 *   │  Ctrl-B/F page · Ctrl-U/D line · ↑↓ select · enter   │
 *   └───────────────────────────────────────────────────────┘
 *
 * When "Reject with feedback" is chosen a second sub-view appears with an
 * Input field. Enter confirms the feedback; Escape returns to the list.
 *
 * Keybindings (select phase):
 *   Ctrl-B / Ctrl-F    page up / page down on primary section
 *   Ctrl-U / Ctrl-D    line up / line down on primary section
 *   ↑ / ↓              SelectList navigation (always)
 *   Enter              confirm current selection
 *   Esc                dismiss
 *
 * Keybindings (reject-input phase):
 *   Enter              submit feedback (empty → "(no feedback provided)")
 *   Esc                back to select phase
 */

import {
	Input,
	SelectList,
	type SelectItem,
	matchesKey,
	Key,
	wrapTextWithAnsi,
	visibleWidth,
	truncateToWidth,
} from "@earendil-works/pi-tui";

import type { ApprovalDialogParams, ApprovalResult, DialogSection } from "./runtime.js";

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
// Visible-line budgets per section type
// ---------------------------------------------------------------------------

const PRIMARY_VISIBLE_LINES = 18;
const COMPACT_VISIBLE_LINES = 6;
const GATE_MESSAGE_VISIBLE_LINES = 4;

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
		return this.offset < Math.max(0, this.lines.length - this.visibleLines);
	}

	canScrollUp(): boolean {
		return this.offset > 0;
	}

	render(width: number): string[] {
		const wrapped = this.wrap(width);
		const slice = wrapped.slice(this.offset, this.offset + this.visibleLines);
		while (slice.length < this.visibleLines) slice.push("");
		const inner = Math.max(1, width - 2);
		return slice.map((l) => " " + truncateToWidth(l, inner));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedWrapped = undefined;
	}

	/** Total line count at the given width. Used to show "… N more" hints. */
	lineCount(width: number): number {
		return this.wrap(width).length;
	}
}

// ---------------------------------------------------------------------------
// Main dialog component
// ---------------------------------------------------------------------------

type DialogPhase = "select" | "reject-input";

/** Internal per-section rendering state. */
interface RenderedSection {
	section: DialogSection;
	scrollable: ScrollableText;
	visibleLines: number;
	isPrimary: boolean;
}

export function createApprovalDialog(
	params: ApprovalDialogParams,
	done: (result: ApprovalResult) => void,
	tui: Tui,
	theme: DialogTheme,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	// Build the ordered list of sections to render:
	//   1. Caller-supplied sections (in order)
	//   2. Gate message, always appended last as a compact section
	const suppliedSections: DialogSection[] = params.sections ?? [];

	// First section with `primary: true` wins — others are rendered compact.
	const primaryIndex = suppliedSections.findIndex((s) => s.primary === true);

	const rendered: RenderedSection[] = suppliedSections.map((section, i) => {
		const isPrimary = i === primaryIndex;
		const visibleLines = isPrimary ? PRIMARY_VISIBLE_LINES : COMPACT_VISIBLE_LINES;
		return {
			section,
			scrollable: new ScrollableText(section.body, visibleLines),
			visibleLines,
			isPrimary,
		};
	});

	// Always append the gate message as a final compact section.
	rendered.push({
		section: { title: "Gate message", body: params.message },
		scrollable: new ScrollableText(params.message, GATE_MESSAGE_VISIBLE_LINES),
		visibleLines: GATE_MESSAGE_VISIBLE_LINES,
		isPrimary: false,
	});

	const primarySection = primaryIndex >= 0 ? (rendered[primaryIndex] ?? null) : null;
	const primaryScrollable = primarySection?.scrollable ?? null;

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
		lines.push(
			guardWidth(" " + theme.fg("accent", theme.bold(truncateToWidth(title, width - 2))), width),
		);
		lines.push("");

		// Render each section
		for (const { section, scrollable, visibleLines, isPrimary } of rendered) {
			// Title row (with optional [primary] badge)
			const titleParts = [theme.fg("accent", section.title)];
			if (isPrimary) titleParts.push(theme.fg("dim", "[primary]"));
			lines.push(guardWidth(" " + titleParts.join(" "), width));
			lines.push(guardWidth(" " + hr, width));

			// Body
			lines.push(...scrollable.render(width));

			// Footer hint for this section
			if (isPrimary) {
				if (scrollable.canScrollDown()) {
					lines.push(guardWidth(" " + theme.fg("dim", "↓ more — Ctrl-F page · Ctrl-D line"), width));
				} else {
					lines.push("");
				}
			} else {
				const total = scrollable.lineCount(width);
				if (total > visibleLines) {
					const more = total - visibleLines;
					lines.push(
						guardWidth(
							" " + theme.fg("dim", `… ${more} more line${more === 1 ? "" : "s"}`),
							width,
						),
					);
				} else {
					lines.push("");
				}
			}
			lines.push("");
		}

		// Separator + choices
		lines.push(guardWidth(" " + hr, width));
		lines.push("");
		lines.push(...selectList.render(width));
		lines.push("");

		// Help text — contextual on whether a primary scrollable exists
		const hint =
			primaryScrollable !== null
				? " " +
				  theme.fg(
						"dim",
						"Ctrl-B/F page · Ctrl-U/D line · ↑↓ select · enter confirm · esc dismiss",
				  )
				: " " + theme.fg("dim", "↑↓ select · enter confirm · esc dismiss");
		lines.push(guardWidth(hint, width));

		return lines;
	}

	function buildRejectPhaseLines(width: number): string[] {
		const hr = theme.fg("border", "─".repeat(Math.max(0, width - 2)));

		const header = guardWidth(
			" " + theme.fg("accent", theme.bold(`⏸  ${params.workflowName} — ${params.nodeId}`)),
			width,
		);
		const promptLine = guardWidth(
			" " + theme.fg("warning", "Provide feedback for the rework pass:"),
			width,
		);
		const hrLine = guardWidth(" " + hr, width);
		const helpLine = guardWidth(" " + theme.fg("dim", "enter submit  esc back"), width);

		// Input lines are NOT passed through guardWidth — they contain CURSOR_MARKER
		const inputLines = rejectInput.render(width - 2).map((l) => " " + l);

		return [header, "", promptLine, "", hrLine, ...inputLines, hrLine, "", helpLine];
	}

	function invalidate(): void {
		cachedWidth = undefined;
		cachedLines = undefined;
		for (const r of rendered) r.scrollable.invalidate();
		selectList.invalidate();
		rejectInput.invalidate();
	}

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			cachedLines =
				phase === "select" ? buildSelectPhaseLines(width) : buildRejectPhaseLines(width);
			cachedWidth = width;
			return cachedLines;
		},

		handleInput(data: string): void {
			if (phase === "select") {
				// Ctrl-B: page up on primary scrollable
				if (matchesKey(data, Key.ctrl("b"))) {
					if (primaryScrollable !== null) {
						primaryScrollable.scrollPageUp();
						invalidate();
						tui.requestRender();
					}
					return;
				}
				// Ctrl-F: page down on primary scrollable
				if (matchesKey(data, Key.ctrl("f"))) {
					if (primaryScrollable !== null) {
						primaryScrollable.scrollPageDown();
						invalidate();
						tui.requestRender();
					}
					return;
				}
				// Ctrl-U: line up on primary scrollable
				if (matchesKey(data, Key.ctrl("u"))) {
					if (primaryScrollable !== null) {
						primaryScrollable.scrollUp();
						invalidate();
						tui.requestRender();
					}
					return;
				}
				// Ctrl-D: line down on primary scrollable
				if (matchesKey(data, Key.ctrl("d"))) {
					if (primaryScrollable !== null) {
						primaryScrollable.scrollDown();
						invalidate();
						tui.requestRender();
					}
					return;
				}
				// Arrows (↑/↓) always drive SelectList — no content-scroll mixing.
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
