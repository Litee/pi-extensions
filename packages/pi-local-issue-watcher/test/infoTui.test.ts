/**
 * Shell-level regression tests for the `/local-issue-watcher browse`
 * TUI (tracker issues #0025, #0026).
 *
 * `src/infoTui.ts` is excluded from coverage because its rendering is
 * only meaningful under a live pi-tui runtime. The pure key-dispatch
 * table is unit-tested in `infoTuiKeys.test.ts` and the substring
 * filter in `infoTuiFilter.test.ts`; the cases here exist to pin the
 * integration between those helpers and the live SelectList / Input /
 * mode-state machine against the exact keystrokes that went
 * unhandled in the wild:
 *
 *   - Esc in detail mode flips back to list mode
 *   - Left-Arrow in detail mode flips back to list mode
 *   - Ctrl-C in detail mode closes the widget (emergency exit)
 *   - Esc in list mode closes the widget (pre-existing; regression guard)
 *   - Printable keys in detail mode are swallowed (regression guard)
 *   - Empty-state branch has its own close path (not routed via dispatchKey)
 *
 * Strategy: stub out the handful of pi-tui component classes the
 * factory instantiates, keep the real `matchesKey` implementation
 * exported by `@earendil-works/pi-tui`, and drive the returned handle's
 * `handleInput(data)` directly. The stubs track instances on static
 * fields so tests can reach through to the search input's buffered
 * value to verify we really are routing to it (i.e. we are in list
 * mode) after Esc.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// pi-tui mock
// ---------------------------------------------------------------------------
// We keep the real `matchesKey` (the whole point of #0026 is that the
// source uses it) but replace the Container/Input/SelectList/Text
// classes with test doubles that expose just enough surface to drive
// the routing logic.
// ---------------------------------------------------------------------------

interface FakeComponent {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput?: (data: string) => void;
}

// vi.mock is hoisted to the top of the file, so the mock factory runs
// before class declarations at module scope. Define the fakes inside
// `vi.hoisted` so they exist at the moment the mock factory evaluates,
// and re-export the classes from the hoisted block for tests to reach
// through to instance bookkeeping.
const fakes = vi.hoisted(() => {
	interface FC {
		render: (w: number) => string[];
		invalidate: () => void;
		handleInput?: (data: string) => void;
	}
	class FakeContainer implements FC {
		static instances: FakeContainer[] = [];
		children: FC[] = [];
		constructor() {
			FakeContainer.instances.push(this);
		}
		addChild(c: FC): void {
			this.children.push(c);
		}
		removeChild(c: FC): void {
			const i = this.children.indexOf(c);
			if (i >= 0) this.children.splice(i, 1);
		}
		clear(): void {
			this.children = [];
		}
		invalidate(): void {
			for (const c of this.children) c.invalidate();
		}
		render(_w: number): string[] {
			return [];
		}
	}
	class FakeInput implements FC {
		static instances: FakeInput[] = [];
		private value = "";
		constructor() {
			FakeInput.instances.push(this);
		}
		handleInput(data: string): void {
			// Minimal printable-char buffer so tests can assert "did this
			// key land in the search input".
			if (data === "\x7f" || data === "\b") {
				this.value = this.value.slice(0, -1);
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.value += data;
			}
		}
		getValue(): string {
			return this.value;
		}
		invalidate(): void {}
		render(_w: number): string[] {
			return [];
		}
	}
	interface Item {
		value: string;
		label: string;
	}
	class FakeSelectList implements FC {
		static instances: FakeSelectList[] = [];
		onSelect: ((item: Item) => void) | undefined;
		onCancel: (() => void) | undefined;
		onSelectionChange: ((item: Item) => void) | undefined;
		filteredItems: Item[];
		selectedIndex = 0;
		constructor(
			public items: Item[],
			public maxHeight: number,
			public theme: unknown,
		) {
			this.filteredItems = [...items];
			FakeSelectList.instances.push(this);
		}
		handleInput(data: string): void {
			if (data === "\r" || data === "\n") {
				const item = this.filteredItems[this.selectedIndex];
				if (item && this.onSelect) this.onSelect(item);
			}
		}
		invalidate(): void {}
		setSelectedIndex(idx: number): void { this.selectedIndex = idx }
		render(_w: number): string[] {
			return [];
		}
	}
	class FakeText implements FC {
		static instances: FakeText[] = [];
		constructor(
			public text: string,
			public _a: number,
			public _b: number,
		) {
			FakeText.instances.push(this);
		}
		setText(text: string): void {
			this.text = text;
		}
		invalidate(): void {}
		render(_w: number): string[] {
			return [this.text];
		}
	}
	return { FakeContainer, FakeInput, FakeSelectList, FakeText };
});

const { FakeContainer, FakeInput, FakeSelectList, FakeText } = fakes;

vi.mock("@earendil-works/pi-tui", async () => {
	const actual =
		await vi.importActual<typeof import("@earendil-works/pi-tui")>(
			"@earendil-works/pi-tui",
		);
	return {
		...actual,
		Container: fakes.FakeContainer,
		Input: fakes.FakeInput,
		SelectList: fakes.FakeSelectList,
		Text: fakes.FakeText,
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getSelectListTheme: () => ({}),
}));

// Import AFTER the mocks so the factory grabs the stubbed classes.
import type { InfoRow } from "../src/infoHandler.js";
import { makeInfoTuiPicker } from "../src/infoTui.js";
import type { IssueInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(issueId: string, title: string): InfoRow {
	const info: IssueInfo = {
		mtimeNs: 0n,
		issueId,
		status: "open",
		title,
		description: `desc of ${title}`,
		comments: [],
		skill: "my-skill",
		skillVersion: "1.0.0",
	};
	return {
		value: `/tmp/issues/${issueId}.json`,
		label: `my-skill #${issueId} \u2014 ${title}`,
		info,
	};
}

interface Harness {
	handle: FakeComponent & { handleInput: (data: string) => void };
	tui: { requestRender: ReturnType<typeof vi.fn>; setFocus: ReturnType<typeof vi.fn> };
	done: ReturnType<typeof vi.fn>;
}

/**
 * Construct the picker, invoke it with the provided rows, wait for
 * the dynamic imports inside `makeInfoTuiPicker` to resolve and the
 * factory to be invoked, then hand back the resulting render/input
 * handle plus the `done` mock and tui stub.
 */
async function setupPicker(rows: InfoRow[]): Promise<Harness> {
	FakeContainer.instances = [];
	FakeInput.instances = [];
	FakeSelectList.instances = [];
	FakeText.instances = [];

	const tui = {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
	};
	const done = vi.fn();
	let handle: FakeComponent | undefined;

	// partial ctx stub; factory arg typed as any by pi-tui's custom() signature
	const ctx = {
		ui: {
			theme: {
				fg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			},
			// Our stub does NOT wait for `done` — resolving eagerly lets
			// the picker's outer `await ctx.ui.custom(...)` complete so
			// tests can read `handle` back synchronously after setup.
			custom: vi.fn(async (factory: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => Promise<FakeComponent>) => {
				handle = await factory(tui, {}, {}, done);
			}),
		},
	} as unknown as ExtensionCommandContext;

	const picker = makeInfoTuiPicker(ctx);
	await picker({ rows, summary: "1 open, 1 total" });

	if (!handle || !handle.handleInput) {
		throw new Error("Picker factory did not return a handle with handleInput");
	}
	return {
		handle: handle as FakeComponent & { handleInput: (data: string) => void },
		tui,
		done,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeInfoTuiPicker — detail-mode input routing (#0026 regression)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("Esc in detail mode flips mode back to list", async () => {
		const { handle, tui, done } = await setupPicker([
			makeRow("0001", "first issue"),
		]);

		// Enter detail mode via Enter → SelectList.onSelect.
		handle.handleInput("\r");
		// Clear render bookkeeping from the mode-flip-in so the
		// mode-flip-out assertion is unambiguous.
		tui.requestRender.mockClear();

		// Esc → back to list mode.
		handle.handleInput("\x1b");

		expect(tui.requestRender).toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();

		// Prove we're back in list mode by typing a printable char and
		// verifying it reached the search input (detail mode would have
		// swallowed it).
		const searchInput = FakeInput.instances[0];
		expect(searchInput).toBeDefined();
		handle.handleInput("a");
		expect(searchInput!.getValue()).toBe("a");
	});

	it("Left-Arrow in detail mode flips mode back to list", async () => {
		const { handle, tui, done } = await setupPicker([
			makeRow("0001", "first issue"),
		]);

		handle.handleInput("\r");
		tui.requestRender.mockClear();

		// `\x1b[D` is the legacy CSI sequence for Left-Arrow;
		// `matchesKey(data, "left")` accepts this and the Kitty
		// variants the #0026 hotfix was meant to cover.
		handle.handleInput("\x1b[D");

		expect(tui.requestRender).toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();

		const searchInput = FakeInput.instances[0];
		handle.handleInput("x");
		expect(searchInput!.getValue()).toBe("x");
	});

	it("Ctrl-C in detail mode closes the widget", async () => {
		const { handle, done } = await setupPicker([
			makeRow("0001", "first issue"),
		]);

		handle.handleInput("\r"); // enter detail mode
		handle.handleInput("\x03"); // Ctrl-C

		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("Ctrl-C in list mode closes the widget (unconditional emergency exit)", async () => {
		const { handle, done } = await setupPicker([
			makeRow("0001", "first issue"),
		]);

		handle.handleInput("\x03");

		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("Esc in list mode still closes the widget (pre-existing behaviour)", async () => {
		const { handle, done } = await setupPicker([
			makeRow("0001", "first issue"),
		]);

		handle.handleInput("\x1b");

		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("detail mode swallows a printable key without exiting, then Esc+char reaches search input", async () => {
		// Integration regression: the pure `dispatchKey` matrix is
		// covered in `infoTuiKeys.test.ts`; this case proves the shell
		// actually wires `ignore` → no-op and `filter-input` → searchInput
		// after a detail-mode exit.
		const { handle, done } = await setupPicker([
			makeRow("0001", "first issue"),
		]);

		handle.handleInput("\r"); // enter detail mode

		const searchInput = FakeInput.instances[0];
		const beforeValue = searchInput!.getValue();

		handle.handleInput("q");

		expect(done).not.toHaveBeenCalled();
		expect(searchInput!.getValue()).toBe(beforeValue);

		handle.handleInput("\x1b"); // back to list
		handle.handleInput("a");
		expect(searchInput!.getValue()).toBe(`${beforeValue}a`);
	});
});

describe("makeInfoTuiPicker — empty-state input routing", () => {
	it("Esc closes the empty-state handle", async () => {
		const { handle, done } = await setupPicker([]);
		handle.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("Ctrl-C closes the empty-state handle", async () => {
		const { handle, done } = await setupPicker([]);
		handle.handleInput("\x03");
		expect(done).toHaveBeenCalledWith(undefined);
	});
});
