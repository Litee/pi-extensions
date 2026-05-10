import { describe, expect, it } from "vitest";

import { DialogController, type DialogState } from "../src/controller.js";
import { dispatchKey, type KeyAction, type KeyProbe } from "../src/inputRouter.js";
import type { TQuestion } from "../src/schema.js";

/**
 * Encodes the same key IDs the real `matchesKey` probe resolves: every test
 * picks a distinct canonical string per id so we can detect mis-routing.
 */
const KEY = {
	tab: "\t",
	"shift-tab": "\x1b[Z",
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	space: " ",
} as const;

const keys: KeyProbe = {
	matches(data, keyId) {
		return KEY[keyId] === data;
	},
};

function singleQ(question: string, labels: string[]): TQuestion {
	return { question, options: labels.map((label) => ({ label })) };
}

function multiQ(question: string, labels: string[]): TQuestion {
	return { question, multiSelect: true, options: labels.map((label) => ({ label })) };
}

function makeState(questions: TQuestion[], patch: Partial<DialogState> = {}): DialogState {
	const ctrl = new DialogController(questions);
	const s = ctrl.getState();
	return { ...s, ...patch };
}

describe("dispatchKey — input mode takes priority over everything", () => {
	const questions = [singleQ("Q1", ["A", "B"])];

	it.each([
		["text" as const],
		["note" as const],
		["chat" as const],
	])("in input mode %s: Esc -> cancel-input", (mode) => {
		const state = makeState(questions, { inputMode: mode });
		expect(dispatchKey(state, questions, KEY.escape, keys)).toEqual({ kind: "cancel-input" });
	});

	it.each([
		["text" as const, KEY.enter],
		["note" as const, KEY.tab],
		["chat" as const, "a"],
		["text" as const, KEY.up],
		["note" as const, KEY.space],
	])("in input mode %s: non-Esc key %j -> editor-input passthrough", (mode, data) => {
		const state = makeState(questions, { inputMode: mode });
		expect(dispatchKey(state, questions, data, keys)).toEqual({ kind: "editor-input", data });
	});
});

describe("dispatchKey — submit tab", () => {
	const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"])];
	const submit: Partial<DialogState> = { currentTab: 2 };

	it.each([
		["tab", KEY.tab, { kind: "next-tab" }],
		["right", KEY.right, { kind: "next-tab" }],
		["shift-tab", KEY["shift-tab"], { kind: "prev-tab" }],
		["left", KEY.left, { kind: "prev-tab" }],
		["enter", KEY.enter, { kind: "enter" }],
		["escape", KEY.escape, { kind: "cancel" }],
	] as Array<[string, string, KeyAction]>)(
		"submit tab: %s -> %j",
		(_label, data, expected) => {
			const state = makeState(questions, submit);
			expect(dispatchKey(state, questions, data, keys)).toEqual(expected);
		},
	);

	it("submit tab ignores unrelated keys (space, up, down, n)", () => {
		const state = makeState(questions, submit);
		for (const data of [KEY.space, KEY.up, KEY.down, "n"]) {
			expect(dispatchKey(state, questions, data, keys)).toEqual({ kind: "ignore" });
		}
	});
});

describe("dispatchKey — regular question tab (single question, no tab switching)", () => {
	const questions = [singleQ("Q1", ["A", "B"])];

	it.each([
		["up", KEY.up, { kind: "move-up" }],
		["down", KEY.down, { kind: "move-down" }],
		["n", "n", { kind: "begin-note" }],
		["enter", KEY.enter, { kind: "enter" }],
		["escape", KEY.escape, { kind: "cancel" }],
	] as Array<[string, string, KeyAction]>)("single-question: %s -> %j", (_l, data, expected) => {
		expect(dispatchKey(makeState(questions), questions, data, keys)).toEqual(expected);
	});

	it("single-question: tab / right / left / shift-tab do NOT switch tabs — ignored", () => {
		const state = makeState(questions);
		for (const data of [KEY.tab, KEY.right, KEY.left, KEY["shift-tab"]]) {
			expect(dispatchKey(state, questions, data, keys)).toEqual({ kind: "ignore" });
		}
	});

	it("single-question single-select: space is NOT a toggle — ignored", () => {
		expect(dispatchKey(makeState(questions), questions, KEY.space, keys)).toEqual({
			kind: "ignore",
		});
	});
});

describe("dispatchKey — regular tab with multiple questions enables tab switching", () => {
	const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"])];

	it.each([
		[KEY.tab, { kind: "next-tab" }],
		[KEY.right, { kind: "next-tab" }],
		[KEY["shift-tab"], { kind: "prev-tab" }],
		[KEY.left, { kind: "prev-tab" }],
	] as Array<[string, KeyAction]>)("tab switch key %j -> %j", (data, expected) => {
		expect(dispatchKey(makeState(questions), questions, data, keys)).toEqual(expected);
	});
});

describe("dispatchKey — multi-select question", () => {
	const questions = [multiQ("Q1", ["A", "B"])];

	it("space -> toggle-current", () => {
		expect(dispatchKey(makeState(questions), questions, KEY.space, keys)).toEqual({
			kind: "toggle-current",
		});
	});

	it("enter still routes to enter (controller decides whether to advance)", () => {
		expect(dispatchKey(makeState(questions), questions, KEY.enter, keys)).toEqual({
			kind: "enter",
		});
	});

	it("n still routes to begin-note even in multi-select", () => {
		expect(dispatchKey(makeState(questions), questions, "n", keys)).toEqual({
			kind: "begin-note",
		});
	});
});

describe("dispatchKey — ordering guarantees", () => {
	it("input mode beats submit tab: Esc in input mode on Submit is cancel-input, not cancel", () => {
		const questions = [singleQ("Q1", ["A"])];
		const state = makeState(questions, { currentTab: 1, inputMode: "text" });
		expect(dispatchKey(state, questions, KEY.escape, keys)).toEqual({ kind: "cancel-input" });
	});

	it("submit tab beats regular-tab logic: up/down/n are ignored on submit tab", () => {
		const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"])];
		const state = makeState(questions, { currentTab: 2 });
		expect(dispatchKey(state, questions, KEY.up, keys)).toEqual({ kind: "ignore" });
		expect(dispatchKey(state, questions, "n", keys)).toEqual({ kind: "ignore" });
	});

	it("tab-switching beats up/down when both would apply (they never overlap on data, but order is locked)", () => {
		const questions = [singleQ("Q1", ["A"]), singleQ("Q2", ["B"])];
		expect(dispatchKey(makeState(questions), questions, KEY.tab, keys)).toEqual({
			kind: "next-tab",
		});
	});

	it("unknown characters return ignore on a regular tab", () => {
		const questions = [singleQ("Q1", ["A"])];
		expect(dispatchKey(makeState(questions), questions, "z", keys)).toEqual({ kind: "ignore" });
	});
});
