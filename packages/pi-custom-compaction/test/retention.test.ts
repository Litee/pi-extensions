import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatSummaryRetention, rebuildPreparationWithKeepRecentTokens, resolveSummaryRetention } from "../src/runtime/retention.js";

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

function createBranchEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-04-04T00:00:00.000Z",
			message: {
				role: "user",
				content: "A".repeat(120),
				timestamp: Date.now(),
			},
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-04-04T00:00:01.000Z",
			message: {
				role: "assistant",
				provider: "openai",
				model: "gpt-test",
				stopReason: "stop",
				content: [
					{ type: "text", text: "done" },
					{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/a.ts" } },
				],
				timestamp: Date.now(),
			},
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-04-04T00:00:02.000Z",
			message: {
				role: "user",
				content: "B".repeat(120),
				timestamp: Date.now(),
			},
		},
		{
			type: "message",
			id: "e4",
			parentId: "e3",
			timestamp: "2026-04-04T00:00:03.000Z",
			message: {
				role: "assistant",
				provider: "openai",
				model: "gpt-test",
				stopReason: "stop",
				content: [{ type: "text", text: "result" }],
				timestamp: Date.now(),
			},
		},
	] as SessionEntry[];
}

describe("formatSummaryRetention", () => {
	it("formats percent and token modes", () => {
		assert.equal(formatSummaryRetention({ mode: "percent", value: 20 }), "keep 20%");
		assert.equal(formatSummaryRetention({ mode: "tokens", value: 30000 }), "keep 30000t");
		assert.equal(formatSummaryRetention(undefined), undefined);
	});
});

describe("resolveSummaryRetention", () => {
	it("returns empty result when summaryRetention is not configured", () => {
		assert.deepEqual(
			resolveSummaryRetention(undefined, {
				sessionContextWindow: 200000,
				summaryModelContextWindow: 200000,
				reserveTokens: 16384,
			}),
			{},
		);
	});

	it("resolves percent mode against min(session, summary) context windows", () => {
		const result = resolveSummaryRetention(
			{ mode: "percent", value: 20 },
			{ sessionContextWindow: 200000, summaryModelContextWindow: 100000, reserveTokens: 1000 },
		);
		assert.equal(result.fallbackReason, undefined);
		assert.equal(result.resolution?.keepRecentTokens, 20000);
	});

	it("returns fallback when percent mode cannot resolve context windows", () => {
		const result = resolveSummaryRetention(
			{ mode: "percent", value: 20 },
			{ sessionContextWindow: undefined, summaryModelContextWindow: 100000, reserveTokens: 1000 },
		);
		assert.match(result.fallbackReason ?? "", /needs both session and summary model context windows/);
	});

	it("returns fallback when computed keep budget exceeds available tokens", () => {
		const result = resolveSummaryRetention(
			{ mode: "tokens", value: 70000 },
			{ sessionContextWindow: 80000, summaryModelContextWindow: 90000, reserveTokens: 20000 },
		);
		assert.match(result.fallbackReason ?? "", /exceeds available budget/);
	});
});

describe("rebuildPreparationWithKeepRecentTokens", () => {
	it("rebuilds preparation with new split-turn boundaries and file ops", () => {
		const result = rebuildPreparationWithKeepRecentTokens(createBranchEntries(), createPreparation(), 1);
		assert.equal(result.fallbackReason, undefined);
		assert.equal(result.preparation?.firstKeptEntryId, "e4");
		assert.equal(result.preparation?.isSplitTurn, true);
		assert.equal(result.preparation?.messagesToSummarize.length, 2);
		assert.equal(result.preparation?.turnPrefixMessages.length, 1);
		assert.equal(result.preparation?.settings.keepRecentTokens, 1);
		assert.deepEqual([...(result.preparation?.fileOps.read ?? [])], ["src/a.ts"]);
	});
});

describe("rebuildPreparationWithKeepRecentTokens — guard clauses", () => {
	it("returns fallback when keepRecentTokens is negative", () => {
		const result = rebuildPreparationWithKeepRecentTokens(createBranchEntries(), createPreparation(), -1);
		assert.match(result.fallbackReason ?? "", /resolved invalid keepRecentTokens/);
		assert.equal(result.preparation, undefined);
	});

	it("returns fallback when keepRecentTokens is NaN", () => {
		const result = rebuildPreparationWithKeepRecentTokens(createBranchEntries(), createPreparation(), NaN);
		assert.match(result.fallbackReason ?? "", /resolved invalid keepRecentTokens/);
	});

	it("returns fallback when branchEntries is empty", () => {
		const result = rebuildPreparationWithKeepRecentTokens([], createPreparation(), 1);
		assert.match(result.fallbackReason ?? "", /branch is empty/);
	});

	it("returns fallback when last entry is a compaction", () => {
		const entries = [
			...createBranchEntries(),
			{
				type: "compaction" as const,
				id: "comp-1",
				parentId: "e4",
				timestamp: "2026-04-04T00:00:04.000Z",
				summary: "previous summary",
				firstKeptEntryId: "e3",
				tokensBefore: 100,
				fromHook: false,
			},
		] as import("@earendil-works/pi-coding-agent").SessionEntry[];
		const result = rebuildPreparationWithKeepRecentTokens(entries, createPreparation(), 1);
		assert.match(result.fallbackReason ?? "", /already compacted/);
	});
});

describe("rebuildPreparationWithKeepRecentTokens — with previous compaction", () => {
	function createEntriesWithCompaction(): import("@earendil-works/pi-coding-agent").SessionEntry[] {
		return [
			{
				type: "message",
				id: "e0",
				parentId: null,
				timestamp: "2026-04-04T00:00:00.000Z",
				message: { role: "user", content: "A".repeat(120), timestamp: Date.now() },
			},
			{
				type: "compaction",
				id: "comp-1",
				parentId: "e0",
				timestamp: "2026-04-04T00:00:01.000Z",
				summary: "previous summary",
				firstKeptEntryId: "e2",
				tokensBefore: 200,
				fromHook: false,
			} as unknown as import("@earendil-works/pi-coding-agent").SessionEntry,
			{
				type: "message",
				id: "e2",
				parentId: "comp-1",
				timestamp: "2026-04-04T00:00:02.000Z",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-test",
					stopReason: "stop",
					content: [
						{ type: "text", text: "done" },
						{ type: "toolCall", id: "tc-w", name: "write", arguments: { path: "out.ts" } },
						{ type: "toolCall", id: "tc-e", name: "edit", arguments: { path: "main.ts" } },
					],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: "2026-04-04T00:00:03.000Z",
				message: { role: "user", content: "B".repeat(120), timestamp: Date.now() },
			},
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: "2026-04-04T00:00:04.000Z",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-test",
					stopReason: "stop",
					content: [{ type: "text", text: "result" }],
					timestamp: Date.now(),
				},
			},
		] as import("@earendil-works/pi-coding-agent").SessionEntry[];
	}

	it("uses previousSummary from previous compaction entry", () => {
		const result = rebuildPreparationWithKeepRecentTokens(
			createEntriesWithCompaction(),
			createPreparation(),
			1,
		);
		assert.equal(result.fallbackReason, undefined);
		assert.equal(result.preparation?.previousSummary, "previous summary");
	});

	it("collects write and edit file ops from messages after previous compaction", () => {
		const result = rebuildPreparationWithKeepRecentTokens(
			createEntriesWithCompaction(),
			createPreparation(),
			1,
		);
		assert.equal(result.fallbackReason, undefined);
		// write tool → written set
		assert.ok(result.preparation?.fileOps.written.has("out.ts"), "expected out.ts in written");
		// edit tool → edited set
		assert.ok(result.preparation?.fileOps.edited.has("main.ts"), "expected main.ts in edited");
	});

	it("collects modifiedFiles from compaction details (entries with fromHook=false)", () => {
		const entries = createEntriesWithCompaction();
		// Patch the compaction entry to include details.modifiedFiles
		const compEntry = entries[1] as unknown as {
			details?: { readFiles?: string[]; modifiedFiles?: string[] };
			fromHook: boolean;
		};
		compEntry.details = { readFiles: ["prev-read.ts"], modifiedFiles: ["prev-edited.ts"] };
		compEntry.fromHook = false;

		const result = rebuildPreparationWithKeepRecentTokens(entries, createPreparation(), 1);
		assert.equal(result.fallbackReason, undefined);
		assert.ok(result.preparation?.fileOps.read.has("prev-read.ts"), "expected prev-read.ts from compaction details");
		assert.ok(result.preparation?.fileOps.edited.has("prev-edited.ts"), "expected prev-edited.ts from compaction details");
	});
});

describe("resolveSummaryRetention — edge cases", () => {
	it("resolves tokens mode without context window (no bounds check)", () => {
		const result = resolveSummaryRetention(
			{ mode: "tokens", value: 30000 },
			{ sessionContextWindow: undefined, summaryModelContextWindow: undefined, reserveTokens: 0 },
		);
		assert.equal(result.fallbackReason, undefined);
		assert.equal(result.resolution?.keepRecentTokens, 30000);
	});

	it("returns fallback when reserveTokens leaves no room", () => {
		const result = resolveSummaryRetention(
			{ mode: "tokens", value: 5000 },
			{ sessionContextWindow: 10000, summaryModelContextWindow: undefined, reserveTokens: 10000 },
		);
		assert.match(result.fallbackReason ?? "", /leaves no room/);
	});
});

// ---------------------------------------------------------------------------
// Additional coverage for uncovered branches
// ---------------------------------------------------------------------------

describe("resolveSummaryRetention — additional coverage", () => {
	it("returns fallback when percent mode has undefined summaryModelContextWindow (but defined sessionContextWindow)", () => {
		const result = resolveSummaryRetention(
			{ mode: "percent", value: 20 },
			{ sessionContextWindow: 100000, summaryModelContextWindow: undefined, reserveTokens: 0 },
		);
		assert.match(result.fallbackReason ?? "", /needs both session and summary model context windows/);
	});

	it("tokens mode: resolves when value fits within budget", () => {
		const result = resolveSummaryRetention(
			{ mode: "tokens", value: 10000 },
			{ sessionContextWindow: 100000, summaryModelContextWindow: 100000, reserveTokens: 5000 },
		);
		assert.equal(result.fallbackReason, undefined);
		assert.equal(result.resolution?.keepRecentTokens, 10000);
	});

	it("tokens mode with no context window resolves without bounds check", () => {
		const result = resolveSummaryRetention(
			{ mode: "tokens", value: 50000 },
			{ sessionContextWindow: undefined, summaryModelContextWindow: undefined, reserveTokens: 0 },
		);
		assert.equal(result.fallbackReason, undefined);
		assert.equal(result.resolution?.keepRecentTokens, 50000);
	});
});

// ---------------------------------------------------------------------------
// Additional rebuildPreparationWithKeepRecentTokens coverage
// ---------------------------------------------------------------------------

describe("rebuildPreparationWithKeepRecentTokens — additional paths", () => {
	it("handles previousCompaction where firstKeptEntryId is not in branch (uses prevCompactionIndex+1)", () => {
		// Create entries with a compaction that has a firstKeptEntryId not in the branch
		const entries = [
			...createBranchEntries(),
			{
				type: "compaction" as const,
				id: "comp-prev",
				parentId: "e1",
				timestamp: "2026-04-01T00:00:00.000Z",
				summary: "old summary",
				firstKeptEntryId: "nonexistent-entry-id", // not in branch
				tokensBefore: 50,
				fromHook: false,
			},
			...createBranchEntries().map((e) => ({ ...e, id: `new-${e.id}`, parentId: "comp-prev" })),
		] as import("@earendil-works/pi-coding-agent").SessionEntry[];

		// Use large keepRecentTokens so we get a valid cut point
		const result = rebuildPreparationWithKeepRecentTokens(entries, createPreparation(), 100000);
		// Should not fallback - fallbackReason should be undefined
		assert.equal(result.fallbackReason, undefined, `Unexpected fallback: ${result.fallbackReason}`);
	});

	it("returns fallback when keepRecentTokens is Infinity", () => {
		const result = rebuildPreparationWithKeepRecentTokens(createBranchEntries(), createPreparation(), Infinity);
		assert.match(result.fallbackReason ?? "", /resolved invalid keepRecentTokens/);
	});

	it("returns fallback when branchEntries is a single compaction entry", () => {
		const entries = [
			{
				type: "compaction" as const,
				id: "comp-1",
				parentId: null,
				timestamp: "2026-04-04T00:00:00.000Z",
				summary: "only compaction",
				firstKeptEntryId: "e1",
				tokensBefore: 100,
				fromHook: false,
			},
		] as import("@earendil-works/pi-coding-agent").SessionEntry[];
		const result = rebuildPreparationWithKeepRecentTokens(entries, createPreparation(), 1);
		assert.match(result.fallbackReason ?? "", /already compacted/);
	});

	it("uses prevCompactionIndex+1 as boundaryStart when firstKeptEntryId is not found", () => {
		const entries = [
			{
				type: "message" as const,
				id: "e0",
				parentId: null,
				timestamp: "2026-04-04T00:00:00.000Z",
				message: { role: "user", content: "A", timestamp: Date.now() },
			},
			{
				type: "compaction" as const,
				id: "comp-1",
				parentId: "e0",
				timestamp: "2026-04-04T00:00:01.000Z",
				summary: "old summary",
				firstKeptEntryId: "nonexistent", // not in branch
				tokensBefore: 100,
				fromHook: false,
			},
			{
				type: "message" as const,
				id: "e2",
				parentId: "comp-1",
				timestamp: "2026-04-04T00:00:02.000Z",
				message: { role: "user", content: "B", timestamp: Date.now() },
			},
		] as import("@earendil-works/pi-coding-agent").SessionEntry[];

		const result = rebuildPreparationWithKeepRecentTokens(entries, createPreparation(), 100000);
		assert.equal(result.fallbackReason, undefined, `Unexpected fallback: ${result.fallbackReason}`);
		// Should have used prevCompactionIndex+1 = 2 as boundaryStart
		assert.ok(result.preparation, "expected preparation");
	});
});
