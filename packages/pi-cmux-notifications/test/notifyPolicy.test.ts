/**
 * Unit tests for the agent_end notification policy.
 */

import { describe, expect, it } from "vitest";

import {
	resolveNotifyOnDoneMode,
	shouldNotifyOnDone,
} from "../src/notifyPolicy.js";

describe("resolveNotifyOnDoneMode", () => {
	it("defaults to smart when env var is absent", () => {
		expect(resolveNotifyOnDoneMode({})).toBe("smart");
	});

	it("defaults to smart when env var is empty/whitespace", () => {
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "" })).toBe("smart");
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "   " })).toBe("smart");
	});

	it("accepts always / never / smart case-insensitively", () => {
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "always" })).toBe("always");
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "ALWAYS" })).toBe("always");
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "Never" })).toBe("never");
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "smart" })).toBe("smart");
	});

	it("falls back to smart for unknown values", () => {
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "loud" })).toBe("smart");
		expect(resolveNotifyOnDoneMode({ PI_CMUX_NOTIFY_ON_DONE: "1" })).toBe("smart");
	});
});

describe("shouldNotifyOnDone", () => {
	it("never is always silent regardless of focus state", () => {
		expect(shouldNotifyOnDone("never", false, false)).toBe(false);
		expect(shouldNotifyOnDone("never", false, true)).toBe(false);
		expect(shouldNotifyOnDone("never", true, false)).toBe(false);
		expect(shouldNotifyOnDone("never", true, true)).toBe(false);
	});

	it("always fires regardless of focus state", () => {
		expect(shouldNotifyOnDone("always", false, false)).toBe(true);
		expect(shouldNotifyOnDone("always", false, true)).toBe(true);
		expect(shouldNotifyOnDone("always", true, false)).toBe(true);
		expect(shouldNotifyOnDone("always", true, true)).toBe(true);
	});

	it("smart fires when focus reporting is unavailable (no signal)", () => {
		// No TTY → can't tell where the user is → err on the side of pinging.
		expect(shouldNotifyOnDone("smart", false, false)).toBe(true);
		expect(shouldNotifyOnDone("smart", false, true)).toBe(true);
	});

	it("smart fires when the pane has been tabbed away from", () => {
		expect(shouldNotifyOnDone("smart", true, true)).toBe(true);
	});

	it("smart stays silent when the user is actively on the pane", () => {
		// The whole point: red circle is enough, no need for an OS interrupt.
		expect(shouldNotifyOnDone("smart", true, false)).toBe(false);
	});
});
