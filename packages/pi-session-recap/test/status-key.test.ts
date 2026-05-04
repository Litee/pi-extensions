// Regression test for pi-session-recap#0002: the ctx.ui.setStatus
// namespace key for this extension must be prefixed with the full
// package name so keys in the shared pi status-row namespace are
// unambiguously attributable to their owning package.

import { describe, expect, it } from "vitest";

import { STATUS_KEY } from "../src/index.js";

describe("STATUS_KEY (#0002)", () => {
	it("is prefixed with the package name", () => {
		expect(STATUS_KEY).toBe("pi-session-recap");
	});

	it("is not the pre-#0002 bare value", () => {
		// Guardrail so a future refactor cannot silently re-introduce a
		// package-agnostic key.
		expect(STATUS_KEY).not.toBe("session-recap");
	});
});
