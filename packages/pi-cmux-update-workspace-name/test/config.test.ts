import { describe, expect, it } from "vitest";

import {
	resolveRenameWorkspace,
	resolveStatusKey,
	resolveSummaryModelOverride,
} from "../src/config.js";

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

describe("resolveRenameWorkspace", () => {
	it("defaults to true when unset", () => {
		expect(resolveRenameWorkspace({})).toBe(true);
	});

	it.each(["0", "false", "FALSE", "No", "nO"])("treats %s as disabled", (v) => {
		expect(resolveRenameWorkspace({ PI_CMUX_RENAME_WORKSPACE: v })).toBe(false);
	});

	it.each(["1", "true", "yes", "anything-else", ""])(
		"treats %s as enabled",
		(v) => {
			expect(resolveRenameWorkspace({ PI_CMUX_RENAME_WORKSPACE: v })).toBe(true);
		},
	);
});

describe("resolveSummaryModelOverride", () => {
	it("returns undefined when unset", () => {
		expect(resolveSummaryModelOverride({})).toBeUndefined();
	});

	it("returns undefined when missing colon", () => {
		expect(resolveSummaryModelOverride({ PI_CMUX_SUMMARY_MODEL: "anthropic" })).toBeUndefined();
	});

	it("splits 'provider:modelId' into its parts", () => {
		expect(
			resolveSummaryModelOverride({
				PI_CMUX_SUMMARY_MODEL: "anthropic:claude-sonnet-4",
			}),
		).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
	});

	it("preserves colons inside the modelId portion", () => {
		expect(
			resolveSummaryModelOverride({
				PI_CMUX_SUMMARY_MODEL: "openrouter:foo/bar:tag",
			}),
		).toEqual({ provider: "openrouter", modelId: "foo/bar:tag" });
	});

	it("returns undefined when either side of the colon is blank", () => {
		expect(
			resolveSummaryModelOverride({ PI_CMUX_SUMMARY_MODEL: ":claude" }),
		).toBeUndefined();
		expect(
			resolveSummaryModelOverride({ PI_CMUX_SUMMARY_MODEL: "anthropic:" }),
		).toBeUndefined();
	});
});
