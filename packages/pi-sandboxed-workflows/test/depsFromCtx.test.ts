/**
 * depsFromCtx unit tests.
 */
import { describe, expect, it, vi } from "vitest";

import { depsFromCtx } from "../src/depsFromCtx.js";

interface UiCalls {
	notify: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
}

function makePi(): { sendMessage: ReturnType<typeof vi.fn> } {
	return { sendMessage: vi.fn() };
}

function makeCtx(
	ui: UiCalls,
	opts: { signal?: AbortSignal; hasUI?: boolean } = {},
): unknown {
	return {
		cwd: "/cwd",
		ui,
		hasUI: opts.hasUI ?? true,
		signal: opts.signal,
	};
}

function makeUi(overrides: Partial<UiCalls> = {}): UiCalls {
	return {
		notify: vi.fn(),
		setStatus: vi.fn(),
		input: vi.fn().mockResolvedValue("typed"),
		select: vi.fn().mockResolvedValue("chosen"),
		confirm: vi.fn().mockResolvedValue(true),
		...overrides,
	};
}

describe("depsFromCtx", () => {
	it("forwards sendMessage to pi.sendMessage with both args", () => {
		const pi = makePi();
		const deps = depsFromCtx(
			pi as unknown as Parameters<typeof depsFromCtx>[0],
			makeCtx(makeUi()) as Parameters<typeof depsFromCtx>[1],
			new AbortController().signal,
		);
		const message = { customType: "x", content: "y", display: true };
		const opts = { triggerTurn: false, deliverAs: "nextTurn" as const };
		deps.sendMessage(message, opts);
		expect(pi.sendMessage).toHaveBeenCalledWith(message, opts);
	});

	it("routes notify and setStatus through ctx.ui when present", () => {
		const ui = makeUi();
		const deps = depsFromCtx(
			makePi() as unknown as Parameters<typeof depsFromCtx>[0],
			makeCtx(ui) as Parameters<typeof depsFromCtx>[1],
			new AbortController().signal,
		);
		deps.notify("hi", "warning");
		expect(ui.notify).toHaveBeenCalledWith("hi", "warning");
		deps.setStatus("k", "v");
		expect(ui.setStatus).toHaveBeenCalledWith("k", "v");
		deps.clearStatus("k");
		expect(ui.setStatus).toHaveBeenLastCalledWith("k", undefined);
	});

	it("propagates ctx.cwd verbatim and uses sessionSignal for signal", () => {
		const ctxAc = new AbortController();
		const sessionAc = new AbortController();
		const deps = depsFromCtx(
			makePi() as unknown as Parameters<typeof depsFromCtx>[0],
			makeCtx(makeUi(), { signal: ctxAc.signal }) as Parameters<typeof depsFromCtx>[1],
			sessionAc.signal,
		);
		expect(deps.cwd).toBe("/cwd");
		expect(deps.signal).toBe(sessionAc.signal);
	});

	describe("deps.ui", () => {
		it("reflects ctx.hasUI", () => {
			const withUI = depsFromCtx(
				makePi() as unknown as Parameters<typeof depsFromCtx>[0],
				makeCtx(makeUi(), { hasUI: true }) as Parameters<typeof depsFromCtx>[1],
				new AbortController().signal,
			);
			expect(withUI.ui?.hasUI).toBe(true);

			const noUI = depsFromCtx(
				makePi() as unknown as Parameters<typeof depsFromCtx>[0],
				makeCtx(makeUi(), { hasUI: false }) as Parameters<typeof depsFromCtx>[1],
				new AbortController().signal,
			);
			expect(noUI.ui?.hasUI).toBe(false);
		});

		it("delegates input to ctx.ui.input", async () => {
			const ui = makeUi();
			const deps = depsFromCtx(
				makePi() as unknown as Parameters<typeof depsFromCtx>[0],
				makeCtx(ui) as Parameters<typeof depsFromCtx>[1],
				new AbortController().signal,
			);
			const result = await deps.ui!.input("Enter name", "default");
			expect(ui.input).toHaveBeenCalledWith("Enter name", "default");
			expect(result).toBe("typed");
		});

		it("delegates select to ctx.ui.select (copies readonly array)", async () => {
			const ui = makeUi();
			const deps = depsFromCtx(
				makePi() as unknown as Parameters<typeof depsFromCtx>[0],
				makeCtx(ui) as Parameters<typeof depsFromCtx>[1],
				new AbortController().signal,
			);
			const opts = ["a", "b"] as const;
			const result = await deps.ui!.select("Pick one", opts);
			expect(ui.select).toHaveBeenCalledWith("Pick one", ["a", "b"]);
			expect(result).toBe("chosen");
		});

		it("delegates confirm to ctx.ui.confirm", async () => {
			const ui = makeUi();
			const deps = depsFromCtx(
				makePi() as unknown as Parameters<typeof depsFromCtx>[0],
				makeCtx(ui) as Parameters<typeof depsFromCtx>[1],
				new AbortController().signal,
			);
			const result = await deps.ui!.confirm("Title", "Are you sure?");
			expect(ui.confirm).toHaveBeenCalledWith("Title", "Are you sure?");
			expect(result).toBe(true);
		});
	});
});
