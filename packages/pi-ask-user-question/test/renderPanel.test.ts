import { describe, expect, it } from "vitest";
import {
	truncateToWidth as realTruncateToWidth,
	visibleWidth as realVisibleWidth,
	wrapTextWithAnsi as realWrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { Answer } from "../src/format.js";
import { DialogController, type DialogState } from "../src/controller.js";
import {
	composeSideBySide,
	composePanel,
	fitPreviewLines,
	padRight,
	renderHelp,
	renderInputPanel,
	renderOptionList,
	renderSubmitTab,
	renderTabBar,
	SIDE_BY_SIDE_LEFT_MIN,
	SIDE_BY_SIDE_RIGHT_MIN,
	wrapToWidth,
	wrapWithPrefix,
	type ComposePanelOpts,
	type LayoutProbe,
	type PanelTheme,
} from "../src/renderPanel.js";
import { buildRows } from "../src/rows.js";
import type { TQuestion } from "../src/schema.js";

/**
 * Deterministic theme that tags every styling call inline so snapshots catch
 * colour-token regressions, not just text.
 */
const theme: PanelTheme = {
	fg: (color, text) => `<fg:${color}>${text}</fg>`,
	bg: (color, text) => `<bg:${color}>${text}</bg>`,
	bold: (text) => `<b>${text}</b>`,
};

/**
 * No-op layout probe: we inject generous widths in tests so truncation never
 * fires and the assertions can match full strings.
 */
const layout: LayoutProbe = {
	truncateToWidth: (s, _w) => s,
	visibleWidth: (s) => {
		// Strip our fake markup before measuring so padRight assertions behave.
		return s.replace(/<\/?(fg|bg|b)(:[^>]*)?>/g, "").length;
	},
	/** Always one line — existing tests use generous widths so wrapping never fires. */
	wrapTextWithAnsi: (s, _w) => [s],
};

/**
 * Real layout probe: uses actual pi-tui primitives.
 * Paired with `plainTheme` (no ANSI codes) so visibleWidth == string.length.
 */
const realLayout: LayoutProbe = {
	truncateToWidth: realTruncateToWidth,
	visibleWidth: realVisibleWidth,
	wrapTextWithAnsi: realWrapTextWithAnsi,
};

/**
 * Transparent theme that returns text unchanged — no ANSI codes, so
 * realVisibleWidth measures the raw string length directly.
 */
const plainTheme: PanelTheme = {
	fg: (_, text) => text,
	bg: (_, text) => text,
	bold: (text) => text,
};

function singleQ(question: string, labels: string[]): TQuestion {
	return { question, options: labels.map((label) => ({ label })) };
}

function multiQ(question: string, labels: string[]): TQuestion {
	return { question, multiSelect: true, options: labels.map((label) => ({ label })) };
}

function stateFor(questions: TQuestion[], patch: Partial<DialogState> = {}): DialogState {
	const s = new DialogController(questions).getState();
	return { ...s, ...patch };
}

describe("padRight", () => {
	it("pads a short string with spaces up to the requested width", () => {
		expect(padRight("ab", 5, layout)).toBe("ab   ");
	});

	it("returns the string unchanged when its visible width equals the target", () => {
		expect(padRight("abcde", 5, layout)).toBe("abcde");
	});

	it("truncates when the string is wider than the target", () => {
		const truncating: LayoutProbe = {
			truncateToWidth: (s, w) => s.slice(0, w),
			visibleWidth: (s) => s.length,
			wrapTextWithAnsi: (s, _w) => [s],
		};
		expect(padRight("abcdef", 3, truncating)).toBe("abc");
	});

	it("measures visible width, not raw length (styling markers ignored)", () => {
		expect(padRight("<fg:x>A</fg>", 5, layout)).toBe("<fg:x>A</fg>    ");
	});
});

describe("renderTabBar", () => {
	it("returns [] for a single-question dialog", () => {
		const questions = [singleQ("Q1", ["A"])];
		expect(
			renderTabBar({
				state: stateFor(questions),
				questions,
				isSubmitTab: false,
				allAnswered: false,
				width: 80,
				theme,
				layout,
			}),
		).toEqual([]);
	});

	it.each([2, 3, 4])("renders one tab per question + Submit for %i questions", (n) => {
		const questions = Array.from({ length: n }, (_, i) => singleQ(`Q${i + 1}`, ["A"]));
		const lines = renderTabBar({
			state: stateFor(questions),
			questions,
			isSubmitTab: false,
			allAnswered: false,
			width: 200,
			theme,
			layout,
		});
		expect(lines).toHaveLength(2); // content line + blank spacer
		for (let i = 1; i <= n; i++) expect(lines[0]).toContain(`Q${i}`);
		expect(lines[0]).toContain("Submit");
	});

	it("highlights the active tab with selectedBg and shows ■ for answered tabs", () => {
		const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"])];
		const state = stateFor(questions, {
			currentTab: 1,
			answers: [{ kind: "single", index: 0, label: "A" }, null],
		});
		const [line] = renderTabBar({
			state,
			questions,
			isSubmitTab: false,
			allAnswered: false,
			width: 200,
			theme,
			layout,
		});
		expect(line).toContain("■ Q1"); // answered
		expect(line).toContain("□ Q2"); // current, unanswered
		expect(line).toContain("<bg:selectedBg>"); // current highlighted
	});

	it("colours the Submit tab 'success' when all answered vs 'dim' otherwise", () => {
		const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"])];
		const base = {
			state: stateFor(questions),
			questions,
			isSubmitTab: false,
			width: 200,
			theme,
			layout,
		};
		expect(renderTabBar({ ...base, allAnswered: false })[0]).toContain(
			"<fg:dim> ✓ Submit </fg>",
		);
		expect(renderTabBar({ ...base, allAnswered: true })[0]).toContain(
			"<fg:success> ✓ Submit </fg>",
		);
	});
});

describe("renderOptionList", () => {
	const questions = [singleQ("Q1", ["A", "B"])];
	const rows = buildRows(questions[0]!);

	it("marks only the cursor row with '> ' and colours its label 'accent'", () => {
		const state = stateFor(questions, { rowIndex: 1 });
		const lines = renderOptionList({ rows, state, multi: false, width: 200, theme, layout });
		expect(lines[0]).toMatch(/^ {2}/); // non-cursor prefix
		expect(lines[1]).toContain("<fg:accent>> </fg>");
		expect(lines[1]).toContain("<fg:accent>2. B</fg>");
	});

	it("renders multi-select checkboxes with success/muted colours", () => {
		const mq = [multiQ("Q1", ["A", "B"])];
		const mrows = buildRows(mq[0]!);
		const state = stateFor(mq);
		state.multiSel[0]!.add(0);
		const lines = renderOptionList({ rows: mrows, state, multi: true, width: 200, theme, layout });
		expect(lines[0]).toContain("<fg:success>[x] </fg>");
		expect(lines[1]).toContain("<fg:muted>[ ] </fg>");
	});

	it("appends a '✎' tag and a 'note: …' sub-line when a note is attached", () => {
		const state = stateFor(questions);
		state.notesByTab[0]![0] = "hello";
		const lines = renderOptionList({ rows, state, multi: false, width: 200, theme, layout });
		expect(lines[0]).toContain("✎");
		expect(lines.join("\n")).toContain("note: hello");
	});

	it("colours 'chat' sentinel rows as warning and 'text'/'next' as accent", () => {
		const mq = [multiQ("Q1", ["A"])]; // emits a "next" row + "chat" row
		const mrows = buildRows(mq[0]!);
		const lines = renderOptionList({
			rows: mrows,
			state: stateFor(mq),
			multi: true,
			width: 200,
			theme,
			layout,
		});
		// rows: option A, next, chat — find non-option rows:
		const nextLine = lines.find((l) => l.includes("Next"))!;
		const chatLine = lines.find((l) => l.includes("Chat about this"))!;
		expect(nextLine).toContain("<fg:accent>Next</fg>");
		expect(chatLine).toContain("<fg:warning>Chat about this</fg>");
	});

	it("emits a 'description' sub-line when the row has one", () => {
		const q: TQuestion = {
			question: "Q1",
			options: [{ label: "A", description: "choose A" }],
		};
		const lines = renderOptionList({
			rows: buildRows(q),
			state: stateFor([q]),
			multi: false,
			width: 200,
			theme,
			layout,
		});
		expect(lines.join("\n")).toContain("choose A");
	});
});

describe("renderSubmitTab", () => {
	function withAnswers(answers: (Answer | null)[]): {
		state: DialogState;
		questions: TQuestion[];
	} {
		const questions = answers.map((_, i) => singleQ(`Q${i + 1}`, ["A", "B"]));
		const s = stateFor(questions, {
			currentTab: questions.length,
			answers,
		});
		return { state: s, questions };
	}

	it("lists each question with the '(unanswered)' marker when answer is null", () => {
		const { state, questions } = withAnswers([null, null]);
		const out = renderSubmitTab({
			state,
			questions,
			allAnswered: false,
			width: 200,
			theme,
			layout,
		}).join("\n");
		expect(out).toContain("Q1. Q1");
		expect(out).toContain("Q2. Q2");
		expect(out.match(/\(unanswered\)/g)?.length).toBe(2);
	});

	it("formats single / multi / text / chat answers", () => {
		const { state, questions } = withAnswers([
			{ kind: "single", index: 0, label: "A", note: "a-note" },
			{
				kind: "multi",
				indices: [0, 1],
				labels: ["A", "B"],
				notes: { 1: "b-note" },
			},
			{ kind: "text", text: "free form" },
			{ kind: "chat", text: "let's talk" },
		]);
		const out = renderSubmitTab({
			state,
			questions,
			allAnswered: true,
			width: 400,
			theme,
			layout,
		}).join("\n");
		expect(out).toContain("1. A");
		expect(out).toContain("(note: a-note)");
		expect(out).toContain("[x] 1. A");
		expect(out).toContain("[x] 2. B");
		expect(out).toContain("(note: b-note)");
		expect(out).toContain(`"free form"`);
		expect(out).toContain("chat: let's talk");
	});

	it("ends with 'Press Enter to submit' when fully answered", () => {
		const { state, questions } = withAnswers([
			{ kind: "single", index: 0, label: "A" },
		]);
		const lines = renderSubmitTab({
			state,
			questions,
			allAnswered: true,
			width: 200,
			theme,
			layout,
		});
		expect(lines[lines.length - 1]).toContain("Press Enter to submit");
		expect(lines[lines.length - 1]).toContain("<fg:success>");
	});

	it("ends with 'Unanswered: Q1, Q3' summary listing the missing tabs", () => {
		const { state, questions } = withAnswers([
			null,
			{ kind: "single", index: 0, label: "A" },
			null,
		]);
		const lines = renderSubmitTab({
			state,
			questions,
			allAnswered: false,
			width: 200,
			theme,
			layout,
		});
		const last = lines[lines.length - 1]!;
		expect(last).toContain("Unanswered: Q1, Q3");
		expect(last).toContain("<fg:warning>");
	});
});

describe("renderHelp", () => {
	const questions = [singleQ("Q1", ["A"])];

	it("returns [] while an input mode is open", () => {
		const state = stateFor(questions, { inputMode: "text" });
		expect(
			renderHelp({
				state,
				activeQuestion: questions[0],
				isSubmitTab: false,
				hasMultipleQuestions: false,
				width: 200,
				theme,
				layout,
			}),
		).toEqual([]);
	});

	it("submit-tab help shows Enter submit / Esc cancel; omits Tab hint when single question", () => {
		const [line] = renderHelp({
			state: stateFor(questions),
			activeQuestion: undefined,
			isSubmitTab: true,
			hasMultipleQuestions: false,
			width: 200,
			theme,
			layout,
		});
		expect(line).toContain("Enter submit");
		expect(line).toContain("Esc cancel");
		expect(line).not.toContain("Tab");
	});

	it("submit-tab help includes Tab hint when there are multiple questions", () => {
		const [line] = renderHelp({
			state: stateFor(questions),
			activeQuestion: undefined,
			isSubmitTab: true,
			hasMultipleQuestions: true,
			width: 200,
			theme,
			layout,
		});
		expect(line).toContain("Tab/←→ switch tab");
	});

	it("multi-select help: Space/Enter toggle + 'Next row to advance' hint", () => {
		const mq = [multiQ("Q1", ["A"])];
		const [line] = renderHelp({
			state: stateFor(mq),
			activeQuestion: mq[0],
			isSubmitTab: false,
			hasMultipleQuestions: false,
			width: 200,
			theme,
			layout,
		});
		expect(line).toContain("↑↓ move");
		expect(line).toContain("Space/Enter toggle");
		expect(line).toContain("n note");
		expect(line).toContain("Next row to advance");
	});

	it("single-select help: Enter select, no Space/Next row hints", () => {
		const [line] = renderHelp({
			state: stateFor(questions),
			activeQuestion: questions[0],
			isSubmitTab: false,
			hasMultipleQuestions: false,
			width: 200,
			theme,
			layout,
		});
		expect(line).toContain("Enter select");
		expect(line).not.toContain("Space");
		expect(line).not.toContain("Next row");
	});

	it.each([
		[false, ["↑↓ move", "Enter select", "n note", "Esc cancel"]],
		[true, ["Tab/←→ tabs", "↑↓ move", "Enter select", "n note", "Esc cancel"]],
	])("regular-tab help composition with hasMultipleQuestions=%s", (multi, expected) => {
		const [line] = renderHelp({
			state: stateFor(questions),
			activeQuestion: questions[0],
			isSubmitTab: false,
			hasMultipleQuestions: multi,
			width: 400,
			theme,
			layout,
		});
		for (const part of expected) expect(line).toContain(part);
	});
});

// ---------------------------------------------------------------------------
// New behaviour tests — these FAIL on the pre-fix code
// ---------------------------------------------------------------------------

describe("wrapToWidth", () => {
	it("returns a single line when text fits within width", () => {
		const lines = wrapToWidth("hello", 20, realLayout);
		expect(lines).toEqual(["hello"]);
	});

	it("wraps to multiple lines when text exceeds width", () => {
		const lines = wrapToWidth("hello world foo bar baz qux", 10, realLayout);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(realVisibleWidth(line)).toBeLessThanOrEqual(10);
		}
	});

	it("clamps width to 1 when given width <= 0", () => {
		const lines = wrapToWidth("hello", 0, realLayout);
		for (const line of lines) {
			expect(realVisibleWidth(line)).toBeLessThanOrEqual(1);
		}
	});
});

describe("wrapWithPrefix", () => {
	it("prepends prefix only to the first wrapped line", () => {
		const prefix = "  > ";
		const lines = wrapWithPrefix(prefix, "hello world foo bar baz qux extra text", 12, realLayout);
		expect(lines[0]!.startsWith(prefix)).toBe(true);
		if (lines.length > 1) {
			// continuation lines are indented, not re-prefixed
			expect(lines[1]!.startsWith("  > ")).toBe(false);
		}
	});

	it("continuation lines are indented by prefix visible width (hanging indent)", () => {
		const prefix = "  [x] ";
		const text = "a very long label that will definitely wrap at a narrow width here";
		const lines = wrapWithPrefix(prefix, text, 15, realLayout);
		expect(lines.length).toBeGreaterThan(1);
		const expectedIndent = " ".repeat(realVisibleWidth(prefix));
		for (let i = 1; i < lines.length; i++) {
			expect(lines[i]!.startsWith(expectedIndent)).toBe(true);
		}
		for (const line of lines) {
			expect(realVisibleWidth(line)).toBeLessThanOrEqual(15);
		}
	});

	it("falls back to wrapping prefix+text together when prefix alone fills the width", () => {
		const prefix = "a very long prefix that exceeds ";
		const lines = wrapWithPrefix(prefix, "some text", 5, realLayout);
		for (const line of lines) {
			expect(realVisibleWidth(line)).toBeLessThanOrEqual(5);
		}
	});
});

describe("composeSideBySide", () => {
	const THRESHOLD = SIDE_BY_SIDE_LEFT_MIN + 3 + SIDE_BY_SIDE_RIGHT_MIN;

	function makeOpts(width: number) {
		return {
			getOptionLines: (w: number) => [
				realTruncateToWidth("1. Option Alpha", w),
				realTruncateToWidth("2. Option Beta", w),
				realTruncateToWidth("3. Option Gamma", w),
			],
			getPreviewLines: (w: number, h?: number) =>
				h !== undefined
					? Array.from({ length: h }, () => realTruncateToWidth("Preview content here", w))
					: [realTruncateToWidth("Preview content here", w), realTruncateToWidth("Preview line 2", w)],
			width,
			theme: plainTheme,
			layout: realLayout,
		};
	}

	it.each([1, 10, 20, 40, 44, 45, 80])(
		"no composed line exceeds width=%i (overflow guard)",
		(width) => {
			const lines = composeSideBySide(makeOpts(width));
			for (const line of lines) {
				expect(realVisibleWidth(line)).toBeLessThanOrEqual(width);
			}
		},
	);

	it(`below threshold (width < ${THRESHOLD}) → stacked layout with no │ separator`, () => {
		const lines = composeSideBySide(makeOpts(THRESHOLD - 1));
		for (const line of lines) {
			expect(line).not.toContain("│");
		}
	});

	it(`at threshold (width === ${THRESHOLD}) → side-by-side layout with │ separator`, () => {
		const lines = composeSideBySide(makeOpts(THRESHOLD));
		expect(lines.some((l) => l.includes("│"))).toBe(true);
	});

	it("stacked layout: option lines come first at full width, then blank separator, then preview", () => {
		const width = THRESHOLD - 1;
		const lines = composeSideBySide(makeOpts(width));
		expect(lines[0]).toBe(realTruncateToWidth("1. Option Alpha", width));
		expect(lines[1]).toBe(realTruncateToWidth("2. Option Beta", width));
		expect(lines[2]).toBe(realTruncateToWidth("3. Option Gamma", width));
		expect(lines[3]).toBe(""); // blank separator between options and preview
	});

	it("side-by-side: getOptionLines called with leftWidth, getPreviewLines with rightWidth; leftWidth + 3 + rightWidth === width", () => {
		const width = THRESHOLD + 10;
		const expectedLeftWidth = Math.floor((width - 3) / 2);
		const expectedRightWidth = width - expectedLeftWidth - 3;
		expect(expectedLeftWidth + 3 + expectedRightWidth).toBe(width);

		let capturedOptionWidth = -1;
		let capturedPreviewWidth = -1;
		composeSideBySide({
			getOptionLines: (w) => {
				capturedOptionWidth = w;
				return ["option"];
			},
			getPreviewLines: (w, _h) => {
				capturedPreviewWidth = w;
				return ["preview"];
			},
			width,
			theme: plainTheme,
			layout: realLayout,
		});
		expect(capturedOptionWidth).toBe(expectedLeftWidth);
		expect(capturedPreviewWidth).toBe(expectedRightWidth);
	});
});

describe("renderOptionList — wrapping at narrow widths", () => {
	it("preserves long label content across wrapped lines instead of clipping", () => {
		const longLabel = "A long option label that should wrap at narrow widths and not be clipped";
		const q: TQuestion = { question: "Q", options: [{ label: longLabel }] };
		const rows = buildRows(q);
		const lines = renderOptionList({
			rows,
			state: stateFor([q]),
			multi: false,
			width: 20,
			theme: plainTheme,
			layout: realLayout,
		});
		// With wrapping, the tail of the label survives — "clipped" appears on a
		// continuation line; with truncation it would be cut off with "...".
		expect(lines.join("")).toContain("clipped");
		// No individual line may exceed width
		for (const line of lines) {
			expect(realVisibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});

	it("description sub-line wraps and stays within width", () => {
		const q: TQuestion = {
			question: "Q",
			options: [
				{ label: "A", description: "A verbose description that is also quite long and should wrap" },
			],
		};
		const rows = buildRows(q);
		const lines = renderOptionList({
			rows,
			state: stateFor([q]),
			multi: false,
			width: 20,
			theme: plainTheme,
			layout: realLayout,
		});
		const fullText = lines.join("");
		expect(fullText).toContain("should wrap");
		for (const line of lines) {
			expect(realVisibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});
});

describe("renderTabBar — width safety", () => {
	it.each([1, 5, 10, 20, 40, 80])(
		"no output line exceeds width=%i for a 3-question dialog",
		(width) => {
			const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"]), singleQ("Q3", ["C"])];
			const lines = renderTabBar({
				state: stateFor(questions),
				questions,
				isSubmitTab: false,
				allAnswered: false,
				width,
				theme: plainTheme,
				layout: realLayout,
			});
			for (const line of lines) {
				expect(realVisibleWidth(line)).toBeLessThanOrEqual(width);
			}
		},
	);
});

describe("renderSubmitTab — width safety", () => {
	it.each([1, 5, 10, 20, 40, 80])(
		"no output line exceeds width=%i",
		(width) => {
			const questions = [
				singleQ("Q1 with moderately long question text", ["Answer A", "Answer B"]),
			];
			const state = stateFor(questions, {
				answers: [{ kind: "single", index: 0, label: "Answer A" }],
			});
			const lines = renderSubmitTab({
				state,
				questions,
				allAnswered: true,
				width,
				theme: plainTheme,
				layout: realLayout,
			});
			for (const line of lines) {
				expect(realVisibleWidth(line)).toBeLessThanOrEqual(width);
			}
		},
	);
});

describe("renderHelp — width safety", () => {
	it.each([1, 5, 10, 20, 40, 80])(
		"no output line exceeds width=%i",
		(width) => {
			const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"])];
			const lines = renderHelp({
				state: stateFor(questions),
				activeQuestion: questions[0],
				isSubmitTab: false,
				hasMultipleQuestions: true,
				width,
				theme: plainTheme,
				layout: realLayout,
			});
			for (const line of lines) {
				expect(realVisibleWidth(line)).toBeLessThanOrEqual(width);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// fitPreviewLines
// ---------------------------------------------------------------------------

describe("fitPreviewLines", () => {
	it("caps lines to maxHeight when mdLines > maxHeight", () => {
		const input = ["a", "b", "c", "d", "e"];
		const out = fitPreviewLines(input, 80, 3, layout);
		expect(out).toHaveLength(3);
		expect(out[0]).toBe("a");
		expect(out[2]).toBe("c");
	});

	it("pads with empty strings when mdLines < maxHeight", () => {
		const input = ["a", "b"];
		const out = fitPreviewLines(input, 80, 5, layout);
		expect(out).toHaveLength(5);
		expect(out[2]).toBe("");
		expect(out[4]).toBe("");
	});

	it("returns exact maxHeight lines when mdLines.length === maxHeight", () => {
		const input = ["a", "b", "c"];
		const out = fitPreviewLines(input, 80, 3, layout);
		expect(out).toHaveLength(3);
	});

	it("truncates every line to width", () => {
		const called: Array<[string, number]> = [];
		const probe: LayoutProbe = {
			truncateToWidth: (s, w) => { called.push([s, w]); return s.slice(0, w); },
			visibleWidth: (s) => s.length,
			wrapTextWithAnsi: (s, _w) => [s],
		};
		fitPreviewLines(["hello", "world"], 10, 2, probe);
		expect(called).toHaveLength(2);
		expect(called.every(([, w]) => w === 10)).toBe(true);
	});

	it("with maxHeight undefined returns natural height (no cap, no pad)", () => {
		const input = ["a", "b", "c", "d", "e"];
		const out = fitPreviewLines(input, 80, undefined, layout);
		expect(out).toHaveLength(5);
	});

	it("with maxHeight undefined still truncates each line to width", () => {
		const narrow: LayoutProbe = {
			truncateToWidth: (s, w) => s.slice(0, w),
			visibleWidth: (s) => s.length,
			wrapTextWithAnsi: (s, _w) => [s],
		};
		const out = fitPreviewLines(["hello world", "foo bar baz"], 5, undefined, narrow);
		expect(out).toEqual(["hello", "foo b"]);
	});

	it("width safety: every line ≤ width when using realLayout", () => {
		const input = ["a very long preview line that exceeds the target width by quite a margin"];
		for (const w of [5, 10, 20, 40]) {
			const out = fitPreviewLines(input, w, undefined, realLayout);
			for (const l of out) {
				expect(realVisibleWidth(l)).toBeLessThanOrEqual(w);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// renderInputPanel
// ---------------------------------------------------------------------------

describe("renderInputPanel", () => {
	it("produces the exact framing: blank, label:, editor lines prefixed, blank, hint", () => {
		const editorLines = ["line one", "line two"];
		const out = renderInputPanel("My label", editorLines, 80, theme, layout);
		expect(out[0]).toBe("");
		expect(out[1]).toContain("My label:");
		expect(out[1]).toContain("<fg:muted>");
		expect(out[2]).toBe(" line one");
		expect(out[3]).toBe(" line two");
		expect(out[4]).toBe("");
		expect(out[5]).toContain("Enter to submit");
		expect(out[5]).toContain("<fg:dim>");
		expect(out).toHaveLength(6);
	});

	it("handles zero editor lines gracefully", () => {
		const out = renderInputPanel("Label", [], 80, theme, layout);
		// blank, label, blank, hint = 4 lines
		expect(out).toHaveLength(4);
		expect(out[0]).toBe("");
		expect(out[1]).toContain("Label:");
		expect(out[2]).toBe("");
		expect(out[3]).toContain("Enter to submit");
	});

	it("truncates every output line to width via layout", () => {
		const called: Array<[string, number]> = [];
		const probe: LayoutProbe = {
			truncateToWidth: (s, w) => { called.push([s, w]); return s.slice(0, w); },
			visibleWidth: (s) => s.length,
			wrapTextWithAnsi: (s, _w) => [s],
		};
		renderInputPanel("X", ["abc"], 10, plainTheme, probe);
		// label line, editor line, hint line should all be passed through truncateToWidth
		expect(called.length).toBeGreaterThanOrEqual(3);
		expect(called.every(([, w]) => w === 10)).toBe(true);
	});

	it("every output line ≤ width for widths {1, 20, 40, 80} using realLayout", () => {
		for (const w of [1, 20, 40, 80]) {
			const editorLines = [realTruncateToWidth("a somewhat long editor line", w)];
			const out = renderInputPanel("Your answer", editorLines, w, plainTheme, realLayout);
			for (const l of out) {
				expect(realVisibleWidth(l)).toBeLessThanOrEqual(w);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// composeSideBySide — stacked natural-height assertion (deliberate improvement)
// ---------------------------------------------------------------------------

describe("composeSideBySide — stacked natural height", () => {
	const THRESHOLD = SIDE_BY_SIDE_LEFT_MIN + 3 + SIDE_BY_SIDE_RIGHT_MIN;

	it("stacked layout: preview uses natural height (NOT clipped to option count)", () => {
		const width = THRESHOLD - 1;
		// 2 option lines but preview has 5 lines in natural mode
		const manyPreviewLines = ["p1", "p2", "p3", "p4", "p5"];
		const lines = composeSideBySide({
			getOptionLines: (_w) => ["opt1", "opt2"],
			getPreviewLines: (_w, h) =>
				h !== undefined ? manyPreviewLines.slice(0, h) : manyPreviewLines,
			width,
			theme: plainTheme,
			layout: realLayout,
		});
		// 2 options + "" + 5 preview = 8 total
		expect(lines).toHaveLength(8);
		expect(lines[2]).toBe(""); // blank between options and preview
		expect(lines[3]).toBe("p1");
		expect(lines[7]).toBe("p5");
		expect(lines[8]).toBeUndefined();
	});

	it("stacked layout: getPreviewLines is called WITHOUT a height argument", () => {
		const width = THRESHOLD - 1;
		let capturedHeight: number | undefined = 999;
		composeSideBySide({
			getOptionLines: (_w) => ["opt1"],
			getPreviewLines: (_w, h) => { capturedHeight = h; return ["preview"]; },
			width,
			theme: plainTheme,
			layout: realLayout,
		});
		expect(capturedHeight).toBeUndefined();
	});

	it("side-by-side layout: getPreviewLines is called WITH the option-list height", () => {
		const width = THRESHOLD;
		let capturedHeight: number | undefined = undefined;
		composeSideBySide({
			getOptionLines: (_w) => ["opt1", "opt2", "opt3"],
			getPreviewLines: (_w, h) => { capturedHeight = h; return h !== undefined ? Array.from({ length: h }, () => "p") : ["p"]; },
			width,
			theme: plainTheme,
			layout: realLayout,
		});
		expect(capturedHeight).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// composePanel
// ---------------------------------------------------------------------------

describe("composePanel", () => {
	function makeBaseOpts(
		questions: TQuestion[],
		patch: Partial<ComposePanelOpts> = {},
	): ComposePanelOpts {
		const ctrl = new DialogController(questions);
		const s = ctrl.getState();
		return {
			state: s,
			questions,
			isSubmitTab: false,
			allAnswered: false,
			rows: ctrl.currentRows(),
			width: 80,
			theme,
			layout,
			getEditorLines: (_w) => ["editor line"],
			getPreviewLines: (_w, _h) => ["preview line"],
			...patch,
		};
	}

	it("first and last lines are the accent separator", () => {
		const questions = [singleQ("Pick one", ["A", "B"])];
		const lines = composePanel(makeBaseOpts(questions));
		const sep = theme.fg("accent", "─".repeat(80));
		expect(lines[0]).toBe(sep);
		expect(lines[lines.length - 1]).toBe(sep);
	});

	it("submit-tab path: emits separator + tab bar + submit body + help + separator; no question header", () => {
		const questions = [singleQ("Pick one", ["A", "B"]), singleQ("Q2", ["X"])];
		const ctrl = new DialogController(questions);
		const s = { ...ctrl.getState(), currentTab: questions.length };
		const lines = composePanel(
			makeBaseOpts(questions, {
				state: s,
				isSubmitTab: true,
				allAnswered: false,
				rows: [],
			}),
		);
		const joined = lines.join("\n");
		// Has separator at both ends
		expect(lines[0]).toContain("─");
		expect(lines[lines.length - 1]).toContain("─");
		// Contains submit-tab content
		expect(joined).toContain("Review your answers");
		// Does NOT contain a question header (no bold question text)
		expect(joined).not.toContain("<b> Pick one</b>");
	});

	it("question path with NO preview: emits header + option list without │", () => {
		const questions = [singleQ("Pick one", ["Alpha", "Beta"])];
		const lines = composePanel(makeBaseOpts(questions));
		const joined = lines.join("\n");
		expect(joined).toContain("Pick one");
		expect(joined).toContain("Alpha");
		expect(joined).not.toContain("│");
	});

	it("question path WITH preview at wide width: emits side-by-side (│ present)", () => {
		const questions: TQuestion[] = [
			{ question: "Pick", options: [{ label: "Opt A", preview: "**Preview**" }] },
		];
		const ctrl = new DialogController(questions);
		const s = ctrl.getState();
		const lines = composePanel(
			makeBaseOpts(questions, {
				state: s,
				rows: ctrl.currentRows(),
				width: 80,
				getPreviewLines: (w, h) =>
					h !== undefined
						? Array.from({ length: h }, () => "preview".slice(0, w))
						: ["preview".slice(0, w)],
			}),
		);
		expect(lines.some((l) => l.includes("│"))).toBe(true);
	});

	it("question path WITH preview at narrow width: stacked layout (no │)", () => {
		const questions: TQuestion[] = [
			{ question: "Pick", options: [{ label: "Opt A", preview: "**Preview**" }] },
		];
		const ctrl = new DialogController(questions);
		const s = ctrl.getState();
		const THRESHOLD = SIDE_BY_SIDE_LEFT_MIN + 3 + SIDE_BY_SIDE_RIGHT_MIN;
		const lines = composePanel(
			makeBaseOpts(questions, {
				state: s,
				rows: ctrl.currentRows(),
				width: THRESHOLD - 1,
				getPreviewLines: (_w, h) =>
					h !== undefined ? Array.from({ length: h }, () => "preview") : ["preview"],
			}),
		);
		for (const l of lines) {
			expect(l).not.toContain("│");
		}
	});

	it.each(["text", "note", "chat"] as const)(
		'input mode "%s" appends the input panel with correct label',
		(mode) => {
			const labelMap = {
				text: "Your answer",
				note: "Note for this option",
				chat: "What would you like to chat about?",
			};
			const questions = [singleQ("Q", ["A"])];
			const ctrl = new DialogController(questions);
			const s = { ...ctrl.getState(), inputMode: mode };
			const lines = composePanel(
				makeBaseOpts(questions, {
					state: s,
					rows: ctrl.currentRows(),
					getEditorLines: (_w) => ["typed text"],
				}),
			);
			const joined = lines.join("\n");
			expect(joined).toContain(labelMap[mode]);
			expect(joined).toContain("typed text");
			expect(joined).toContain("Enter to submit");
		},
	);

	it("getEditorLines is called with width - 2 (floored at 1)", () => {
		const questions = [singleQ("Q", ["A"])];
		const ctrl = new DialogController(questions);
		const s = { ...ctrl.getState(), inputMode: "text" as const };
		const capturedWidths: number[] = [];
		for (const w of [80, 40, 1, 2]) {
			composePanel(
				makeBaseOpts(questions, {
					state: s,
					rows: ctrl.currentRows(),
					width: w,
					getEditorLines: (ew) => { capturedWidths.push(ew); return []; },
				}),
			);
		}
		// width 80 → editorWidth 78; width 40 → 38; width 1 → 1 (floored); width 2 → 1
		expect(capturedWidths[0]).toBe(78);
		expect(capturedWidths[1]).toBe(38);
		expect(capturedWidths[2]).toBe(1); // Math.max(1, 1-2) = 1
		expect(capturedWidths[3]).toBe(1); // Math.max(1, 2-2) = 1
	});

	it.each([1, 20, 40, 80])(
		"no rendered line exceeds width=%i (width safety with realLayout)",
		(w) => {
			const questions = [singleQ("A question with a moderately long label text", ["Alpha", "Beta"])];
			const ctrl = new DialogController(questions);
			const lines = composePanel({
				state: ctrl.getState(),
				questions,
				isSubmitTab: false,
				allAnswered: false,
				rows: ctrl.currentRows(),
				width: w,
				theme: plainTheme,
				layout: realLayout,
				getEditorLines: (ew) => [realTruncateToWidth("editor text", ew)],
				getPreviewLines: (pw, ph) =>
					ph !== undefined
						? Array.from({ length: ph }, () => realTruncateToWidth("preview", pw))
						: [realTruncateToWidth("preview", pw)],
			});
			for (const line of lines) {
				expect(realVisibleWidth(line)).toBeLessThanOrEqual(w);
			}
		},
	);

	it("description line is included when question has a description", () => {
		const questions: TQuestion[] = [
			{ question: "Pick", description: "choose wisely", options: [{ label: "A" }] },
		];
		const lines = composePanel(makeBaseOpts(questions));
		expect(lines.join("\n")).toContain("choose wisely");
	});
});
