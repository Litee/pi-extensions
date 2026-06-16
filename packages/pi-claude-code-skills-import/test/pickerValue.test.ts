import { describe, expect, it, vi } from "vitest";

import { decoratePickerValue, type PickerValueTheme } from "../src/pickerValue.js";

// Marker-string fakes keep the assertions readable and make it obvious
// which branch of `decoratePickerValue` executed — we never care about the
// real ANSI escapes, only the composition (fg → bold → fallback).
const fakeTheme: PickerValueTheme = {
	fg: (color, text) => `FG:${color}(${text})`,
	bold: (text) => `BOLD(${text})`,
};

describe("decoratePickerValue", () => {
	it("renders 'enabled' in theme success colour when not selected (no bold wrap)", () => {
		const fallback = vi.fn((text: string, selected: boolean) => `FB(${text},${selected})`);
		const out = decoratePickerValue("enabled", false, fakeTheme, fallback);
		expect(out).toBe("FG:success(enabled)");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("wraps 'enabled' in bold when selected", () => {
		const fallback = vi.fn((text: string, selected: boolean) => `FB(${text},${selected})`);
		const out = decoratePickerValue("enabled", true, fakeTheme, fallback);
		expect(out).toBe("BOLD(FG:success(enabled))");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("renders 'disabled' in theme error colour, bolded when selected", () => {
		const fallback = vi.fn((text: string, selected: boolean) => `FB(${text},${selected})`);
		const out = decoratePickerValue("disabled", true, fakeTheme, fallback);
		expect(out).toBe("BOLD(FG:error(disabled))");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("renders 'disabled' in theme error colour when not selected (no bold wrap)", () => {
		const fallback = vi.fn((text: string, selected: boolean) => `FB(${text},${selected})`);
		const out = decoratePickerValue("disabled", false, fakeTheme, fallback);
		expect(out).toBe("FG:error(disabled)");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("delegates unknown value text to the fallback renderer verbatim", () => {
		const fallback = vi.fn((text: string, selected: boolean) => `FB(${text},${selected})`);
		const out = decoratePickerValue("other", false, fakeTheme, fallback);
		expect(out).toBe("FB(other,false)");
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(fallback).toHaveBeenCalledWith("other", false);
	});
});
