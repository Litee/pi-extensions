import { describe, it, expect, vi } from "vitest";
import { colorize, extractUiSurface, type UiSurface } from "../src/ui-surface.js";

describe("colorize", () => {
	it("applies theme.fg when present", () => {
		const theme: UiSurface["theme"] = {
			fg: (alias, text) => `[${alias}:${text}]`,
		};
		expect(colorize(theme, "accent", "hello")).toBe("[accent:hello]");
		expect(colorize(theme, "muted", "world")).toBe("[muted:world]");
		expect(colorize(theme, "warning", "!")).toBe("[warning:!]");
	});

	it("returns raw text when theme is undefined", () => {
		expect(colorize(undefined, "accent", "hello")).toBe("hello");
	});

	it("returns raw text when theme has no fg function", () => {
		expect(colorize({}, "accent", "hello")).toBe("hello");
	});
});

describe("extractUiSurface", () => {
	const ui: UiSurface = { notify: vi.fn() };

	it("returns ui when ctx.hasUI = true", () => {
		expect(extractUiSurface({ hasUI: true, ui })).toBe(ui);
	});

	it("returns ui when ctx.ui.hasUI = true", () => {
		const ui2: UiSurface = { hasUI: true, notify: vi.fn() };
		expect(extractUiSurface({ ui: ui2 })).toBe(ui2);
	});

	it("returns ui when ctx.ui exists and both hasUI flags absent", () => {
		expect(extractUiSurface({ ui })).toBe(ui);
	});

	it("returns null when ctx.hasUI = false even if ctx.ui exists", () => {
		expect(extractUiSurface({ hasUI: false, ui })).toBeNull();
	});

	it("returns null when ctx is null", () => {
		expect(extractUiSurface(null)).toBeNull();
	});

	it("returns null when ctx is undefined", () => {
		expect(extractUiSurface(undefined)).toBeNull();
	});

	it("returns null when ctx has no ui property and hasUI is falsy", () => {
		expect(extractUiSurface({})).toBeNull();
	});

	it("returns null when ctx.hasUI is true but ctx.ui is undefined (any.ui ?? null fallback)", () => {
		// hasUI=true at the top level but no .ui bundle → hasUI=true, any.ui=undefined → returns null
		expect(extractUiSurface({ hasUI: true })).toBeNull();
	});
});
