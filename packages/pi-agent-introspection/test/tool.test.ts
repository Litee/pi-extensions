import { describe, it, expect } from "vitest";
import type { SessionEntry, ContextUsage } from "@earendil-works/pi-coding-agent";
import { formatSessionDebugInfo, type FormatSessionDebugInfoOpts } from "../src/tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextEntryId = 0;

function makeCustomEntry(customType: string, data: unknown, id = `entry-${++_nextEntryId}`) {
	return {
		type: "custom" as const,
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		data,
	};
}

function makeMessageEntry(role: "user" | "assistant", id = `entry-${++_nextEntryId}`): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role, content: "hello" },
	} as unknown as SessionEntry;
}

const MOCK_SESSION_ID = "session-abc-123";
const MOCK_LEAF_ID = "leaf-xyz-456";
const MOCK_CWD = "/home/user/project";
const MOCK_SESSION_FILE = "/home/user/.pi/sessions/session-abc-123.json";

const MOCK_CONTEXT_USAGE: ContextUsage = {
	tokens: 5000,
	contextWindow: 200000,
	percent: 2.5,
};

const MOCK_SYSTEM_PROMPT = "You are a helpful coding assistant.\n\nAlways be concise.";

/** Minimal opts for tests that only care about specific sections */
function baseOpts(overrides: Partial<FormatSessionDebugInfoOpts> = {}): FormatSessionDebugInfoOpts {
	return {
		sessionId: MOCK_SESSION_ID,
		leafId: MOCK_LEAF_ID,
		cwd: MOCK_CWD,
		sessionFile: MOCK_SESSION_FILE,
		contextUsage: MOCK_CONTEXT_USAGE,
		entries: [],
		systemPrompt: undefined,
		metadata: true,
		usage: true,
		showEntries: true,
		showSystemPrompt: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test cases — existing behaviour (updated to new opts API)
// ---------------------------------------------------------------------------

describe("formatSessionDebugInfo", () => {
	it("empty session → shows zeros and no entries", () => {
		const result = formatSessionDebugInfo(baseOpts({ entries: [], contextUsage: undefined }));

		expect(result).toContain("## Metadata");
		expect(result).toContain(`**Session ID:** ${MOCK_SESSION_ID}`);
		expect(result).toContain("(no entries)");
		expect(result).toContain("(none)");
		expect(result).toContain("Not available");
	});

	it("session with custom entries → grouped by customType with latest data", () => {
		const entries: SessionEntry[] = [
			makeCustomEntry("pi-goal:state", { enabled: false, iterations: 0 }),
			makeCustomEntry("pi-goal:state", { enabled: true, iterations: 3 }),
			makeCustomEntry("pi-plan:state", { plan: "do something" }),
		];

		const result = formatSessionDebugInfo(baseOpts({ entries }));

		// Should show both customTypes
		expect(result).toContain("pi-goal:state");
		expect(result).toContain("pi-plan:state");

		// Should show count 2 for pi-goal:state
		expect(result).toContain("pi-goal:state (2 entry/entries)");
		expect(result).toContain("pi-plan:state (1 entry/entries)");

		// Should show the LATEST data for pi-goal:state (iterations: 3)
		expect(result).toContain('"iterations": 3');

		// Should NOT show the stale data (iterations: 0) — it was overwritten
		// by the latest. We check the latest value is present.
		expect(result).toContain('"enabled": true');

		// Context usage
		expect(result).toContain("5,000");
		expect(result).toContain("200,000");
		expect(result).toContain("2.5%");
	});

	it("filter by prefix → only matching customTypes shown", () => {
		const entries: SessionEntry[] = [
			makeCustomEntry("pi-goal:state", { goal: true }),
			makeCustomEntry("pi-plan:state", { plan: true }),
			makeCustomEntry("pi-goal:status", { active: false }),
		];

		const result = formatSessionDebugInfo(baseOpts({ entries, filter: "pi-goal" }));

		expect(result).toContain("pi-goal:state");
		expect(result).toContain("pi-goal:status");
		expect(result).not.toContain("pi-plan:state");
		expect(result).toContain('filtered by prefix: "pi-goal"');
	});

	it("mixed entry types → counts correct", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("user"),
			makeMessageEntry("user"),
			makeMessageEntry("assistant"),
			makeCustomEntry("my-ext:state", { x: 1 }),
		];

		const result = formatSessionDebugInfo(baseOpts({ entries }));

		// All 3 messages are type "message" (role is inside the message object)
		expect(result).toContain("message: 3");
		expect(result).toContain("custom: 1");
	});

	it("filter with no matches → shows (none)", () => {
		const entries: SessionEntry[] = [
			makeCustomEntry("pi-goal:state", { enabled: false }),
		];

		const result = formatSessionDebugInfo(
			baseOpts({ entries, filter: "nonexistent:" }),
		);

		expect(result).toContain("(none)");
		expect(result).not.toContain("pi-goal:state");
	});

	it("context usage with null tokens → shows unknown", () => {
		const usage: ContextUsage = {
			tokens: null,
			contextWindow: 100000,
			percent: null,
		};

		const result = formatSessionDebugInfo(baseOpts({ contextUsage: usage }));

		expect(result).toContain("unknown");
		expect(result).toContain("100,000");
	});

	// ---------------------------------------------------------------------------
	// New tests for renamed / extended API
	// ---------------------------------------------------------------------------

	it("metadata section contains session ID, leaf ID, cwd, session file", () => {
		const result = formatSessionDebugInfo(
			baseOpts({ metadata: true, usage: false, showEntries: false }),
		);

		expect(result).toContain("## Metadata");
		expect(result).toContain(`**Session ID:** ${MOCK_SESSION_ID}`);
		expect(result).toContain(`**Leaf ID:** ${MOCK_LEAF_ID}`);
		expect(result).toContain(`**CWD:** ${MOCK_CWD}`);
		expect(result).toContain(MOCK_SESSION_FILE);
	});

	it("system_prompt section appears when showSystemPrompt: true", () => {
		const result = formatSessionDebugInfo(
			baseOpts({
				metadata: false,
				usage: false,
				showEntries: false,
				showSystemPrompt: true,
				systemPrompt: MOCK_SYSTEM_PROMPT,
			}),
		);

		expect(result).toContain("## System Prompt");
		expect(result).toContain(MOCK_SYSTEM_PROMPT);
	});

	it("system_prompt section absent when showSystemPrompt: false (default)", () => {
		const result = formatSessionDebugInfo(
			baseOpts({ showSystemPrompt: false, systemPrompt: MOCK_SYSTEM_PROMPT }),
		);

		expect(result).not.toContain("## System Prompt");
	});

	it("char count appears in system_prompt section header", () => {
		const result = formatSessionDebugInfo(
			baseOpts({
				showSystemPrompt: true,
				systemPrompt: MOCK_SYSTEM_PROMPT,
			}),
		);

		const expectedCount = MOCK_SYSTEM_PROMPT.length;
		expect(result).toContain(`${expectedCount.toLocaleString()} chars`);
	});

	it("all-false with no filter returns available-sections message", () => {
		const result = formatSessionDebugInfo(
			baseOpts({
				metadata: false,
				usage: false,
				showEntries: false,
				showSystemPrompt: false,
				// filter omitted (not passed) → no filter
			}),
		);

		expect(result).toContain("Available sections");
		expect(result).toContain("metadata");
		expect(result).toContain("usage");
		expect(result).toContain("entries");
		expect(result).toContain("system_prompt");
	});

	it("metadata-only request omits usage and entries sections", () => {
		const result = formatSessionDebugInfo(
			baseOpts({ metadata: true, usage: false, showEntries: false }),
		);

		expect(result).toContain("## Metadata");
		expect(result).not.toContain("## Token Usage");
		expect(result).not.toContain("## Session Entries");
	});

	it("usage-only request omits metadata and entries sections", () => {
		const result = formatSessionDebugInfo(
			baseOpts({ metadata: false, usage: true, showEntries: false }),
		);

		expect(result).toContain("## Token Usage");
		expect(result).not.toContain("## Metadata");
		expect(result).not.toContain("## Session Entries");
	});

	it("entries-only request omits metadata and usage sections", () => {
		const entries: SessionEntry[] = [
			makeCustomEntry("ext:state", { x: 1 }),
		];

		const result = formatSessionDebugInfo(
			baseOpts({ metadata: false, usage: false, showEntries: true, entries }),
		);

		expect(result).toContain("## Session Entries");
		expect(result).not.toContain("## Metadata");
		expect(result).not.toContain("## Token Usage");
	});
});

// ---------------------------------------------------------------------------
// registerSessionDebugInfoTool — exercise the pi.registerTool execute() path
// ---------------------------------------------------------------------------
import { registerSessionDebugInfoTool } from "../src/tool.js";

describe("registerSessionDebugInfoTool — execute() handler", () => {
	function makeMockPi() {
		let capturedExecute:
			| ((
					toolCallId: string,
					params: Record<string, unknown>,
					signal: AbortSignal | undefined,
					onUpdate: unknown,
					ctx: unknown,
				) => Promise<{ content: { type: string; text: string }[]; details: { debugInfo: string } }>)
			| undefined;

		const pi = {
			registerTool: vi.fn((def: { execute: typeof capturedExecute }) => {
				capturedExecute = def.execute;
			}),
		};
		return { pi, getExecute: () => capturedExecute! };
	}

	function makeCtx(overrides: Partial<{
		sessionId: string;
		leafId: string | null;
		cwd: string;
		sessionFile: string | null;
		entries: unknown[];
		contextUsage: { tokens: number; contextWindow: number; percent: number } | null;
		systemPrompt: string;
	}> = {}) {
		return {
			sessionManager: {
				getSessionId: vi.fn(() => overrides.sessionId ?? "sess-test-123"),
				getLeafId: vi.fn(() => overrides.leafId ?? "leaf-test-456"),
				getSessionFile: vi.fn(() => overrides.sessionFile ?? "/tmp/session.json"),
				getEntries: vi.fn(() => overrides.entries ?? []),
			},
			cwd: overrides.cwd ?? "/tmp/project",
			getContextUsage: vi.fn(() => overrides.contextUsage ?? { tokens: 1000, contextWindow: 100000, percent: 1.0 }),
			getSystemPrompt: vi.fn(() => overrides.systemPrompt ?? "You are helpful."),
		};
	}

	it("registers the tool and execute() returns content with debugInfo", async () => {
		const { pi, getExecute } = makeMockPi();
		registerSessionDebugInfoTool(pi as never);

		expect(pi.registerTool).toHaveBeenCalledOnce();
		const execute = getExecute();
		const ctx = makeCtx();

		const result = await execute("call-1", {}, undefined, undefined, ctx);
		expect(result.content[0]?.type).toBe("text");
		expect(result.details.debugInfo).toBeTruthy();
	});

	it("execute() includes metadata section when metadata=true (default)", async () => {
		const { pi, getExecute } = makeMockPi();
		registerSessionDebugInfoTool(pi as never);
		const ctx = makeCtx({ sessionId: "sid-42", leafId: null });

		const result = await getExecute()("call-2", { metadata: true }, undefined, undefined, ctx);
		expect(result.details.debugInfo).toContain("## Metadata");
		expect(result.details.debugInfo).toContain("sid-42");
		expect(result.details.debugInfo).toContain("(none)"); // leafId is null
	});

	it("execute() includes system_prompt section when system_prompt=true", async () => {
		const { pi, getExecute } = makeMockPi();
		registerSessionDebugInfoTool(pi as never);
		const ctx = makeCtx({ systemPrompt: "Super system prompt." });

		const result = await getExecute()("call-3", { system_prompt: true }, undefined, undefined, ctx);
		expect(result.details.debugInfo).toContain("## System Prompt");
		expect(result.details.debugInfo).toContain("Super system prompt.");
	});

	it("execute() respects metadata=false to skip that section", async () => {
		const { pi, getExecute } = makeMockPi();
		registerSessionDebugInfoTool(pi as never);
		const ctx = makeCtx();

		const result = await getExecute()("call-4", { metadata: false, usage: false, entries: false }, undefined, undefined, ctx);
		expect(result.details.debugInfo).toContain("No sections requested");
	});
});
