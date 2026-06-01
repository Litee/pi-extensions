import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	unlinkSync: vi.fn(),
}));

vi.mock("node:os", () => ({
	tmpdir: () => "/tmp",
}));

vi.mock("../src/tts.js", () => ({
	synthesise: vi.fn(),
	writeWav: vi.fn(),
}));

vi.mock("../src/audio.js", () => ({
	playAudioFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Real imports
// ---------------------------------------------------------------------------

import { unlinkSync } from "node:fs";
import { SpeechQueue, executionTimeoutMs } from "../src/queue.js";
import { synthesise, writeWav } from "../src/tts.js";
import { playAudioFile } from "../src/audio.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseItem = {
	text: "hello",
	voice: "M1" as const,
	lang: "en" as const,
	speed: 1.05,
	steps: 8,
	assetsDir: "/fake/assets",
};

/** Flush all pending microtasks and macrotasks (one setTimeout(0) round). */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(synthesise).mockResolvedValue({ wav: [], sampleRate: 44100, duration: [0.1] });
	vi.mocked(writeWav).mockResolvedValue(undefined);
	vi.mocked(playAudioFile).mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// executionTimeoutMs
// ---------------------------------------------------------------------------

describe("executionTimeoutMs", () => {
	it("returns 30_000 for 0 chars (minimum)", () => {
		expect(executionTimeoutMs(0)).toBe(30_000);
	});

	it("returns 120_000 for 700 chars (1× expected speech duration × 2)", () => {
		expect(executionTimeoutMs(700)).toBe(120_000);
	});

	it("scales linearly above 700 chars", () => {
		expect(executionTimeoutMs(1400)).toBe(240_000);
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue.enqueue — return values
// ---------------------------------------------------------------------------

describe("SpeechQueue.enqueue — queue position", () => {
	it("returns 1 for the first enqueued item", () => {
		const q = new SpeechQueue();
		const pos = q.enqueue(baseItem);
		expect(pos).toBe(1);
	});

	it("returns 2 for the second enqueued item", () => {
		const q = new SpeechQueue();
		q.enqueue(baseItem);
		const pos = q.enqueue({ ...baseItem, text: "world" });
		expect(pos).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue.enqueue — starts processing
// ---------------------------------------------------------------------------

describe("SpeechQueue.enqueue — starts processing", () => {
	it("enqueue starts the processor and calls synthesise", async () => {
		const q = new SpeechQueue();
		q.enqueue(baseItem);
		await flushAsync();
		expect(synthesise).toHaveBeenCalledTimes(1);
		expect(vi.mocked(synthesise).mock.calls[0]![0]).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue — processes items in order
// ---------------------------------------------------------------------------

describe("SpeechQueue — sequential processing", () => {
	it("processes two enqueued items in order", async () => {
		const q = new SpeechQueue();
		q.enqueue(baseItem);
		q.enqueue({ ...baseItem, text: "world" });
		await flushAsync();

		expect(synthesise).toHaveBeenCalledTimes(2);
		expect(vi.mocked(synthesise).mock.calls[0]![0]).toBe("hello");
		expect(vi.mocked(synthesise).mock.calls[1]![0]).toBe("world");
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue.clear
// ---------------------------------------------------------------------------

describe("SpeechQueue.clear", () => {
	it("removes pending items so the second item is never processed", async () => {
		// First synthesise blocks until we resolve manually
		let resolveSynthesize!: (v: { wav: number[]; sampleRate: number; duration: number[] }) => void;
		vi.mocked(synthesise)
			.mockImplementationOnce(() => new Promise<{ wav: number[]; sampleRate: number; duration: number[] }>((res) => {
				resolveSynthesize = res;
			}))
			.mockResolvedValue({ wav: [], sampleRate: 44100, duration: [0.1] });

		const q = new SpeechQueue();
		q.enqueue(baseItem);
		q.enqueue({ ...baseItem, text: "world" });

		// Clear while the first item is being processed
		q.clear();

		// Resolve the first synthesise
		resolveSynthesize({ wav: [], sampleRate: 44100, duration: [0.1] });
		await flushAsync();

		// Only the first synthesise was called — second item was cleared
		expect(synthesise).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue — error swallowing
// ---------------------------------------------------------------------------

describe("SpeechQueue — error handling", () => {
	it("swallows synthesise errors and continues to the next item", async () => {
		vi.mocked(synthesise)
			.mockRejectedValueOnce(new Error("TTS failed"))
			.mockResolvedValue({ wav: [], sampleRate: 44100, duration: [0.1] });

		const q = new SpeechQueue();
		q.enqueue(baseItem);
		q.enqueue({ ...baseItem, text: "world" });
		await flushAsync();

		// Both items attempted
		expect(synthesise).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue — temp file cleanup
// ---------------------------------------------------------------------------

describe("SpeechQueue — temp file cleanup", () => {
	it("deletes the tmp file in finally even when synthesise throws", async () => {
		vi.mocked(synthesise).mockRejectedValue(new Error("fail"));

		const q = new SpeechQueue();
		q.enqueue(baseItem);
		await flushAsync();

		expect(unlinkSync).toHaveBeenCalled();
	});

	it("deletes the tmp file in finally on success", async () => {
		const q = new SpeechQueue();
		q.enqueue(baseItem);
		await flushAsync();

		expect(unlinkSync).toHaveBeenCalled();
	});
});
