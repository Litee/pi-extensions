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
// SpeechQueue — pipeline overlap
// ---------------------------------------------------------------------------

describe("SpeechQueue — pipeline overlap", () => {
	it("synthesises item 2 while item 1 is still playing", async () => {
		// Block item 1's playback so we can observe the overlap.
		let resolvePlay!: () => void;
		vi.mocked(playAudioFile).mockImplementationOnce(
			() => new Promise<void>((res) => { resolvePlay = res; }),
		);

		const q = new SpeechQueue();
		q.enqueue(baseItem);
		q.enqueue({ ...baseItem, text: "world" });

		// Let item 1's synthesis complete; item 2's synthesis should start
		// immediately after, while playback of item 1 is still blocked.
		await flushAsync();

		expect(synthesise).toHaveBeenCalledTimes(2);
		expect(vi.mocked(synthesise).mock.calls[0]![0]).toBe("hello");
		expect(vi.mocked(synthesise).mock.calls[1]![0]).toBe("world");
		// Item 1 is playing; item 2 has not started playing yet.
		expect(vi.mocked(playAudioFile)).toHaveBeenCalledTimes(1);

		// Finish item 1 → item 2 should play immediately (WAV already ready).
		resolvePlay();
		await flushAsync();

		expect(vi.mocked(playAudioFile)).toHaveBeenCalledTimes(2);
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

		// Clear while the first item is being synthesised (before playback starts)
		q.clear();

		// Resolve the first synthesise
		resolveSynthesize({ wav: [], sampleRate: 44100, duration: [0.1] });
		await flushAsync();

		// Only the first synthesise was called — second item was cleared
		expect(synthesise).toHaveBeenCalledTimes(1);
	});

	it("clear during playback stops further items from playing", async () => {
		// Block item 1's playback
		let resolvePlay!: () => void;
		vi.mocked(playAudioFile).mockImplementationOnce(
			() => new Promise<void>((res) => { resolvePlay = res; }),
		);

		const q = new SpeechQueue();
		q.enqueue(baseItem);
		q.enqueue({ ...baseItem, text: "world" });
		await flushAsync(); // item 1 now playing (blocked), item 2 synth started

		q.clear();
		resolvePlay(); // finish item 1 playback
		await flushAsync();

		// Item 2 must not have been played
		expect(vi.mocked(playAudioFile)).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// SpeechQueue — getters (length, isProcessing)
// ---------------------------------------------------------------------------

describe("SpeechQueue — getters", () => {
	it("length reflects queued items before processing starts", () => {
		// Block synthesise so nothing dequeues while we measure
		vi.mocked(synthesise).mockImplementation(
			() => new Promise<never>(() => { /* never resolves */ }),
		);
		const q = new SpeechQueue();
		expect(q.length).toBe(0);
		q.enqueue(baseItem);
		// The first item is immediately shifted off the queue by process(),
		// so queue length is 0 after one enqueue. Enqueue a second item while
		// the first is stuck in synthesis to confirm length === 1.
		q.enqueue({ ...baseItem, text: "world" });
		expect(q.length).toBe(1);
	});

	it("isProcessing returns true while the queue is active", async () => {
		let resolveSynth!: (v: { wav: number[]; sampleRate: number; duration: number[] }) => void;
		vi.mocked(synthesise).mockImplementationOnce(
			() => new Promise<{ wav: number[]; sampleRate: number; duration: number[] }>((res) => { resolveSynth = res; }),
		);

		const q = new SpeechQueue();
		expect(q.isProcessing).toBe(false);
		q.enqueue(baseItem);
		// process() has started but is blocked waiting for synthesise
		expect(q.isProcessing).toBe(true);
		// Let it finish
		resolveSynth({ wav: [], sampleRate: 44100, duration: [0.1] });
		await flushAsync();
		expect(q.isProcessing).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue — onDone callback
// ---------------------------------------------------------------------------

describe("SpeechQueue — onDone callback", () => {
	it("calls onDone after the item finishes playing", async () => {
		const onDone = vi.fn();
		const q = new SpeechQueue();
		q.enqueue({ ...baseItem, onDone });
		await flushAsync();
		expect(onDone).toHaveBeenCalledOnce();
	});

	it("calls onDone even when synthesis fails (item skipped)", async () => {
		vi.mocked(synthesise).mockRejectedValueOnce(new Error("TTS error"));
		const onDone = vi.fn();
		const q = new SpeechQueue();
		q.enqueue({ ...baseItem, onDone });
		await flushAsync();
		expect(onDone).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue — dynamically enqueued item (enqueue while playing, no prefetch)
// ---------------------------------------------------------------------------

describe("SpeechQueue — late-enqueued item (post-prefetch path)", () => {
	it("processes an item enqueued after the prefetch window", async () => {
		// Block playback so we can enqueue a new item WHILE item 1 is playing
		let resolvePlay!: () => void;
		vi.mocked(playAudioFile).mockImplementationOnce(
			() => new Promise<void>((res) => { resolvePlay = res; }),
		);

		const q = new SpeechQueue();
		// Enqueue only one item — no prefetch item at startup
		q.enqueue(baseItem);
		await flushAsync(); // item 1 playing (blocked), no prefetch running

		// Now enqueue item 2 WHILE item 1 is playing and NO prefetch was started
		q.enqueue({ ...baseItem, text: "late item" });

		// Finish item 1 — the queue should pick up the late-enqueued item
		resolvePlay();
		await flushAsync();

		// Both items must have been synthesised
		const calls = vi.mocked(synthesise).mock.calls.map((c) => c[0]);
		expect(calls).toContain("hello");
		expect(calls).toContain("late item");
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue — restart after items arrive during a cleared run
// ---------------------------------------------------------------------------

describe("SpeechQueue — restart after clear with waiting items", () => {
	it("re-starts processing when an item is enqueued while cleared===true but processing===true", async () => {
		// We need the queue to be processing===true but cleared===true
		// so an enqueue() pushes to items without starting a worker.
		// The restart happens at the end of process() when items.length > 0.
		let resolveSynth!: (v: { wav: number[]; sampleRate: number; duration: number[] }) => void;
		vi.mocked(synthesise)
			// Item 1: block synthesis
			.mockImplementationOnce(() => new Promise<{ wav: number[]; sampleRate: number; duration: number[] }>((res) => { resolveSynth = res; }))
			// Item 2 (re-started worker): succeed
			.mockResolvedValue({ wav: [], sampleRate: 44100, duration: [0.1] });

		const q = new SpeechQueue();
		q.enqueue(baseItem); // starts processing; blocks at synthesise
		await flushAsync();  // processing === true, stuck in synthesis

		// Call clear() — sets cleared=true, aborts currentAc
		q.clear();
		// Enqueue a new item while processing===true and cleared===true
		// (enqueue() does NOT start a new worker when isProcessing is true)
		const pos = q.enqueue({ ...baseItem, text: "post-clear item" });
		expect(pos).toBe(2);

		// Unblock item 1's synthesis → process() runs to completion → should restart
		resolveSynth({ wav: [], sampleRate: 44100, duration: [0.1] });
		await flushAsync();

		// The post-clear item must have been synthesised by the restarted worker
		const calls = vi.mocked(synthesise).mock.calls.map((c) => c[0]);
		expect(calls).toContain("post-clear item");
	});
});

// ---------------------------------------------------------------------------
// SpeechQueue — timeout fires and aborts playback (line 126: () => ac.abort())
// ---------------------------------------------------------------------------

describe("SpeechQueue — playback timeout", () => {
	it("aborts playback via AbortController when the timeout elapses", async () => {
		vi.useFakeTimers();

		// playAudioFile resolves when its signal is aborted (mimicking a real player)
		vi.mocked(playAudioFile).mockImplementation((_path, signal) => {
			return new Promise<void>((resolve) => {
				if (signal) {
					signal.addEventListener("abort", () => resolve(), { once: true });
				}
			});
		});

		const q = new SpeechQueue();
		q.enqueue(baseItem); // text = "hello" (5 chars) → 30_000 ms timeout

		// Let synthesis complete (synthesis mock resolves immediately)
		await Promise.resolve();
		await Promise.resolve();

		// Advance fake time past the minimum timeout (30 s)
		vi.advanceTimersByTime(31_000);

		// Allow the abort handler and the promise chain to flush
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// playAudioFile was called and the abort (via timeout) resolved the promise
		expect(vi.mocked(playAudioFile)).toHaveBeenCalled();

		vi.useRealTimers();
	});
});
