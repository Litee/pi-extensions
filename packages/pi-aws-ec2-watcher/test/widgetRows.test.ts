import { describe, expect, it } from "vitest";

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import type { Ec2Watch } from "../src/types.js";
import {
	buildWidgetEntries,
	renderEntryLine,
	watchStyle,
	type WidgetEntry,
	type WidgetTheme,
} from "../src/ui/widgetRows.js";

const plainTheme: WidgetTheme = { fg: (_c, t) => t };
const taggedTheme: WidgetTheme = { fg: (c, t) => `[${c}]${t}[/]` };

function makeWatch(overrides: Partial<Ec2Watch> & { watchId: string }): Ec2Watch {
	return {
		instanceId: "i-1234abcd",
		profile: "p",
		region: undefined,
		stopOnStopped: false,
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

function makeEntry(overrides: Partial<WidgetEntry> = {}): WidgetEntry {
	return {
		instanceId: "i-1234abcd",
		displayName: "i-1234abcd",
		state: "?",
		timeoutAt: undefined,
		addedAt: 1_000,
		hasErrors: false,
		terminal: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// watchStyle
// ---------------------------------------------------------------------------

describe("watchStyle", () => {
	it("non-terminal with errors → 'error'", () => {
		expect(watchStyle(makeEntry({ terminal: false, hasErrors: true }))).toBe("error");
	});

	it("non-terminal without errors → 'warning'", () => {
		expect(watchStyle(makeEntry({ terminal: false, hasErrors: false }))).toBe("warning");
	});

	it("terminal → 'success' regardless of hasErrors", () => {
		expect(watchStyle(makeEntry({ terminal: true, hasErrors: false }))).toBe("success");
		expect(watchStyle(makeEntry({ terminal: true, hasErrors: true }))).toBe("success");
	});
});

// ---------------------------------------------------------------------------
// buildWidgetEntries
// ---------------------------------------------------------------------------

describe("buildWidgetEntries", () => {
	it("includes terminal watches after non-terminal ones", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", instanceId: "i-aaaaaaaa" }),
			b: makeWatch({ watchId: "b", instanceId: "i-bbbbbbbb", terminal: true }),
		});
		expect(entries).toHaveLength(2);
		expect(entries[0]!.instanceId).toBe("i-aaaaaaaa");
		expect(entries[1]!.instanceId).toBe("i-bbbbbbbb");
	});

	it("sorts non-terminal newest addedAt first", () => {
		const entries = buildWidgetEntries({
			old: makeWatch({ watchId: "old", instanceId: "i-00000001", addedAt: 1 }),
			new_: makeWatch({ watchId: "new_", instanceId: "i-00000002", addedAt: 2 }),
		});
		expect(entries[0]!.instanceId).toBe("i-00000002");
		expect(entries[1]!.instanceId).toBe("i-00000001");
	});

	it("maps baseline state correctly", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", instanceId: "i-aaaaaaaa", baseline: { state: "running" } }),
			b: makeWatch({ watchId: "b", instanceId: "i-bbbbbbbb", baseline: { state: "stopped" } }),
			c: makeWatch({ watchId: "c", instanceId: "i-cccccccc", baseline: undefined }),
		});
		const byId = Object.fromEntries(entries.map((e) => [e.instanceId, e]));
		expect(byId["i-aaaaaaaa"]?.state).toBe("running");
		expect(byId["i-bbbbbbbb"]?.state).toBe("stopped");
		expect(byId["i-cccccccc"]?.state).toBe("?");
	});

	it("marks hasErrors when consecutiveErrors >= threshold", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", consecutiveErrors: DEFAULT_POLL_ERROR_THRESHOLD }),
		});
		expect(entries[0]!.hasErrors).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// renderEntryLine
// ---------------------------------------------------------------------------

describe("renderEntryLine", () => {
	it("renders terminal entry as dim", () => {
		const entry = makeEntry({ terminal: true, state: "terminated" });
		const line = renderEntryLine(entry, 20, taggedTheme, 0);
		expect(line).toContain("[dim]");
	});

	it("renders non-terminal entry without dim wrapper", () => {
		const entry = makeEntry({ terminal: false });
		const line = renderEntryLine(entry, 20, plainTheme, 0);
		expect(line).not.toContain("[dim]");
	});

	it("applies warning colour to state for non-terminal", () => {
		const entry = makeEntry({ terminal: false, hasErrors: false });
		const line = renderEntryLine(entry, 20, taggedTheme, 0);
		expect(line).toContain("[warning]");
	});

	it("shows time left as '-' when no timeout", () => {
		const entry = makeEntry({ timeoutAt: undefined });
		const line = renderEntryLine(entry, 20, plainTheme, 0);
		expect(line).toContain("-");
	});

	it("shows 'expired' when timeoutAt is in the past", () => {
		const entry = makeEntry({ timeoutAt: 500 });
		const line = renderEntryLine(entry, 20, plainTheme, 1_000);
		expect(line).toContain("expired");
	});
});
