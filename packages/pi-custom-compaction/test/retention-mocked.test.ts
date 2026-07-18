import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock findCutPoint before importing the module under test
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		findCutPoint: vi.fn(),
	};
});

import { rebuildPreparationWithKeepRecentTokens } from "../src/runtime/retention.js";
import { findCutPoint } from "@earendil-works/pi-coding-agent";
import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

const mockFindCutPoint = vi.mocked(findCutPoint);

function createPreparation(): SessionBeforeCompactEvent["preparation"] {
	return {
		firstKeptEntryId: "e1",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 222,
		previousSummary: "",
		fileOps: {
			read: new Set<string>(),
			written: new Set<string>(),
			edited: new Set<string>(),
		},
		settings: {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 20_000,
		},
	};
}

function makeEntries(count: number): SessionEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		type: "message",
		id: `e${i + 1}`,
		parentId: i === 0 ? null : `e${i}`,
		timestamp: `2026-04-04T00:00:${String(i).padStart(2, "0")}.000Z`,
		message: { role: "user", content: `msg-${i}`, timestamp: Date.now() },
	}));
}

beforeEach(() => {
	mockFindCutPoint.mockReset();
});

describe("rebuildPreparationWithKeepRecentTokens — mocked findCutPoint", () => {
	it("returns fallback when firstKeptEntry has no id (line 112 branch)", () => {
		// findCutPoint returns index 0 but the entry at that index has no id
		const entries = makeEntries(3);
		// Remove id from the first entry to trigger the fallback
		delete (entries[0] as { id?: string }).id;

		mockFindCutPoint.mockReturnValue({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const result = rebuildPreparationWithKeepRecentTokens(entries, createPreparation(), 1000);
		expect(result.fallbackReason).toMatch(/first kept entry is missing an id/);
		expect(result.preparation).toBeUndefined();
	});

	it("returns fallback when firstKeptEntry is undefined (line 112 branch)", () => {
		// findCutPoint returns an index beyond the array length
		const entries = makeEntries(3);

		mockFindCutPoint.mockReturnValue({
			firstKeptEntryIndex: 99, // beyond array bounds
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const result = rebuildPreparationWithKeepRecentTokens(entries, createPreparation(), 1000);
		expect(result.fallbackReason).toMatch(/first kept entry is missing an id/);
		expect(result.preparation).toBeUndefined();
	});

	it("returns fallback when historyEnd < boundaryStart (line 120 branch, isSplitTurn=true)", () => {
		// isSplitTurn=true with turnStartIndex < boundaryStart triggers the fallback
		mockFindCutPoint.mockReturnValue({
			firstKeptEntryIndex: 2,
			turnStartIndex: 0, // boundaryStart is 0, so historyEnd (turnStartIndex) < boundaryStart is false
			// Let's make it trigger: turnStartIndex must be < boundaryStart
			isSplitTurn: true,
		});

		// Actually, boundaryStart is 0 when no previous compaction.
		// We need turnStartIndex < 0 to trigger historyEnd < boundaryStart.
		// But turnStartIndex is -1 when isSplitTurn is true? No, isSplitTurn = !isUserMessage && turnStartIndex !== -1.
		// So if isSplitTurn is true, turnStartIndex !== -1.
		// We need turnStartIndex < boundaryStart. With boundaryStart=0, turnStartIndex would need to be < 0,
		// but turnStartIndex !== -1 for isSplitTurn=true. So turnStartIndex must be >= 0.
		// This means with boundaryStart=0, historyEnd >= boundaryStart always.
		// We need a previous compaction that sets boundaryStart > 0.

		// Let's use a previous compaction to set boundaryStart > 0
		const entriesWithCompaction = [
			{
				type: "message",
				id: "e0",
				parentId: null,
				timestamp: "2026-04-04T00:00:00.000Z",
				message: { role: "user", content: "A", timestamp: Date.now() },
			},
			{
				type: "compaction",
				id: "comp-1",
				parentId: "e0",
				timestamp: "2026-04-04T00:00:01.000Z",
				summary: "old",
				firstKeptEntryId: "e2",
				tokensBefore: 100,
				fromHook: false,
			} as unknown as SessionEntry,
			...makeEntries(3).map((e, i) => ({ ...e, id: `new-${i}`, parentId: "comp-1" })),
		] as SessionEntry[];

		// boundaryStart will be index of "e2" in the full array = 2 (the compaction is at index 1, e2 is at index 2)
		// Actually boundaryStart = firstKeptEntryIndex from compaction lookup = index of entry with id "e2"
		// In the full array: [e0, comp-1, new-0, new-1, new-2], "e2" doesn't exist.
		// So boundaryStart = prevCompactionIndex + 1 = 1 + 1 = 2
		// findCutPoint is called with (entries, 2, 5, keepRecentTokens)
		// If cutPoint returns turnStartIndex=1, then historyEnd=1 < boundaryStart=2 → fallback

		mockFindCutPoint.mockReturnValue({
			firstKeptEntryIndex: 4,
			turnStartIndex: 1, // < boundaryStart (2)
			isSplitTurn: true,
		});

		const result = rebuildPreparationWithKeepRecentTokens(entriesWithCompaction, createPreparation(), 1000);
		expect(result.fallbackReason).toMatch(/invalid cut point range/);
		expect(result.preparation).toBeUndefined();
	});

	it("returns fallback when historyEnd < boundaryStart with isSplitTurn=false (line 120 branch)", () => {
		// Need boundaryStart > 0 so firstKeptEntryIndex can be >= 0 but < boundaryStart
		const entriesWithCompaction = [
			{
				type: "message",
				id: "e0",
				parentId: null,
				timestamp: "2026-04-04T00:00:00.000Z",
				message: { role: "user", content: "A", timestamp: Date.now() },
			},
			{
				type: "compaction",
				id: "comp-1",
				parentId: "e0",
				timestamp: "2026-04-04T00:00:01.000Z",
				summary: "old",
				firstKeptEntryId: "e2",
				tokensBefore: 100,
				fromHook: false,
			} as unknown as SessionEntry,
			...makeEntries(3).map((e, i) => ({ ...e, id: `new-${i}`, parentId: "comp-1" })),
		] as SessionEntry[];

		// boundaryStart = index of entry with id "e2" → not found → prevCompactionIndex+1 = 2
		// firstKeptEntryIndex=1 is valid (has id) but < boundaryStart (2)
		mockFindCutPoint.mockReturnValue({
			firstKeptEntryIndex: 1, // valid entry with id, but < boundaryStart (2)
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const result = rebuildPreparationWithKeepRecentTokens(entriesWithCompaction, createPreparation(), 1000);
		expect(result.fallbackReason).toMatch(/invalid cut point range/);
		expect(result.preparation).toBeUndefined();
	});
});
