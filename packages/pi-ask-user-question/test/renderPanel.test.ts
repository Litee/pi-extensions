import { describe, expect, it } from "vitest";

import type { Answer } from "../src/format.js";
import { DialogController, type DialogState } from "../src/controller.js";
import {
	padRight,
	renderHelp,
	renderOptionList,
	renderSubmitTab,
	renderTabBar,
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
