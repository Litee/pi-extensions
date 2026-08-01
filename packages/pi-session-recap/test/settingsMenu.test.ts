/**
 * Unit tests for the `/recap-settings` interactive menu.
 *
 * Focuses on the pure menu-shape (`buildMenuItems`) and the imperative
 * loop (`runRecapSettingsCommand`) wired against a stub `ctx.ui` surface.
 * No pi runtime, no real TUI, no fs.
 */

import { describe, expect, it, vi } from "vitest";

import type { StatusLineOptions } from "../src/helpers.js";
import {
	buildMenuItems,
	ITEM_CLOSE,
	ITEM_EDIT_IDLE_PREFIX,
	MENU_TITLE,
	MIN_IDLE_SECONDS,
	runRecapSettingsCommand,
	SEPARATOR,
} from "../src/settingsMenu.js";

const baseStatus: StatusLineOptions = {
	override: null,
	activeModelSpec: "anthropic/claude-sonnet-4-6",
	autoRecapEnabled: true,
	idleSeconds: 300,
	awaySeconds: 90,
	disabledFlags: [],
	triggerCount: 0,
	tokenUsage: null,
};

function makeDeps(opts: {
	idle: number;
	status?: StatusLineOptions;
	setIdleOverride?: (n: number) => void;
} = { idle: 300 }) {
	return {
		idleSeconds: vi.fn(() => opts.idle),
		setIdleOverride: vi.fn(opts.setIdleOverride ?? (() => {})),
		resolveStatusOptions: vi.fn(() => ({ ...baseStatus, idleSeconds: opts.idle, ...(opts.status ?? {}) })),
	};
}

type SelectImpl = (
	title: string,
	items: string[],
) => Promise<string | null | undefined>;
type InputImpl = (prompt: string, defaultValue?: string) => Promise<string | null | undefined>;

function makeCtx(over: Partial<{
	hasUI: boolean;
	select: SelectImpl;
	input: InputImpl;
	notify: (msg: string, level?: "info" | "warning" | "error") => void;
}> = {}) {
	return {
		hasUI: over.hasUI ?? true,
		ui: {
			select: vi.fn<SelectImpl>(over.select ?? ((_t, _i) => Promise.resolve(ITEM_CLOSE))),
			input: vi.fn<InputImpl>(over.input ?? ((_p, _d) => Promise.resolve(null))),
			notify: vi.fn(over.notify ?? (() => {})),
		},
	};
}

describe("buildMenuItems", () => {
	it("renders the buildStatusLine body (minus its header), a separator, the editable idle row, and Close", () => {
		const items = buildMenuItems(makeDeps({ idle: 300 }));

		// Header line ("recap status") is dropped — it lives in the menu title.
		expect(items.some((it) => it === "recap status")).toBe(false);

		// All status rows survive (left-trimmed).
		expect(items[0]?.startsWith("Model:")).toBe(true);
		expect(items.some((it) => it.startsWith("Auto-recap:"))).toBe(true);
		expect(items.some((it) => it.startsWith("Idle trigger:"))).toBe(true);
		expect(items.some((it) => it.startsWith("Away trigger:"))).toBe(true);
		expect(items.some((it) => it.startsWith("Triggers:"))).toBe(true);
		expect(items.some((it) => it.startsWith("Disabled flags:"))).toBe(true);

		// Tail: separator, edit row, Close — in that order.
		const tail = items.slice(-3);
		expect(tail[0]).toBe(SEPARATOR);
		expect(tail[1]).toBe(`${ITEM_EDIT_IDLE_PREFIX} 300s`);
		expect(tail[2]).toBe(ITEM_CLOSE);
	});

	it("uses the live idleSeconds() value (post-override) for the editable row", () => {
		const items = buildMenuItems(makeDeps({ idle: 60 }));
		const row = items.find((it) => it.startsWith(ITEM_EDIT_IDLE_PREFIX));
		expect(row).toBe(`${ITEM_EDIT_IDLE_PREFIX} 60s`);
	});
});

describe("runRecapSettingsCommand", () => {
	it("warns and returns when the UI surface is missing", async () => {
		const notify = vi.fn();
		const ctx = { hasUI: false, ui: { notify } };
		await runRecapSettingsCommand(ctx, makeDeps());
		expect(notify).toHaveBeenCalledTimes(1);
		const [body, level] = notify.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(body).toMatch(/recap-settings/);
	});

	it("opens the menu with the expected title and exits cleanly on Close", async () => {
		const ctx = makeCtx();
		const deps = makeDeps({ idle: 300 });
		await runRecapSettingsCommand(ctx, deps);

		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		const [title, items] = ctx.ui.select.mock.calls[0]!;
		expect(title).toBe(MENU_TITLE);
		expect(items[items.length - 1]).toBe(ITEM_CLOSE);
		expect(deps.setIdleOverride).not.toHaveBeenCalled();
	});

	it("treats a null/undefined select result the same as Close", async () => {
		const ctx = makeCtx({ select: () => Promise.resolve(null) });
		const deps = makeDeps();
		await runRecapSettingsCommand(ctx, deps);
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(deps.setIdleOverride).not.toHaveBeenCalled();
	});

	it("loops past read-only rows without calling the setter", async () => {
		const calls: string[] = [];
		const ctx = makeCtx({
			select: (_title, items) => {
				const choice = calls.length === 0 ? items[0]! : ITEM_CLOSE;
				calls.push(choice);
				return Promise.resolve(choice);
			},
		});
		const deps = makeDeps();
		await runRecapSettingsCommand(ctx, deps);

		expect(ctx.ui.select).toHaveBeenCalledTimes(2);
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(deps.setIdleOverride).not.toHaveBeenCalled();
	});

	function pickEditThenClose(): SelectImpl {
		let phase = 0;
		return (_t, items) => {
			phase += 1;
			if (phase === 1) {
				const editRow = items.find((i) => i.startsWith(ITEM_EDIT_IDLE_PREFIX))!;
				return Promise.resolve<string>(editRow);
			}
			return Promise.resolve<string>(ITEM_CLOSE);
		};
	}

	it("on Edit idle timeout, prompts via ctx.ui.input and applies the new value", async () => {
		const ctx = makeCtx({
			select: pickEditThenClose(),
			input: () => Promise.resolve("  90  "),
		});
		const captured: number[] = [];
		const deps = makeDeps({
			idle: 300,
			setIdleOverride: (n) => captured.push(n),
		});

		await runRecapSettingsCommand(ctx, deps);

		expect(ctx.ui.input).toHaveBeenCalledTimes(1);
		const [prompt, defaultValue] = ctx.ui.input.mock.calls[0]!;
		expect(prompt).toMatch(/idle timeout/i);
		expect(prompt).toMatch(new RegExp(`min ${MIN_IDLE_SECONDS}`));
		expect(defaultValue).toBe("300");

		expect(captured).toEqual([90]);
		expect(ctx.ui.notify).toHaveBeenCalled();
		const lastNotify = ctx.ui.notify.mock.calls.at(-1)!;
		expect(lastNotify[0]).toMatch(/90s/);
		expect(lastNotify[1]).toBe("info");
	});

	it("rejects a sub-minimum idle timeout with a warning and does NOT mutate the override", async () => {
		const ctx = makeCtx({
			select: pickEditThenClose(),
			input: () => Promise.resolve("1"),
		});
		const deps = makeDeps({ idle: 300 });

		await runRecapSettingsCommand(ctx, deps);

		expect(deps.setIdleOverride).not.toHaveBeenCalled();
		const warn = ctx.ui.notify.mock.calls.find((c) => c[1] === "warning");
		expect(warn).toBeDefined();
		expect(warn![0]).toMatch(/invalid idle timeout/i);
	});

	it("rejects non-numeric input with a warning and does NOT mutate the override", async () => {
		const ctx = makeCtx({
			select: pickEditThenClose(),
			input: () => Promise.resolve("banana"),
		});
		const deps = makeDeps({ idle: 300 });

		await runRecapSettingsCommand(ctx, deps);

		expect(deps.setIdleOverride).not.toHaveBeenCalled();
		const warn = ctx.ui.notify.mock.calls.find((c) => c[1] === "warning");
		expect(warn).toBeDefined();
		expect(warn![0]).toMatch(/banana/);
	});

	it("treats an empty / cancelled input as a no-op (override unchanged)", async () => {
		const ctx = makeCtx({
			select: pickEditThenClose(),
			input: () => Promise.resolve(null),
		});
		const deps = makeDeps({ idle: 300 });

		await runRecapSettingsCommand(ctx, deps);

		expect(deps.setIdleOverride).not.toHaveBeenCalled();
		const warn = ctx.ui.notify.mock.calls.find((c) => c[1] === "warning");
		expect(warn).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// editIdleTimeout — no-input path coverage
// ---------------------------------------------------------------------------

describe("editIdleTimeout — no input UI available", () => {
	it("shows a warning toast and returns early when ctx.ui.input is not available", async () => {
		// Construct a ctx that has select (so the menu opens) but no input.
		const notify = vi.fn();
		const ctx = {
			hasUI: true,
			ui: {
				select: vi
					.fn<SelectImpl>()
					// First call: user picks the Edit row
					.mockResolvedValueOnce(`${ITEM_EDIT_IDLE_PREFIX} 300s`)
					// Second call: user picks Close (exits the loop)
					.mockResolvedValueOnce(ITEM_CLOSE),
				// input is intentionally absent — exercises the !input guard.
				notify,
			},
		};
		const deps = makeDeps({ idle: 300 });

		await runRecapSettingsCommand(ctx, deps);

		expect(deps.setIdleOverride).not.toHaveBeenCalled();
		const warn = notify.mock.calls.find((c) => c[1] === "warning");
		expect(warn).toBeDefined();
		expect(warn![0]).toMatch(/text input.*unavailable/i);
	});

	it("treats an empty-string (whitespace-only) input as a no-op (trimmed === '' path)", async () => {
		// The editIdleTimeout function trims raw input and returns early on "".
		const ctx = makeCtx({
			select: (() => {
				let call = 0;
				return (_t: string, _items: string[]) => {
					call++;
					if (call === 1) return Promise.resolve(`${ITEM_EDIT_IDLE_PREFIX} 300s`);
					return Promise.resolve(ITEM_CLOSE);
				};
			})(),
			input: () => Promise.resolve("   "), // whitespace only
		});
		const deps = makeDeps({ idle: 300 });

		await runRecapSettingsCommand(ctx, deps);

		expect(deps.setIdleOverride).not.toHaveBeenCalled();
	});
});
