import { describe, expect, it } from "vitest";

import { countLines, describeBashFailure, EMPTY_SENTINELS, formatDuration } from "../src/helpers.js";

describe("formatDuration", () => {
	it("renders zero as 0.0s", () => {
		expect(formatDuration(0)).toBe("0.0s");
	});

	it("renders sub-second values to one decimal", () => {
		expect(formatDuration(1234)).toBe("1.2s");
		expect(formatDuration(499)).toBe("0.5s");
	});

	it("renders minute-scale values to one decimal", () => {
		expect(formatDuration(59999)).toBe("60.0s");
	});

	it("renders hour-scale values without switching units", () => {
		// Duration is always in seconds; the formatter intentionally does not
		// switch units (see upstream bash.js formatter).
		expect(formatDuration(3_600_000)).toBe("3600.0s");
	});

	it("clamps negative values (clock-skew guard) to 0.0s", () => {
		expect(formatDuration(-500)).toBe("0.0s");
		expect(formatDuration(-1)).toBe("0.0s");
	});
});

describe("countLines", () => {
	it("returns 0 for empty input", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("   \n\n  \n")).toBe(0);
	});

	it("returns 0 for each empty sentinel", () => {
		for (const sentinel of EMPTY_SENTINELS) {
			expect(countLines(sentinel)).toBe(0);
		}
	});

	it("counts non-blank lines in multi-line output", () => {
		expect(countLines("a\nb\nc")).toBe(3);
	});

	it("ignores a single trailing newline", () => {
		expect(countLines("a\nb\n")).toBe(2);
	});

	it("ignores multiple trailing blank lines", () => {
		expect(countLines("a\nb\n\n\n")).toBe(2);
	});

	it("handles CRLF line terminators", () => {
		expect(countLines("a\r\nb\r\nc\r\n")).toBe(3);
	});

	it("counts a single match as 1", () => {
		expect(countLines("src/index.ts:1: foo")).toBe(1);
	});
});

describe("EMPTY_SENTINELS", () => {
	it("includes the three built-in tool sentinels (grep/find/ls)", () => {
		expect(EMPTY_SENTINELS.has("No matches found")).toBe(true);
		expect(EMPTY_SENTINELS.has("No files found matching pattern")).toBe(true);
		expect(EMPTY_SENTINELS.has("(empty directory)")).toBe(true);
	});

	it("does not accidentally include non-sentinel strings", () => {
		expect(EMPTY_SENTINELS.has("")).toBe(false);
		expect(EMPTY_SENTINELS.has("no matches found")).toBe(false); // case-sensitive
		expect(EMPTY_SENTINELS.has("No files found")).toBe(false); // not a prefix match
	});
});

describe("describeBashFailure", () => {
	it("parses a non-zero exit from the built-in bash.js sentinel", () => {
		expect(describeBashFailure("stderr...\n\nCommand exited with code 1")).toBe("exit 1");
		expect(describeBashFailure("Command exited with code 137")).toBe("exit 137");
	});

	it("parses negative exit codes", () => {
		expect(describeBashFailure("Command exited with code -1")).toBe("exit -1");
	});

	it("parses the timeout sentinel with its seconds value", () => {
		expect(describeBashFailure("partial\nCommand timed out after 30 seconds")).toBe("timeout 30s");
	});

	it("recognises the abort sentinel", () => {
		expect(describeBashFailure("partial...\nCommand aborted")).toBe("aborted");
	});

	it("falls back to 'failed' for generic error text", () => {
		expect(describeBashFailure("some generic error text")).toBe("failed");
		expect(describeBashFailure("")).toBe("failed");
	});
});
