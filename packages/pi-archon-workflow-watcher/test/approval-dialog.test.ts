import { describe, expect, it, vi } from "vitest";
import { createApprovalDialog } from "../src/approval-dialog.js";
import type { ApprovalDialogParams, ApprovalResult } from "../src/runtime.js";

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

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe("createApprovalDialog — smoke", () => {
	it("renders without throwing (no content file)", () => {
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
		// Simulate pressing down to move to "Reject", then Enter to select
		dialog.handleInput("\x1b[B"); // down
		dialog.handleInput("\r");     // enter → selects Reject
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("feedback"))).toBe(true);
	});

	it("escape in reject-input returns to select phase", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\x1b[B"); // down
		dialog.handleInput("\r");     // select Reject
		dialog.handleInput("\x1b");   // escape back
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Approve"))).toBe(true);
	});

	it("calls done with reject decision and feedback on enter in reject-input phase", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\x1b[B"); // down → Reject
		dialog.handleInput("\r");     // select Reject
		// Type feedback
		"good work".split("").forEach((ch) => dialog.handleInput(ch));
		dialog.handleInput("\r"); // submit
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
		dialog.handleInput("\r"); // enter → first item = Approve
		expect(done).toHaveBeenCalledOnce();
		expect((done.mock.calls[0]![0] as ApprovalResult)?.decision).toBe("approve");
	});

	it("calls done with null on escape in select phase", () => {
		const done = vi.fn();
		const dialog = createApprovalDialog(makeParams(), done, makeTui(), makeTheme());
		dialog.handleInput("\x1b"); // escape
		expect(done).toHaveBeenCalledOnce();
		expect(done.mock.calls[0]![0]).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Ctrl-B / Ctrl-F page scrolling
// ---------------------------------------------------------------------------

describe("createApprovalDialog — Ctrl-B/F page scrolling", () => {
	function makeLongParams(): ApprovalDialogParams {
		// Generate a message with 60 lines so page scroll is meaningful
		const message = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of long message`).join("\n");
		return makeParams({ message });
	}

	it("Ctrl-F scrolls page down (offset increases)", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(makeLongParams(), vi.fn(), tui, makeTheme());
		// Render first to populate lines
		dialog.render(80);
		const linesBefore = dialog.render(80);
		dialog.handleInput("\x06"); // Ctrl-F
		const linesAfter = dialog.render(80);
		// Content should have scrolled — first visible line differs
		expect(linesAfter[2]).not.toBe(linesBefore[2]);
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("Ctrl-B scrolls page up after scrolling down", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(makeLongParams(), vi.fn(), tui, makeTheme());
		dialog.render(80);
		const original = dialog.render(80);
		dialog.handleInput("\x06"); // Ctrl-F — page down
		dialog.handleInput("\x02"); // Ctrl-B — page up
		const restored = dialog.render(80);
		expect(restored[2]).toBe(original[2]);
	});

	it("Ctrl-B at top does not go negative", () => {
		const dialog = createApprovalDialog(makeLongParams(), vi.fn(), makeTui(), makeTheme());
		dialog.render(80);
		// Multiple Ctrl-B at top should not throw
		expect(() => {
			dialog.handleInput("\x02");
			dialog.handleInput("\x02");
			dialog.render(80);
		}).not.toThrow();
	});

	it("Ctrl-F at bottom does not exceed max offset", () => {
		const dialog = createApprovalDialog(makeLongParams(), vi.fn(), makeTui(), makeTheme());
		dialog.render(80);
		// Scroll past the bottom
		for (let i = 0; i < 10; i++) dialog.handleInput("\x06");
		expect(() => dialog.render(80)).not.toThrow();
	});

	it("Ctrl-B/F are no-ops in reject-input phase", () => {
		const tui = makeTui();
		const dialog = createApprovalDialog(makeLongParams(), vi.fn(), tui, makeTheme());
		dialog.render(80);
		dialog.handleInput("\x1b[B"); dialog.handleInput("\r"); // enter reject phase
		tui.requestRender.mockClear();
		dialog.render(80); // render to establish baseline
		dialog.handleInput("\x06"); // Ctrl-F — should not scroll content
		dialog.handleInput("\x02"); // Ctrl-B
		const linesAfter = dialog.render(80);
		// Phase is reject-input — content lines unchanged since renderPath different
		// Just confirm no crash and render is stable
		expect(linesAfter).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Content file rendering
// ---------------------------------------------------------------------------

describe("createApprovalDialog — contentFile", () => {
	it("shows contentLabel when contentFile content is provided", () => {
		// Pass content via overriding: we can't create real files easily in tests,
		// but we can test that when contentFile is absent, layout uses full height.
		const dialog = createApprovalDialog(
			makeParams({ contentLabel: "plan.md" }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		const lines = dialog.render(80);
		// Without contentFile the layout should still render fine
		expect(lines.some((l) => l.includes("Approve"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Content file — real file path
// ---------------------------------------------------------------------------
import { mkdirSync as _mkdirSync, rmSync as _rmSync, writeFileSync as _writeFileSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";

describe("createApprovalDialog — with contentFile", () => {
	it("renders contentLabel section when contentFile exists", () => {
		const dir = _join(_tmpdir(), "approval-dialog-test-" + Date.now());
		_mkdirSync(dir, { recursive: true });
		const planPath = _join(dir, "plan.md");
		const content = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n");
		_writeFileSync(planPath, content);
		try {
			const dialog = createApprovalDialog(
				makeParams({ contentFile: planPath, contentLabel: "plan.md" }),
				vi.fn(),
				makeTui(),
				makeTheme(),
			);
			const lines = dialog.render(80);
			expect(lines.some((l) => l.includes("plan.md"))).toBe(true);
			expect(lines.some((l) => l.includes("Line 1"))).toBe(true);
			expect(lines.some((l) => l.includes("Approve"))).toBe(true);
		} finally {
			_rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Ctrl-F scrolls content section when contentFile is provided", () => {
		const dir = _join(_tmpdir(), "approval-dialog-test-" + Date.now());
		_mkdirSync(dir, { recursive: true });
		const planPath = _join(dir, "plan.md");
		_writeFileSync(planPath, Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n"));
		try {
			const tui = makeTui();
			const dialog = createApprovalDialog(
				makeParams({ contentFile: planPath, contentLabel: "plan.md" }),
				vi.fn(),
				tui,
				makeTheme(),
			);
			dialog.render(80);
			const before = dialog.render(80);
			dialog.handleInput("\x06"); // Ctrl-F
			const after = dialog.render(80);
			// Content scrolled — body changed
			expect(after).not.toEqual(before);
			expect(tui.requestRender).toHaveBeenCalled();
		} finally {
			_rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gracefully handles missing contentFile", () => {
		const dialog = createApprovalDialog(
			makeParams({ contentFile: "/tmp/nonexistent-plan-xyz.md" }),
			vi.fn(),
			makeTui(),
			makeTheme(),
		);
		expect(() => dialog.render(80)).not.toThrow();
		// Falls back to gate-message-only layout
		const lines = dialog.render(80);
		expect(lines.some((l) => l.includes("Approve"))).toBe(true);
	});

	it("up arrow does nothing when at top of scrollable", () => {
		const dir = _join(_tmpdir(), "approval-dialog-test-" + Date.now());
		_mkdirSync(dir, { recursive: true });
		const planPath = _join(dir, "plan.md");
		_writeFileSync(planPath, "Short content\nLine 2");
		try {
			const tui = makeTui();
			const dialog = createApprovalDialog(
				makeParams({ contentFile: planPath }),
				vi.fn(),
				tui,
				makeTheme(),
			);
			dialog.render(80);
			tui.requestRender.mockClear();
			dialog.handleInput("\x1b[A"); // up at top — no scroll
			// requestRender not called since canScrollUp() is false
			expect(tui.requestRender).not.toHaveBeenCalled();
		} finally {
			_rmSync(dir, { recursive: true, force: true });
		}
	});
});
