import { describe, expect, it } from "vitest";

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import type { Ec2Watch } from "../src/types.js";
import {
	buildRows,
	formatDetailIdentityLine,
	formatRowLine,
	formatTimeLeft,
	rowStyle,
	type RowTheme,
} from "../src/ui/watchesModel.js";

const plainTheme: RowTheme = { fg: (_c, t) => t };
const taggedTheme: RowTheme = { fg: (c, t) => `[${c}]${t}[/]` };

function watch(
	overrides: Partial<Ec2Watch> & { watchId: string; instanceId: string },
): Ec2Watch {
	return {
		profile: "p",
		region: undefined,
		stopOnStopped: false,
		timeoutAt: undefined,
		addedAt: 1,
		lastPolledAt: undefined,
		baseline: { state: "running" },
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// rowStyle
// ---------------------------------------------------------------------------

describe("rowStyle", () => {
	it("terminal → success regardless of errors", () => {
		expect(rowStyle({ isTerminal: true, hasErrors: false })).toBe("success");
		expect(rowStyle({ isTerminal: true, hasErrors: true })).toBe("success");
	});

	it("non-terminal + errors → error", () => {
		expect(rowStyle({ isTerminal: false, hasErrors: true })).toBe("error");
	});

	it("non-terminal + no errors → warning", () => {
		expect(rowStyle({ isTerminal: false, hasErrors: false })).toBe("warning");
	});
});

// ---------------------------------------------------------------------------
// formatTimeLeft
// ---------------------------------------------------------------------------

describe("formatTimeLeft", () => {
	it("returns '-' when undefined", () => {
		expect(formatTimeLeft(undefined, 0)).toBe("-");
	});

	it("returns 'expired' when in the past", () => {
		expect(formatTimeLeft(5, 100)).toBe("expired");
	});

	it("returns Ns left for sub-minute futures", () => {
		expect(formatTimeLeft(30_000, 0)).toBe("30s left");
	});

	it("returns Nm left for sub-hour futures", () => {
		expect(formatTimeLeft(5 * 60_000, 0)).toBe("5m left");
	});

	it("returns Nh left for hour-plus futures", () => {
		expect(formatTimeLeft(60 * 60_000, 0)).toBe("1h left");
	});
});

// ---------------------------------------------------------------------------
// buildRows
// ---------------------------------------------------------------------------

describe("buildRows", () => {
	it("non-terminal before terminal", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", instanceId: "i-aaaaaaaa" }),
			b: watch({ watchId: "b", instanceId: "i-bbbbbbbb", terminal: true }),
		});
		expect(rows[0]!.instanceId).toBe("i-aaaaaaaa");
		expect(rows[1]!.instanceId).toBe("i-bbbbbbbb");
	});

	it("newest addedAt first within non-terminal group", () => {
		const rows = buildRows({
			old: watch({ watchId: "old", instanceId: "i-00000001", addedAt: 1 }),
			new_: watch({ watchId: "new_", instanceId: "i-00000002", addedAt: 2 }),
		});
		expect(rows[0]!.instanceId).toBe("i-00000002");
	});

	it("maps state from baseline", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", instanceId: "i-aaaaaaaa", baseline: { state: "stopping" } }),
		});
		expect(rows[0]!.state).toBe("stopping");
	});

	it("state is '?' when no baseline", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", instanceId: "i-aaaaaaaa", baseline: undefined }),
		});
		expect(rows[0]!.state).toBe("?");
	});

	it("disambiguates rows with duplicate display names", () => {
		const rows = buildRows({
			a: watch({ watchId: "aaaa", instanceId: "i-aaaaaaaa" }),
			b: watch({ watchId: "bbbb", instanceId: "i-aaaaaaaa" }),
		});
		expect(rows[0]!.displayName).not.toBe(rows[1]!.displayName);
		expect(rows[0]!.displayName).toContain("i-aaaaaaaa");
	});

	it("marks hasErrors when consecutiveErrors >= threshold", () => {
		const rows = buildRows({
			a: watch({
				watchId: "a",
				instanceId: "i-aaaaaaaa",
				consecutiveErrors: DEFAULT_POLL_ERROR_THRESHOLD,
			}),
		});
		expect(rows[0]!.hasErrors).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatRowLine
// ---------------------------------------------------------------------------

describe("formatRowLine", () => {
	it("selected row gets accent colour", () => {
		const r = buildRows({ a: watch({ watchId: "a", instanceId: "i-aaaaaaaa" }) })[0]!;
		const line = formatRowLine(r, true, 20, taggedTheme);
		expect(line).toContain("[accent]");
	});

	it("terminal row is wrapped in dim", () => {
		const r = buildRows({
			a: watch({ watchId: "a", instanceId: "i-aaaaaaaa", terminal: true }),
		})[0]!;
		const line = formatRowLine(r, false, 20, taggedTheme);
		expect(line).toContain("[dim]");
	});

	it("shows time left", () => {
		const r = buildRows({
			a: watch({ watchId: "a", instanceId: "i-aaaaaaaa", timeoutAt: 60_000 }),
		})[0]!;
		const line = formatRowLine(r, false, 20, plainTheme, 0);
		expect(line).toContain("left");
	});
});

// ---------------------------------------------------------------------------
// instanceType plumbing
// ---------------------------------------------------------------------------

describe("buildRows instanceType", () => {
	it("propagates instanceType from baseline", () => {
		const rows = buildRows({
			a: watch({
				watchId: "a",
				instanceId: "i-aaaaaaaa",
				baseline: { state: "running", instanceType: "t3.medium" },
			}),
		});
		expect(rows[0]!.instanceType).toBe("t3.medium");
	});

	it("leaves instanceType undefined when baseline lacks it (back-compat)", () => {
		const rows = buildRows({
			a: watch({
				watchId: "a",
				instanceId: "i-aaaaaaaa",
				baseline: { state: "running" },
			}),
		});
		expect(rows[0]!.instanceType).toBeUndefined();
	});

	it("leaves instanceType undefined when baseline is absent", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", instanceId: "i-aaaaaaaa", baseline: undefined }),
		});
		expect(rows[0]!.instanceType).toBeUndefined();
	});
});

describe("formatDetailIdentityLine", () => {
	function row(overrides: Partial<ReturnType<typeof buildRows>[number]> = {}) {
		return buildRows({
			a: watch({
				watchId: "a",
				instanceId: "i-aaaaaaaa",
				profile: "p",
				region: "us-east-1",
				baseline: { state: "running", instanceType: "t3.medium" },
			}),
		}).map((r) => ({ ...r, ...overrides }))[0]!;
	}

	it("includes Type segment when instanceType is defined", () => {
		const line = formatDetailIdentityLine(row());
		expect(line).toContain("Type: t3.medium");
		expect(line).toContain("Profile: p");
		expect(line).toContain("Region: us-east-1");
	});

	it("omits Type segment entirely when instanceType is undefined", () => {
		const line = formatDetailIdentityLine(row({ instanceType: undefined }));
		expect(line).not.toContain("Type:");
		expect(line).not.toContain("undefined");
		expect(line).not.toMatch(/\|\s*\|/);
		expect(line).toContain("Profile: p");
	});

	it("falls back to 'default' region when undefined", () => {
		const line = formatDetailIdentityLine(row({ region: undefined }));
		expect(line).toContain("Region: default");
	});
});
