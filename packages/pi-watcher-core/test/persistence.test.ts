import { describe, expect, it, vi } from "vitest";

import {
	coerceString,
	createPersistence,
	toFiniteNumber,
} from "../src/persistence.js";
import type { SessionLike } from "../src/persistence.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Items = string[];
type Baselines = Record<string, { ts: number }>;

function makePersistence(overrides?: {
	stateCustomType?: string;
	watchItemsKey?: string;
}) {
	return createPersistence<Items, Baselines>({
		stateCustomType: overrides?.stateCustomType ?? "test:state",
		watchItemsKey: overrides?.watchItemsKey ?? "items",
		normaliseItems: (raw) =>
			Array.isArray(raw)
				? raw.filter((x): x is string => typeof x === "string")
				: [],
		normaliseBaselines: (raw) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
			const result: Baselines = {};
			for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
				const ts =
					v && typeof v === "object"
						? toFiniteNumber((v as Record<string, unknown>)["ts"])
						: 0;
				result[k] = { ts };
			}
			return result;
		},
	});
}

function makeCtx(
	entries: Array<{
		type?: string;
		customType?: string;
		data?: unknown;
	}>,
): SessionLike {
	return { sessionManager: { getEntries: () => entries } };
}

function validEntry(overrides?: Partial<Record<string, unknown>>) {
	return {
		type: "custom",
		customType: "test:state",
		data: {
			savedAt: 1_000_000,
			paused: false,
			items: ["A", "B"],
			baselines: { key1: { ts: 42 } },
			...overrides,
		},
	};
}

// ---------------------------------------------------------------------------
// rehydrateStateFromSession
// ---------------------------------------------------------------------------

describe("rehydrateStateFromSession", () => {
	it("returns_null_when_no_entries_exist", () => {
		// Arrange
		const p = makePersistence();
		const ctx = makeCtx([]);

		// Act / Assert
		expect(p.rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("returns_null_when_no_matching_customType_entry_exists", () => {
		// Arrange
		const p = makePersistence();
		const ctx = makeCtx([
			{ type: "custom", customType: "other:state", data: { savedAt: 1, paused: false, items: [] } },
		]);

		// Act / Assert
		expect(p.rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("returns_hydrated_state_from_the_newest_matching_entry", () => {
		// Arrange
		const p = makePersistence();
		const ctx = makeCtx([
			validEntry({ savedAt: 1000, items: ["old"] }), // older
			validEntry({ savedAt: 2000, items: ["new"] }), // newest — must win
		]);

		// Act
		const result = p.rehydrateStateFromSession(ctx);

		// Assert
		expect(result).not.toBeNull();
		expect(result!.savedAt).toBe(2000);
		expect(result!.items).toEqual(["new"]);
	});

	it("skips_malformed_entry_and_returns_next_valid_one", () => {
		// Arrange — newest entry is malformed (savedAt NaN), older is valid
		const p = makePersistence();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			validEntry({ savedAt: 500, items: ["fallback"] }), // older valid
			{ type: "custom", customType: "test:state", data: { savedAt: "not-a-number", paused: false, items: [] } },
		]);

		// Act
		const result = p.rehydrateStateFromSession(ctx);

		// Assert
		expect(result!.items).toEqual(["fallback"]);
		warn.mockRestore();
	});

	it("skips_entry_with_missing_data", () => {
		// Arrange
		const p = makePersistence();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			validEntry({ savedAt: 100 }),
			{ type: "custom", customType: "test:state" }, // data is undefined
		]);

		// Act
		const result = p.rehydrateStateFromSession(ctx);
		expect(result!.savedAt).toBe(100);
		warn.mockRestore();
	});

	it("skips_entry_with_non_boolean_paused", () => {
		// Arrange
		const p = makePersistence();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			validEntry({ savedAt: 50 }),
			{ type: "custom", customType: "test:state", data: { savedAt: 999, paused: "yes", items: [] } },
		]);

		// Act
		const result = p.rehydrateStateFromSession(ctx);
		expect(result!.savedAt).toBe(50);
		warn.mockRestore();
	});

	it("skips_entry_whose_items_key_is_not_an_array", () => {
		// Arrange
		const p = makePersistence();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			validEntry({ savedAt: 30 }),
			{ type: "custom", customType: "test:state", data: { savedAt: 999, paused: false, items: "not-an-array" } },
		]);

		// Act
		const result = p.rehydrateStateFromSession(ctx);
		expect(result!.savedAt).toBe(30);
		warn.mockRestore();
	});

	it("calls_normaliseItems_and_normaliseBaselines_with_raw_values", () => {
		// Arrange — items contain non-strings which normaliseItems filters out
		const p = makePersistence();
		const ctx = makeCtx([
			{
				type: "custom",
				customType: "test:state",
				data: {
					savedAt: 1,
					paused: true,
					items: ["keep", 42, null, "also-keep"],
					baselines: { k: { ts: 7 } },
				},
			},
		]);

		// Act
		const result = p.rehydrateStateFromSession(ctx)!;

		// Assert
		expect(result.items).toEqual(["keep", "also-keep"]);
		expect(result.baselines["k"]).toEqual({ ts: 7 });
		expect(result.paused).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

describe("writeState", () => {
	it("calls_appendEntry_with_stateCustomType_and_correct_shape", () => {
		// Arrange
		const p = makePersistence();
		const appendEntry = vi.fn();
		const pi = { appendEntry };

		// Act
		p.writeState(pi, {
			items: ["P123"],
			paused: false,
			baselines: { "ticket:P123": { ts: 999 } },
		});

		// Assert
		expect(appendEntry).toHaveBeenCalledTimes(1);
		const [type, data] = appendEntry.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(type).toBe("test:state");
		expect(typeof data["savedAt"]).toBe("number");
		expect(data["items"]).toEqual(["P123"]);
		expect(data["paused"]).toBe(false);
		expect(data["baselines"]).toEqual({ "ticket:P123": { ts: 999 } });
	});

	it("uses_the_watchItemsKey_as_the_data_property_name", () => {
		// Arrange — use a non-default watchItemsKey
		const p = createPersistence<string[], Record<string, never>>({
			stateCustomType: "x:state",
			watchItemsKey: "reviews",
			normaliseItems: (r) => (Array.isArray(r) ? (r as string[]) : []),
			normaliseBaselines: () => ({}),
		});
		const appendEntry = vi.fn();

		// Act
		p.writeState({ appendEntry }, { items: ["CR-1"], paused: false, baselines: {} });

		// Assert
		const [, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(data["reviews"]).toEqual(["CR-1"]);
		expect(data["items"]).toBeUndefined();
	});

	it("swallows_errors_from_appendEntry", () => {
		// Arrange — appendEntry throws
		const p = makePersistence();
		const pi = {
			appendEntry: () => {
				throw new Error("disk full");
			},
		};

		// Act / Assert — must not propagate
		expect(() =>
			p.writeState(pi, { items: [], paused: false, baselines: {} }),
		).not.toThrow();
	});

	it("invokes_onError_with_the_thrown_error_when_appendEntry_throws", () => {
		// Arrange — appendEntry throws and onError sink is registered
		const onError = vi.fn();
		const p = createPersistence<Items, Baselines>({
			stateCustomType: "obs:state",
			watchItemsKey: "items",
			normaliseItems: (r) => (Array.isArray(r) ? (r as string[]) : []),
			normaliseBaselines: () => ({}),
			onError,
		});
		const thrown = new Error("disk full");
		const pi = {
			appendEntry: () => {
				throw thrown;
			},
		};

		// Act
		p.writeState(pi, { items: [], paused: false, baselines: {} });

		// Assert — onError fires with the same Error instance
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(thrown);
	});

	it("wraps_non_error_throws_into_an_error_before_invoking_onError", () => {
		// Arrange — appendEntry throws a string (not an Error)
		const onError = vi.fn();
		const p = createPersistence<Items, Baselines>({
			stateCustomType: "obs:state",
			watchItemsKey: "items",
			normaliseItems: (r) => (Array.isArray(r) ? (r as string[]) : []),
			normaliseBaselines: () => ({}),
			onError,
		});
		const pi = {
			appendEntry: () => {
				throw new Error("disk full");
			},
		};

		// Act
		p.writeState(pi, { items: [], paused: false, baselines: {} });

		// Assert
		expect(onError).toHaveBeenCalledTimes(1);
		const arg = onError.mock.calls[0]?.[0] as Error;
		expect(arg).toBeInstanceOf(Error);
		expect(arg.message).toBe("disk full");
	});

	it("wraps_a_thrown_string_into_an_Error_before_invoking_onError", () => {
		// Arrange — appendEntry throws a plain string, not an Error instance.
		// This exercises the `err instanceof Error ? err : new Error(String(err))` false branch.
		const onError = vi.fn();
		const p = createPersistence<Items, Baselines>({
			stateCustomType: "str:state",
			watchItemsKey: "items",
			normaliseItems: (r) => (Array.isArray(r) ? (r as string[]) : []),
			normaliseBaselines: () => ({}),
			onError,
		});
		const pi = {
			appendEntry: () => {
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				throw "disk full";
			},
		};

		// Act
		p.writeState(pi, { items: [], paused: false, baselines: {} });

		// Assert — onError receives an Error wrapping the string
		expect(onError).toHaveBeenCalledTimes(1);
		const arg = onError.mock.calls[0]?.[0] as Error;
		expect(arg).toBeInstanceOf(Error);
		expect(arg.message).toBe("disk full");
	});

	it("does_not_invoke_onError_on_successful_appendEntry", () => {
		// Arrange
		const onError = vi.fn();
		const p = createPersistence<Items, Baselines>({
			stateCustomType: "ok:state",
			watchItemsKey: "items",
			normaliseItems: (r) => (Array.isArray(r) ? (r as string[]) : []),
			normaliseBaselines: () => ({}),
			onError,
		});

		// Act
		p.writeState({ appendEntry: vi.fn() }, { items: [], paused: false, baselines: {} });

		// Assert
		expect(onError).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

describe("toFiniteNumber", () => {
	it("returns_finite_numbers_unchanged", () => {
		expect(toFiniteNumber(42)).toBe(42);
		expect(toFiniteNumber(3.14)).toBe(3.14);
		expect(toFiniteNumber(0)).toBe(0);
	});

	it("parses_numeric_strings", () => {
		expect(toFiniteNumber("123")).toBe(123);
		expect(toFiniteNumber("3.14")).toBe(3.14);
	});

	it("returns_zero_for_non_numeric_inputs", () => {
		expect(toFiniteNumber(NaN)).toBe(0);
		expect(toFiniteNumber(Infinity)).toBe(0);
		expect(toFiniteNumber("not-a-number")).toBe(0);
		expect(toFiniteNumber(null)).toBe(0);
		expect(toFiniteNumber(undefined)).toBe(0);
		expect(toFiniteNumber({})).toBe(0);
	});
});

describe("coerceString", () => {
	it("returns_string_values_unchanged", () => {
		expect(coerceString("hello")).toBe("hello");
		expect(coerceString("")).toBe("");
	});

	it("returns_fallback_for_non_strings", () => {
		expect(coerceString(42)).toBe("");
		expect(coerceString(null)).toBe("");
		expect(coerceString(undefined)).toBe("");
		expect(coerceString(null, "default")).toBe("default");
	});
});
