import { describe, expect, it } from "vitest";

import { resolveStatusKey } from "../src/config.js";

describe("resolveStatusKey", () => {
	it("defaults to 'pi' when env is empty", () => {
		expect(resolveStatusKey({})).toBe("pi");
	});

	it("reads PI_CMUX_STATUS_KEY when set", () => {
		expect(resolveStatusKey({ PI_CMUX_STATUS_KEY: "myproj" })).toBe("myproj");
	});

	it("falls back to default for blank / whitespace-only values", () => {
		expect(resolveStatusKey({ PI_CMUX_STATUS_KEY: "" })).toBe("pi");
		expect(resolveStatusKey({ PI_CMUX_STATUS_KEY: "   " })).toBe("pi");
	});
});
