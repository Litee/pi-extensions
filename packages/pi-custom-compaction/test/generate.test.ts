import assert from "node:assert/strict";
import { describe, it, vi, afterEach } from "vitest";
import {
	computeFileLists,
	formatFileOperations,
	generateTemplateSummary,
	generateTurnPrefixSummary,
} from "../src/summary/generate.js";

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	convertToLlm: vi.fn().mockReturnValue([]),
	serializeConversation: vi.fn().mockReturnValue("user: hello\nassistant: world"),
}));

import { completeSimple } from "@earendil-works/pi-ai";
const mockCompleteSimple = vi.mocked(completeSimple);

afterEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// computeFileLists
// ---------------------------------------------------------------------------

describe("computeFileLists", () => {
	it("returns empty lists when fileOps is empty object", () => {
		const result = computeFileLists({});
		assert.deepEqual(result, { readFiles: [], modifiedFiles: [] });
	});

	it("accepts Set inputs for read/edited/written", () => {
		const result = computeFileLists({
			read: new Set(["a.ts", "b.ts"]),
			edited: new Set(["b.ts"]),
			written: new Set(["c.ts"]),
		});
		assert.deepEqual(result.readFiles, ["a.ts"]);
		assert.deepEqual(result.modifiedFiles, ["b.ts", "c.ts"]);
	});

	it("accepts Array inputs for read/edited/written", () => {
		const result = computeFileLists({
			read: ["a.ts", "b.ts"],
			edited: ["b.ts"],
			written: ["c.ts"],
		});
		assert.deepEqual(result.readFiles, ["a.ts"]);
		assert.deepEqual(result.modifiedFiles, ["b.ts", "c.ts"]);
	});

	it("excludes read files that were also modified", () => {
		const result = computeFileLists({
			read: new Set(["a.ts", "b.ts", "c.ts"]),
			edited: new Set(["b.ts"]),
			written: new Set(["c.ts"]),
		});
		assert.deepEqual(result.readFiles, ["a.ts"]);
		assert.deepEqual(result.modifiedFiles, ["b.ts", "c.ts"]);
	});

	it("deduplicates edited and written into modifiedFiles", () => {
		const result = computeFileLists({
			read: new Set<string>(),
			edited: new Set(["x.ts"]),
			written: new Set(["x.ts"]),
		});
		assert.deepEqual(result.modifiedFiles, ["x.ts"]);
	});

	it("sorts readFiles and modifiedFiles alphabetically", () => {
		const result = computeFileLists({
			read: new Set(["z.ts", "a.ts", "m.ts"]),
			edited: new Set(["d.ts", "b.ts"]),
			written: new Set<string>(),
		});
		assert.deepEqual(result.readFiles, ["a.ts", "m.ts", "z.ts"]);
		assert.deepEqual(result.modifiedFiles, ["b.ts", "d.ts"]);
	});

	it("ignores non-string values in sets", () => {
		const result = computeFileLists({
			read: new Set(["a.ts", 42, null] as unknown as string[]),
			edited: new Set<string>(),
			written: new Set<string>(),
		});
		assert.deepEqual(result.readFiles, ["a.ts"]);
	});

	it("ignores non-string values in arrays", () => {
		const result = computeFileLists({
			read: ["a.ts", 42, null] as unknown as string[],
			edited: [],
			written: [],
		});
		assert.deepEqual(result.readFiles, ["a.ts"]);
	});

	it("handles missing fields gracefully", () => {
		const result = computeFileLists({ read: new Set(["a.ts"]) });
		assert.deepEqual(result.readFiles, ["a.ts"]);
		assert.deepEqual(result.modifiedFiles, []);
	});

	it("returns empty lists for null/undefined input", () => {
		const result = computeFileLists(null);
		assert.deepEqual(result, { readFiles: [], modifiedFiles: [] });
	});

	it("returns empty lists for non-Set/non-Array input (toFilePathSet else branch)", () => {
		// Pass a plain object — toFilePathSet falls through to `return new Set<string>()`
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		const result = computeFileLists({ read: "not-a-set-or-array" } as never);
		assert.deepEqual(result, { readFiles: [], modifiedFiles: [] });
	});

	it("handles undefined fileOps (?? operator right branch)", () => {
		const result = computeFileLists(undefined);
		assert.deepEqual(result, { readFiles: [], modifiedFiles: [] });
	});
});

// ---------------------------------------------------------------------------
// formatFileOperations
// ---------------------------------------------------------------------------

describe("formatFileOperations", () => {
	it("returns empty string when both lists are empty", () => {
		const result = formatFileOperations({ readFiles: [], modifiedFiles: [] });
		assert.equal(result, "");
	});

	it("formats read-only files section", () => {
		const result = formatFileOperations({ readFiles: ["a.ts", "b.ts"], modifiedFiles: [] });
		assert.match(result, /read-files/);
		assert.match(result, /a\.ts/);
		assert.match(result, /b\.ts/);
		assert.doesNotMatch(result, /modified-files/);
	});

	it("formats modified-only files section", () => {
		const result = formatFileOperations({ readFiles: [], modifiedFiles: ["x.ts"] });
		assert.match(result, /modified-files/);
		assert.match(result, /x\.ts/);
		assert.doesNotMatch(result, /read-files/);
	});

	it("formats both sections when both lists are non-empty", () => {
		const result = formatFileOperations({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
		assert.match(result, /read-files/);
		assert.match(result, /modified-files/);
		assert.match(result, /a\.ts/);
		assert.match(result, /b\.ts/);
	});

	it("starts with two newlines when non-empty", () => {
		const result = formatFileOperations({ readFiles: ["a.ts"], modifiedFiles: [] });
		assert.ok(result.startsWith("\n\n"));
	});
});

// ---------------------------------------------------------------------------
// generateTemplateSummary (mocked completeSimple)
// ---------------------------------------------------------------------------

function makeModel() {
	return { id: "test-model", provider: "openai", contextWindow: 4096 } as never;
}

describe("generateTemplateSummary", () => {
	it("returns text content from a successful completion", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "end_turn",
			content: [{ type: "text", text: "Summary of the conversation." }],
		} as never);

		const signal = new AbortController().signal;
		const result = await generateTemplateSummary(
			[],
			makeModel(),
			"test-api-key",
			"Summarize the above.",
			4096,
			signal,
			"off",
		);
		assert.equal(result, "Summary of the conversation.");
	});

	it("includes previousSummary in the prompt when provided", async () => {
		let capturedMessages: unknown;
		mockCompleteSimple.mockImplementationOnce(((_model: unknown, opts: unknown) => {
			capturedMessages = opts;
			return Promise.resolve({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			});
		}) as never);

		const signal = new AbortController().signal;
		await generateTemplateSummary(
			[],
			makeModel(),
			undefined,
			"Summarize.",
			4096,
			signal,
			"off",
			"Previous summary text.",
		);
		const opts = capturedMessages as { messages: Array<{ content: Array<{ text: string }> }> };
		assert.match(opts.messages[0]?.content[0]?.text ?? "", /Previous summary text\./);
	});

	it("joins multiple text content blocks with newline", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "end_turn",
			content: [
				{ type: "text", text: "Part A" },
				{ type: "text", text: "Part B" },
			],
		} as never);

		const signal = new AbortController().signal;
		const result = await generateTemplateSummary(
			[],
			makeModel(),
			undefined,
			"Summarize.",
			4096,
			signal,
			"off",
		);
		assert.equal(result, "Part A\nPart B");
	});

	it("filters out non-text content blocks", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "end_turn",
			content: [
				{ type: "thinking", text: "thinking..." },
				{ type: "text", text: "Summary" },
			],
		} as never);

		const signal = new AbortController().signal;
		const result = await generateTemplateSummary(
			[],
			makeModel(),
			undefined,
			"Summarize.",
			4096,
			signal,
			"low",
		);
		assert.equal(result, "Summary");
	});

	it("throws on error stop reason", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "error",
			errorMessage: "Rate limit exceeded",
			content: [],
		} as never);

		const signal = new AbortController().signal;
		await assert.rejects(
			() => generateTemplateSummary([], makeModel(), undefined, "Summarize.", 4096, signal, "off"),
			/Rate limit exceeded/,
		);
	});

	it("throws with 'Unknown error' when errorMessage is undefined (|| right branch)", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "error",
			errorMessage: undefined,
			content: [],
		} as never);

		const signal = new AbortController().signal;
		await assert.rejects(
			() => generateTemplateSummary([], makeModel(), undefined, "Summarize.", 4096, signal, "off"),
			/Summarization failed: Unknown error/,
		);
	});

	it("passes headers when provided", async () => {
		let capturedOptions: unknown;
		mockCompleteSimple.mockImplementationOnce(((_model: unknown, _session: unknown, opts: unknown) => {
			capturedOptions = opts;
			return Promise.resolve({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			});
		}) as never);

		const signal = new AbortController().signal;
		await generateTemplateSummary(
			[],
			makeModel(),
			"key",
			"Summarize.",
			4096,
			signal,
			"off",
			undefined,
			{ "x-custom": "header" },
		);
		const opts = capturedOptions as { headers?: Record<string, string> };
		assert.deepEqual(opts.headers, { "x-custom": "header" });
	});
});

// ---------------------------------------------------------------------------
// generateTurnPrefixSummary (mocked completeSimple)
// ---------------------------------------------------------------------------

describe("generateTurnPrefixSummary", () => {
	it("returns text content from a successful completion", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "end_turn",
			content: [{ type: "text", text: "Turn prefix summary." }],
		} as never);

		const signal = new AbortController().signal;
		const result = await generateTurnPrefixSummary(
			[],
			makeModel(),
			"api-key",
			4096,
			signal,
			"off",
		);
		assert.equal(result, "Turn prefix summary.");
	});

	it("throws on error stop reason", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "error",
			errorMessage: "Context too large",
			content: [],
		} as never);

		const signal = new AbortController().signal;
		await assert.rejects(
			() => generateTurnPrefixSummary([], makeModel(), undefined, 4096, signal, "off"),
			/Context too large/,
		);
	});

	it("uses thinking level when model supports reasoning", async () => {
		let capturedOptions: unknown;
		mockCompleteSimple.mockImplementationOnce(((_model: unknown, _session: unknown, opts: unknown) => {
			capturedOptions = opts;
			return Promise.resolve({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			});
		}) as never);

		const signal = new AbortController().signal;
		const modelWithReasoning = { id: "test-model", provider: "openai", contextWindow: 4096, reasoning: true } as never;
		await generateTurnPrefixSummary([], modelWithReasoning, undefined, 4096, signal, "medium");
		const opts = capturedOptions as { reasoning?: string };
		assert.equal(opts.reasoning, "medium");
	});

	it("throws turn prefix summary with 'Unknown error' when errorMessage is undefined", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			stopReason: "error",
			errorMessage: undefined,
			content: [],
		} as never);

		const signal = new AbortController().signal;
		await assert.rejects(
			() => generateTurnPrefixSummary([], makeModel(), undefined, 4096, signal, "off"),
			/Turn prefix summarization failed: Unknown error/,
		);
	});

	it("works with undefined apiKey (ternary false branch in getSummarizationCompletionOptions)", async () => {
		let capturedOptions: unknown;
		mockCompleteSimple.mockImplementationOnce(((_model: unknown, _session: unknown, opts: unknown) => {
			capturedOptions = opts;
			return Promise.resolve({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			});
		}) as never);

		const signal = new AbortController().signal;
		await generateTurnPrefixSummary([], makeModel(), undefined, 4096, signal, "off");
		const opts = capturedOptions as { apiKey?: string };
		assert.equal(opts.apiKey, undefined);
	});

	it("works with undefined headers (ternary false branch in getSummarizationCompletionOptions)", async () => {
		let capturedOptions: unknown;
		mockCompleteSimple.mockImplementationOnce(((_model: unknown, _session: unknown, opts: unknown) => {
			capturedOptions = opts;
			return Promise.resolve({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			});
		}) as never);

		const signal = new AbortController().signal;
		await generateTurnPrefixSummary([], makeModel(), "key", 4096, signal, "off", undefined);
		const opts = capturedOptions as { headers?: Record<string, string> };
		assert.equal(opts.headers, undefined);
	});

	it("works with undefined apiKey in reasoning path (model.reasoning=true, thinkingLevel!=off)", async () => {
		let capturedOptions: unknown;
		mockCompleteSimple.mockImplementationOnce(((_model: unknown, _session: unknown, opts: unknown) => {
			capturedOptions = opts;
			return Promise.resolve({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			});
		}) as never);

		const signal = new AbortController().signal;
		const modelWithReasoning = { id: "test-model", provider: "openai", contextWindow: 4096, reasoning: true } as never;
		// thinkingLevel="low" != "off" and model.reasoning=true → second return path
		await generateTurnPrefixSummary([], modelWithReasoning, undefined, 4096, signal, "low");
		const opts = capturedOptions as { apiKey?: string; reasoning?: string };
		assert.equal(opts.apiKey, undefined);
		assert.equal(opts.reasoning, "low");
	});

	it("works with undefined headers in reasoning path (model.reasoning=true, thinkingLevel!=off)", async () => {
		let capturedOptions: unknown;
		mockCompleteSimple.mockImplementationOnce(((_model: unknown, _session: unknown, opts: unknown) => {
			capturedOptions = opts;
			return Promise.resolve({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			});
		}) as never);

		const signal = new AbortController().signal;
		const modelWithReasoning = { id: "test-model", provider: "openai", contextWindow: 4096, reasoning: true } as never;
		await generateTemplateSummary([], modelWithReasoning, "key", "Summarize.", 4096, signal, "medium", undefined);
		const opts = capturedOptions as { headers?: Record<string, string>; reasoning?: string };
		assert.equal(opts.headers, undefined);
		assert.equal(opts.reasoning, "medium");
	});
});
