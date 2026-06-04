import { describe, expect, it, vi } from "vitest";
import { createApprovalDialog } from "../src/approval-dialog.js";
import type {
	ApprovalDialogParams,
	ApprovalResult,
	DialogSection,
} from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (_color: string, text: string) => text,
	};
}

function makeTui() {
	return { requestRender: vi.fn() };
}

function makeParams(overrides: Partial<ApprovalDialogParams> = {}): ApprovalDialogParams {
	return {
		runId: "r1",
		workflowName: "pi-extension-feature",
		nodeId: "plan-gate",
		message: "Review the plan above.\nLine two of message.\nLine three.",
		...overrides,
	};
}

function section(
	title: string,
	body: string,
	primary: boolean = false,
): DialogSection {
	return primary ? { title, body, primary: true } : { title, body };
}

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe("createApprovalDialog — smoke", () => {
	it("renders without throwing (no sections)", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		expect(() => dialog.render(80)).not.toThrow();
		const lines = dialog.render(80);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => l.includes("plan-gate"))).toBe(true);
		expect(lines.some((l) => l.includes("pi-extension-feature"))).toBe(true);
	});

	it("renders approve/reject list in select phase", () => {
		const dialog = createApprovalDialog(makeParams(), vi.fn(), makeTui(), makeTheme());
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Approve"))).toBe(true);
		expect(lines.some((l) => l.includes("Reject"))).toBe(true);
	});

	it("does not throw when rendered repeatedly with different widths", () => {
		const dialog = createApprovalDialog(makeParams(), vi.fn(), makeTui(), makeTheme());
		for (const w of [40, 80, 120, 20]) {
			expect(() => dialog.render(w)).not.toThrow();
		}
	});

	it("renders reject-input phase after selecting reject", () => {
		const done = vi.fn();
		const tui = makeTui();
		const dialog = createApprovalDialog(makeParams(), done, tui, makeTheme());
		dialog.handleInput("\x1b[B"); // down → move to Reject
		dialog.handleInput("\r"); // enter → selects Reject
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("feedback"))).toBe(true);
	});

	it("escape in reject-input returns to select phase", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		dialog.handleInput("\x1b");
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Approve"))).toBe(true);
	});

	it("calls done with reject decision and feedback on enter in reject-input phase", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		"good work".split("").forEach((ch) => dialog.handleInput(ch));
		dialog.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as ApprovalResult;
		expect(result?.decision).toBe("reject");
		if (result?.decision === "reject") {
			expect(result.feedback).toBe("good work");
		}
	});

	it("calls done with approve decision on first item enter", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
		expect((done.mock.calls[0]![0] as ApprovalResult)?.decision).toBe("approve");
	});

	it("calls done with null on escape in select phase", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\x1b");
		expect(done).toHaveBeenCalledOnce();
		expect(done.mock.calls[0]![0]).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Section rendering
// ---------------------------------------------------------------------------

describe("createApprovalDialog — section rendering", () => {
	it("renders each section's title verbatim", () => {
		const dialog = createApprovalDialog(
			makeParams({
				sections: [
					section("Changed files", "src/foo.ts | 2 +-"),
					section("Commit message", "docs: update stuff"),
				],
			}),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Changed files"))).toBe(true);
		expect(lines.some((l) => l.includes("Commit message"))).toBe(true);
		expect(lines.some((l) => l.includes("src/foo.ts"))).toBe(true);
		expect(lines.some((l) => l.includes("docs: update stuff"))).toBe(true);
	});

	it("primary section displays [primary] badge and primary body", () => {
		const body = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n");
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("plan.md", body, true)] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("plan.md"))).toBe(true);
		expect(lines.some((l) => l.includes("[primary]"))).toBe(true);
		// Body lines 1..18 should be visible (primary gets 18 lines)
		expect(lines.some((l) => l.includes("Line 1"))).toBe(true);
		expect(lines.some((l) => l.includes("Line 18"))).toBe(true);
		// Line 19+ should NOT be visible initially (before any scroll)
		expect(lines.some((l) => l.includes("Line 19"))).toBe(false);
	});

	it("non-primary section renders up to 6 visible lines", () => {
		const body = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("Changed files", body)] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Line 1"))).toBe(true);
		expect(lines.some((l) => l.includes("Line 6"))).toBe(true);
		// Line 7+ should be hidden — 6-line cap
		expect(lines.some((l) => l.includes("Line 7"))).toBe(false);
	});

	it("non-primary section shows '… N more' hint when truncated", () => {
		// 15 lines of body → 9 hidden (15 - 6)
		const body = Array.from({ length: 15 }, (_, i) => `L${i}`).join("\n");
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("Diff", body)] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("9 more lines"))).toBe(true);
	});

	it("non-primary section shows no '… more' hint when body fits", () => {
		const body = "just one line";
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("Diff", body)] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("more line"))).toBe(false);
	});

	it("first primary section wins when multiple are marked primary", () => {
		// A is primary; B also says primary but should be treated as compact.
		const aBody = Array.from({ length: 30 }, (_, i) => `A${i}`).join("\n");
		const bBody = Array.from({ length: 30 }, (_, i) => `B${i}`).join("\n");
		const dialog = createApprovalDialog(
			makeParams({
				sections: [
					section("A", aBody, true),
					section("B", bBody, true),
				],
			}),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		// A gets 18 lines visible (A0..A17)
		expect(lines.some((l) => l.includes("A17"))).toBe(true);
		// B gets compact treatment → only B0..B5 visible
		expect(lines.some((l) => l.includes("B5"))).toBe(true);
		expect(lines.some((l) => l.includes("B10"))).toBe(false);
	});

	it("always appends gate message as a final section", () => {
		const dialog = createApprovalDialog(
			makeParams({
				message: "GATE-MARKER-XYZ",
				sections: [section("Something", "unrelated")],
			}),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Gate message"))).toBe(true);
		expect(lines.some((l) => l.includes("GATE-MARKER-XYZ"))).toBe(true);
	});

	it("appends gate message even when no sections supplied", () => {
		const dialog = createApprovalDialog(
			makeParams({ message: "hello gate" }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Gate message"))).toBe(true);
		expect(lines.some((l) => l.includes("hello gate"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Keyboard — new model: ↑/↓ always to SelectList; Ctrl keys scroll primary
// ---------------------------------------------------------------------------

describe("createApprovalDialog — keyboard", () => {
	function longPrimary(): ApprovalDialogParams {
		const body = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n");
		return makeParams({ sections: [section("plan.md", body, true)] });
	}

	it("↓ navigates SelectList even when primary can scroll down (triggers render)", () => {
		const tui = makeTui();
		const done = vi.fn();
		const dialog = createApprovalDialog(longPrimary(), done, tui, makeTheme());
		dialog.render(80);
		tui.requestRender.mockClear();
		dialog.handleInput("\x1b[B"); // down
		expect(tui.requestRender).toHaveBeenCalled();
		// Confirm SelectList advanced by pressing Enter → expect "reject"
		dialog.handleInput("\r");
		// Reject selected → now in reject-input phase (not a final done call)
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("feedback"))).toBe(true);
	});

	it("↑ goes to SelectList (does NOT scroll primary), triggers render", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(longPrimary(), vi.fn(), tui, makeTheme());
		dialog.render(80);
		tui.requestRender.mockClear();
		dialog.handleInput("\x1b[A"); // up
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("Ctrl-F pages primary section down (content moves)", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(longPrimary(), vi.fn(), tui, makeTheme());
		const before = dialog.render(80);
		dialog.handleInput("\x06"); // Ctrl-F
		const after = dialog.render(80);
		const hasLine = (lines: string[], n: number) =>
			lines.some((l) => new RegExp(`Line ${n}(?!\\d)`).test(l));
		expect(hasLine(before, 1)).toBe(true);
		expect(hasLine(after, 1)).toBe(false);
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("Ctrl-B after Ctrl-F returns to original view", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(longPrimary(), vi.fn(), tui, makeTheme());
		const original = dialog.render(80);
		dialog.handleInput("\x06");
		dialog.handleInput("\x02");
		const restored = dialog.render(80);
		expect(restored).toEqual(original);
	});

	it("Ctrl-D line-scrolls primary down", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(longPrimary(), vi.fn(), tui, makeTheme());
		dialog.render(80);
		dialog.handleInput("\x04"); // Ctrl-D
		const after = dialog.render(80);
		const hasLine = (lines: string[], n: number) =>
			lines.some((l) => new RegExp(`Line ${n}(?!\\d)`).test(l));
		// After one line down, Line 1 should be scrolled off
		expect(hasLine(after, 1)).toBe(false);
		// Line 2 still visible
		expect(hasLine(after, 2)).toBe(true);
		// Line 19 now visible (was just past the original 18-line window)
		expect(hasLine(after, 19)).toBe(true);
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("Ctrl-U after Ctrl-D returns to original view", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(longPrimary(), vi.fn(), tui, makeTheme());
		const original = dialog.render(80);
		dialog.handleInput("\x04"); // Ctrl-D
		dialog.handleInput("\x15"); // Ctrl-U
		const restored = dialog.render(80);
		expect(restored).toEqual(original);
	});

	it("Ctrl-B/F at boundaries are safe no-ops (no crash)", () => {
		const dialog = createApprovalDialog(longPrimary(), vi.fn(), makeTui(), makeTheme());
		dialog.render(80);
		// At top — Ctrl-B no-op
		for (let i = 0; i < 5; i++) dialog.handleInput("\x02");
		expect(() => dialog.render(80)).not.toThrow();
		// Scroll way past bottom
		for (let i = 0; i < 50; i++) dialog.handleInput("\x06");
		expect(() => dialog.render(80)).not.toThrow();
	});

	it("Ctrl-B/F/U/D without primary section are no-ops (no render, no crash)", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("Compact", "just a few lines")] }),
			vi.fn(),
			tui,
			makeTheme(),
		);
		dialog.render(80);
		tui.requestRender.mockClear();
		dialog.handleInput("\x06"); // Ctrl-F
		dialog.handleInput("\x02"); // Ctrl-B
		dialog.handleInput("\x04"); // Ctrl-D
		dialog.handleInput("\x15"); // Ctrl-U
		expect(tui.requestRender).not.toHaveBeenCalled();
	});

	it("Ctrl-B/F are inert in reject-input phase", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(longPrimary(), vi.fn(), tui, makeTheme());
		dialog.render(80);
		dialog.handleInput("\x1b[B"); // down → Reject
		dialog.handleInput("\r"); // select Reject → enter reject-input
		tui.requestRender.mockClear();
		dialog.render(80);
		dialog.handleInput("\x06"); // Ctrl-F — should be consumed by Input, not scroll content
		dialog.handleInput("\x02");
		// No crash is the main assertion
		const linesAfter = dialog.render(80);
		expect(linesAfter).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Help text adapts to whether a primary section exists
// ---------------------------------------------------------------------------

describe("createApprovalDialog — help text", () => {
	it("help text mentions Ctrl-B/F when primary section exists", () => {
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("A", "B", true)] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Ctrl-B/F"))).toBe(true);
		expect(lines.some((l) => l.includes("Ctrl-U/D"))).toBe(true);
	});

	it("help text omits Ctrl-B/F when no primary section", () => {
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("A", "B")] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Ctrl-B/F"))).toBe(false);
		expect(lines.some((l) => l.includes("↑↓ select"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Cancel workflow decision (line 246)
// ---------------------------------------------------------------------------

describe("createApprovalDialog — cancel workflow decision (line 246)", () => {
	it("calls done with cancel decision when Cancel workflow item is selected", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		// Select list order: Approve (0), Reject (1), Cancel workflow (2)
		dialog.handleInput("\x1b[B"); // ↓ → Reject
		dialog.handleInput("\x1b[B"); // ↓ → Cancel workflow
		dialog.handleInput("\r"); // Enter
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as ApprovalResult;
		expect(result?.decision).toBe("cancel");
	});
});

// ---------------------------------------------------------------------------
// SelectList callbacks — selectedPrefix (line 235) via theme spy
// ---------------------------------------------------------------------------

describe("createApprovalDialog — selectedPrefix callback (line 235)", () => {
	it("selectedPrefix callback fires when rendering a selected item with custom theme", () => {
		const calls: string[] = [];
		const theme = {
			fg: (color: string, text: string) => {
				calls.push(`fg:${color}`);
				return text;
			},
			bold: (t: string) => t,
			bg: (_k: string, t: string) => t,
		};
		const dialog = createApprovalDialog(makeParams(), vi.fn(), makeTui(), theme);
		// Render triggers SelectList which calls selectedPrefix for the selected item
		dialog.render(80);
		// The 'accent' color should appear from selectedPrefix/selectedText callbacks
		expect(calls.some((c) => c === "fg:accent")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Line 411 — empty feedback fallback "(no feedback provided)"
// ---------------------------------------------------------------------------

describe("createApprovalDialog — empty feedback fallback (line 411)", () => {
	it("calls done with '(no feedback provided)' when Enter is pressed with no feedback typed", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\x1b[B"); // ↓ → Reject with feedback
		dialog.handleInput("\r"); // Enter → enters reject-input phase
		// Press Enter immediately without typing any feedback → empty string → fallback
		dialog.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as ApprovalResult;
		expect(result?.decision).toBe("reject");
		if (result?.decision === "reject") {
			expect(result.feedback).toBe("(no feedback provided)");
		}
	});
});

// ---------------------------------------------------------------------------
// ScrollableText.wrap() — raw.trim() === "" TRUE branch (empty line in body)
// ---------------------------------------------------------------------------

describe("createApprovalDialog — empty line in section body (wrap() empty-line branch)", () => {
	it("renders a section body containing empty lines (covers if (raw.trim() === '') TRUE)", () => {
		// Body has an empty line between Step 1 and Step 3
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("Diff", "Step 1\n\nStep 3")] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Step 1"))).toBe(true);
		expect(lines.some((l) => l.includes("Step 3"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ScrollableText.scrollDown() FALSE branch — already at bottom (max=0)
// ---------------------------------------------------------------------------

describe("createApprovalDialog — scrollDown() FALSE branch (already at bottom)", () => {
	it("Ctrl-D when primary content fits in visible window is a no-op (covers scrollDown() FALSE)", () => {
		// Short body: 1 line. Primary section has 18 visible lines → max = max(0, 1-18) = 0.
		// scrollDown(): offset (0) < max (0) → FALSE → no increment.
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("plan.md", "One line only", true)] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		dialog.render(80);
		dialog.handleInput("\x04"); // Ctrl-D
		expect(() => dialog.render(80)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// ScrollableText.scrollUp() FALSE branch — already at top (offset=0)
// ---------------------------------------------------------------------------

describe("createApprovalDialog — scrollUp() FALSE branch (already at top)", () => {
	it("Ctrl-U when primary offset is already 0 is a no-op (covers scrollUp() FALSE)", () => {
		// Short body: offset starts at 0. scrollUp(): offset (0) > 0 → FALSE → no decrement.
		const dialog = createApprovalDialog(
			makeParams({ sections: [section("plan.md", "One line only", true)] }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		dialog.render(80);
		dialog.handleInput("\x15"); // Ctrl-U without first scrolling down
		expect(() => dialog.render(80)).not.toThrow();
	});
});
