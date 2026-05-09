/**
 * Unit tests for `dispatchRecap` — the pure classifier for `/recap` args.
 */

import { describe, expect, it } from "vitest";

import { dispatchRecap } from "../src/subcommands.js";

describe("dispatchRecap", () => {
	it("classifies empty args as generate", () => {
		expect(dispatchRecap("")).toEqual({ kind: "generate" });
	});

	it("classifies whitespace-only args as generate", () => {
		expect(dispatchRecap("   ")).toEqual({ kind: "generate" });
	});

	it("classifies `status` as status", () => {
		expect(dispatchRecap("status")).toEqual({ kind: "status" });
	});

	it("normalises case and whitespace around `status`", () => {
		expect(dispatchRecap("  STATUS  ")).toEqual({ kind: "status" });
	});

	it("classifies `help` as help", () => {
		expect(dispatchRecap("help")).toEqual({ kind: "help" });
	});

	it("normalises case around `help`", () => {
		expect(dispatchRecap("Help")).toEqual({ kind: "help" });
	});

	it("classifies anything else as unknown, returning the raw subcommand token as payload", () => {
		expect(dispatchRecap("banana")).toEqual({ kind: "unknown", payload: "banana" });
	});

	it("preserves the lower-cased trimmed token in the unknown payload", () => {
		expect(dispatchRecap("  Banana Split  ")).toEqual({ kind: "unknown", payload: "banana split" });
	});
});
