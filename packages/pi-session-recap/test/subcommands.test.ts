/**
 * Unit tests for `dispatchRecap` — the pure classifier for `/recap` args.
 *
 * Note: `/recap` no longer accepts any subcommands. Configuration lives
 * behind the dedicated `/recap-settings` TUI command.
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

	it("treats the legacy `status` token as unknown (now lives behind /recap-settings)", () => {
		expect(dispatchRecap("status")).toEqual({ kind: "unknown", payload: "status" });
	});

	it("treats the legacy `help` token as unknown (subcommand removed)", () => {
		expect(dispatchRecap("help")).toEqual({ kind: "unknown", payload: "help" });
	});

	it("classifies anything else as unknown, returning the raw subcommand token as payload", () => {
		expect(dispatchRecap("banana")).toEqual({ kind: "unknown", payload: "banana" });
	});

	it("preserves the lower-cased trimmed token in the unknown payload", () => {
		expect(dispatchRecap("  Banana Split  ")).toEqual({ kind: "unknown", payload: "banana split" });
	});
});
