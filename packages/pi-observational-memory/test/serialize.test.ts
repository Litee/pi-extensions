import { describe, expect, it } from "vitest";

import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	serializeConversation,
	serializeBranchEntries,
	serializeSourceAddressedBranchEntries,
	renderRecallSourceEntries,
	renderRecallSourceEntry,
	type RenderableEntry,
	truncateRecordContent,
	nowTimestamp,
	MAX_RECORD_CONTENT_CHARS,
} from "../src/serialize.js";

function userMessage(timestamp: number, content = "Hello"): Message {
	return { role: "user", content, timestamp };
}

function assistantMessage(timestamp: number, content: unknown = "Assistant reply"): Message {
	return { role: "assistant", content, timestamp };
}

function toolResultMessage(timestamp: number, toolName: string, content = "Tool output"): Message {
	return { role: "tool", content, timestamp, toolName } as ToolResultMessage;
}

describe("serializeConversation", () => {
	it("renders user messages with timestamp and text", () => {
		const msg = userMessage(1700000000000, "Hello world");
		const result = serializeConversation([msg]);
		expect(result).toContain("User @");
		expect(result).toContain("Hello world");
	});

	it("renders assistant messages with text content", () => {
		const msg = assistantMessage(1700000000000, "Assistant reply");
		const result = serializeConversation([msg]);
		expect(result).toContain("Assistant @");
		expect(result).toContain("Assistant reply");
	});

	it("renders assistant messages with array content including text blocks", () => {
		const content = [{ type: "text", text: "Block 1" }, { type: "text", text: "Block 2" }];
		const msg = assistantMessage(1700000000000, content);
		const result = serializeConversation([msg]);
		expect(result).toContain("Block 1");
		expect(result).toContain("Block 2");
	});

	it("renders assistant messages with thinking blocks (includeThinking=true, omitRedactedThinking=true)", () => {
		const content = [
			{ type: "thinking", thinking: "Let me think about this" },
			{ type: "text", text: "Final answer" },
		];
		const msg = assistantMessage(1700000000000, content);
		const result = serializeConversation([msg]);
		// thinking is omitted when includeThinking=true but the thinking key is used (not the type="thinking" text key)
		expect(result).toContain("Assistant @");
		expect(result).toContain("Final answer");
	});

	it("renders assistant messages with redacted thinking blocks (omitted)", () => {
		const content = [
			{ type: "thinking", thinking: "visible thought", redacted: true },
			{ type: "text", text: "Final" },
		];
		const msg = assistantMessage(1700000000000, content);
		const result = serializeConversation([msg]);
		expect(result).toContain("Final");
	});

	it("renders assistant messages with toolCall blocks", () => {
		const content = [
			{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
		];
		const msg = assistantMessage(1700000000000, content);
		const result = serializeConversation([msg]);
		expect(result).toContain("[bash");
		expect(result).toContain("ls");
	});

	it("renders assistant messages with non-text blocks as omitted", () => {
		const content = [{ type: "image", url: "http://example.com/img.png" }];
		const msg = assistantMessage(1700000000000, content);
		const result = serializeConversation([msg]);
		expect(result).toContain("[non-text content omitted]");
	});

	it("renders tool result messages with tool name", () => {
		const msg = toolResultMessage(1700000000000, "bash", "stdout output");
		const result = serializeConversation([msg]);
		expect(result).toContain("Tool result for bash @");
		expect(result).toContain("stdout output");
	});

	it("returns null for assistant messages with empty body and filters them out", () => {
		const msg = assistantMessage(1700000000000, []);
		const result = serializeConversation([msg]);
		expect(result).toBe("");
	});

	it("handles undefined timestamp with fallback format", () => {
		const msg = userMessage(Date.now(), "test");
		// Force timestamp to undefined by using a minimal message
		const result = serializeConversation([{ role: "user", content: "hi", timestamp: undefined } as Message]);
		expect(result).toContain("????-??-?? ??:??");
		expect(result).toContain("hi");
	});

	it("handles invalid timestamps with fallback format", () => {
		const msg = userMessage(Date.now(), "test");
		const result = serializeConversation([{ role: "user", content: "hi", timestamp: "not-a-date" } as Message]);
		expect(result).toContain("????-??-?? ??:??");
	});

	it("renders a mix of user and assistant messages", () => {
		const msgs = [
			userMessage(1700000000000, "First"),
			assistantMessage(1700000001000, "Second"),
			userMessage(1700000002000, "Third"),
		];
		const result = serializeConversation(msgs);
		expect(result).toContain("First");
		expect(result).toContain("Second");
		expect(result).toContain("Third");
		// Messages should be separated by double newlines
		expect(result.split("\n\n").length).toBe(3);
	});

	it("returns empty string for empty messages array", () => {
		expect(serializeConversation([])).toBe("");
	});

	it("handles user message with null content (textOnly null branch)", () => {
		const result = serializeConversation([
			{ role: "user", content: null, timestamp: 1700000000000 } as Message,
		]);
		expect(result).toContain("User @");
		expect(result).not.toContain("null");
	});

	it("handles user message with non-array, non-string content (textOnly non-array branch)", () => {
		const result = serializeConversation([
			{ role: "user", content: 42, timestamp: 1700000000000 } as Message,
		]);
		expect(result).toContain("User @");
		expect(result).not.toContain("42");
	});

	it("handles assistant message with array containing null items", () => {
		const content = [null, { type: "text", text: "valid" }];
		const msg = assistantMessage(1700000000000, content);
		const result = serializeConversation([msg]);
		expect(result).toContain("valid");
		expect(result).toContain("[non-text content omitted]");
	});

	it("handles assistant message with array containing undefined items", () => {
		const content = [undefined, { type: "text", text: "ok" }];
		const msg = assistantMessage(1700000000000, content);
		const result = serializeConversation([msg]);
		expect(result).toContain("ok");
		expect(result).toContain("[non-text content omitted]");
	});
});

describe("truncateRecordContent", () => {
	it("returns content unchanged when under the limit", () => {
		const content = "short content";
		expect(truncateRecordContent(content)).toBe(content);
	});

	it("truncates content over the limit with dropped count", () => {
		const longContent = "a".repeat(MAX_RECORD_CONTENT_CHARS + 100);
		const result = truncateRecordContent(longContent);
		expect(result).toContain(" … [truncated 100 chars]");
		expect(result.length).toBeGreaterThan(MAX_RECORD_CONTENT_CHARS);
	});
});

describe("nowTimestamp", () => {
	it("returns a formatted local timestamp string", () => {
		const result = nowTimestamp();
		expect(result).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
	});
});

describe("serializeBranchEntries", () => {
	it("serializes message entries using serializeConversation", () => {
		const entry = {
			type: "message" as const,
			message: { role: "user" as const, content: "Hello", timestamp: 1700000000000 },
		} as unknown as RenderableEntry;
		const result = serializeBranchEntries([entry]);
		expect(result).toContain("User @");
		expect(result).toContain("Hello");
	});

	it("serializes custom_message entries", () => {
		const entry: RenderableEntry = {
			type: "custom_message",
			content: "Custom text content",
		};
		const result = serializeBranchEntries([entry]);
		expect(result).toContain("Custom @");
		expect(result).toContain("Custom text content");
	});

	it("serializes custom_message entries with array content", () => {
		const entry: RenderableEntry = {
			type: "custom_message",
			content: [{ type: "text", text: "Block A" }, { type: "text", text: "Block B" }],
		};
		const result = serializeBranchEntries([entry]);
		expect(result).toContain("Block A");
		expect(result).toContain("Block B");
	});

	it("serializes branch_summary entries", () => {
		const entry: RenderableEntry = {
			type: "branch_summary",
			summary: "Session compacted",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const result = serializeBranchEntries([entry]);
		expect(result).toContain("Branch summary @");
		expect(result).toContain("Session compacted");
	});

	it("skips branch_summary without string summary", () => {
		const entry: RenderableEntry = {
			type: "branch_summary",
			summary: 123,
		};
		const result = serializeBranchEntries([entry]);
		expect(result).toBe("");
	});

	it("handles empty entries array", () => {
		expect(serializeBranchEntries([])).toBe("");
	});

	it("handles mixed entry types", () => {
		const entries: RenderableEntry[] = [
			{ type: "message", message: { role: "user" as const, content: "Hi", timestamp: 1700000000000 } },
			{ type: "custom_message", content: "Custom note" },
			{ type: "branch_summary", summary: "Summary here", timestamp: "2026-01-01T00:00:00.000Z" },
		];
		const result = serializeBranchEntries(entries);
		expect(result).toContain("User @");
		expect(result).toContain("Custom @");
		expect(result).toContain("Branch summary @");
		expect(result.split("\n\n").length).toBe(3);
	});
});

describe("serializeSourceAddressedBranchEntries", () => {
	it("serializes entries with ids and includes source entry id markers", () => {
		const entry: RenderableEntry = {
			type: "message",
			id: "entry-1",
			message: { role: "user" as const, content: "Hello", timestamp: 1700000000000 },
		};
		const result = serializeSourceAddressedBranchEntries([entry]);
		expect(result.text).toContain("[Source entry id: entry-1]");
		expect(result.text).toContain("Hello");
		expect(result.sourceEntryIds).toEqual(["entry-1"]);
	});

	it("serializes custom_message entries with source ids", () => {
		const entry: RenderableEntry = {
			type: "custom_message",
			id: "custom-1",
			content: "Custom content",
		};
		const result = serializeSourceAddressedBranchEntries([entry]);
		expect(result.sourceEntryIds).toEqual(["custom-1"]);
		expect(result.text).toContain("[Source entry id: custom-1]");
	});

	it("serializes branch_summary entries with source ids", () => {
		const entry: RenderableEntry = {
			type: "branch_summary",
			id: "summary-1",
			summary: "Compact note",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const result = serializeSourceAddressedBranchEntries([entry]);
		expect(result.sourceEntryIds).toEqual(["summary-1"]);
		expect(result.text).toContain("[Source entry id: summary-1]");
	});

	it("skips entries without ids", () => {
		const entry: RenderableEntry = {
			type: "custom_message",
			content: "No id here",
		};
		const result = serializeSourceAddressedBranchEntries([entry]);
		expect(result.sourceEntryIds).toEqual([]);
		expect(result.text).toBe("");
	});

	it("skips non-source entry types", () => {
		const entry: RenderableEntry = {
			type: "unknown_type",
			id: "unknown-1",
			content: "Should be skipped",
		};
		const result = serializeSourceAddressedBranchEntries([entry]);
		expect(result.sourceEntryIds).toEqual([]);
		expect(result.text).toBe("");
	});

	it("returns empty result for empty entries", () => {
		const result = serializeSourceAddressedBranchEntries([]);
		expect(result.text).toBe("");
		expect(result.sourceEntryIds).toEqual([]);
	});

	it("only includes valid source entries and skips entries with empty rendered text", () => {
		const entries: RenderableEntry[] = [
			{ type: "custom_message", id: "good-1", content: "Valid" },
			{ type: "unknown_type", id: "skip-1", content: "Skipped" },
			{ type: "custom_message", id: "good-2", content: "Also valid" },
		];
		const result = serializeSourceAddressedBranchEntries(entries);
		expect(result.sourceEntryIds).toEqual(["good-1", "good-2"]);
		expect(result.text).toContain("good-1");
		expect(result.text).toContain("good-2");
		expect(result.text).not.toContain("skip-1");
	});
});

describe("renderRecallSourceEntry", () => {
	it("renders message entries via renderRecallMessage for user role", () => {
		const entry: RenderableEntry = {
			type: "message",
			message: { role: "user" as const, content: "User query", timestamp: 1700000000000 },
		};
		const result = renderRecallSourceEntry(entry);
		expect(result).toContain("User @");
		expect(result).toContain("User query");
	});

	it("renders message entries for assistant role", () => {
		const entry: RenderableEntry = {
			type: "message",
			message: { role: "assistant" as const, content: "Assistant response", timestamp: 1700000000000 },
		};
		const result = renderRecallSourceEntry(entry);
		expect(result).toContain("Assistant @");
		expect(result).toContain("Assistant response");
	});

	it("renders tool result messages", () => {
		const entry: RenderableEntry = {
			type: "message",
			message: { role: "tool" as const, content: "Tool output", timestamp: 1700000000000, toolName: "bash" } as unknown as Message,
		};
		const result = renderRecallSourceEntry(entry);
		expect(result).toContain("Tool result: bash @");
		expect(result).toContain("Tool output");
	});

	it("returns null for message with non-object message field", () => {
		const entry: RenderableEntry = {
			type: "message",
			message: "not an object",
		};
		expect(renderRecallSourceEntry(entry)).toBeNull();
	});

	it("returns null for message with undefined message field", () => {
		const entry: RenderableEntry = {
			type: "message",
		};
		expect(renderRecallSourceEntry(entry)).toBeNull();
	});

	it("renders custom_message entries with recall format", () => {
		const entry: RenderableEntry = {
			type: "custom_message",
			content: "Custom recall content",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const result = renderRecallSourceEntry(entry);
		expect(result).toContain("Custom message @");
		expect(result).toContain("Custom recall content");
	});

	it("renders custom_message entries with customType", () => {
		const entry: RenderableEntry = {
			type: "custom_message",
			content: "Agent note",
			customType: "agent-note",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const result = renderRecallSourceEntry(entry);
		expect(result).toContain("Custom message (agent-note) @");
		expect(result).toContain("Agent note");
	});

	it("renders branch_summary entries with recall format", () => {
		const entry: RenderableEntry = {
			type: "branch_summary",
			summary: "Compaction complete",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const result = renderRecallSourceEntry(entry);
		expect(result).toContain("Branch summary @");
		expect(result).toContain("Compaction complete");
	});

	it("returns null for branch_summary without string summary", () => {
		const entry: RenderableEntry = {
			type: "branch_summary",
			summary: 42,
		};
		expect(renderRecallSourceEntry(entry)).toBeNull();
	});

	it("returns null for unknown entry types", () => {
		const entry: RenderableEntry = {
			type: "unknown_type",
			content: "Unknown",
		};
		expect(renderRecallSourceEntry(entry)).toBeNull();
	});
});

describe("renderRecallSourceEntries", () => {
	it("renders multiple entries separated by double newlines", () => {
		const entries: RenderableEntry[] = [
			{ type: "custom_message", content: "First", timestamp: "2026-01-01T00:00:00.000Z" },
			{ type: "custom_message", content: "Second", timestamp: "2026-01-01T00:00:00.000Z" },
		];
		const result = renderRecallSourceEntries(entries);
		expect(result).toContain("First");
		expect(result).toContain("Second");
		expect(result).toContain("\n\n");
	});

	it("filters out null entries and empty strings", () => {
		const entries: RenderableEntry[] = [
			{ type: "custom_message", content: "Valid" },
			{ type: "message" }, // returns null
			{ type: "branch_summary", summary: 42 }, // returns null
			{ type: "custom_message", content: "" }, // returns null (empty trimmed)
		];
		const result = renderRecallSourceEntries(entries);
		expect(result).toContain("Valid");
		expect(result).not.toContain("\n\n\n");
	});

	it("returns empty string for empty entries array", () => {
		expect(renderRecallSourceEntries([])).toBe("");
	});

	it("returns empty string when all entries render as null", () => {
		const entries: RenderableEntry[] = [
			{ type: "unknown_type", content: "Unknown" },
			{ type: "message", message: null },
		];
		expect(renderRecallSourceEntries(entries)).toBe("");
	});
});
