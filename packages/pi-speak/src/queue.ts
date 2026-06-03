/**
 * Async background speech queue.
 *
 * Items are processed with a double-buffer pipeline: while item N plays,
 * item N+1 is already being synthesised in the background, eliminating the
 * synthesis gap between items.
 * The queue never blocks callers — enqueue returns immediately with a
 * 1-based sequence number (queue position at time of enqueue).
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { playAudioFile } from "./audio.js";
import { synthesise, writeWav } from "./tts.js";
import type { LangCode, VoiceId } from "./schema.js";

// ---------------------------------------------------------------------------
// Timeout helper (exported so index.ts can remove its duplicate)
// ---------------------------------------------------------------------------

/**
 * Safety-net execution timeout derived from text length.
 * 2× the expected speech duration (700 chars ≈ 60 s), minimum 30 s.
 */
export function executionTimeoutMs(charCount: number): number {
	return Math.max(30_000, Math.ceil((charCount / 700) * 120_000));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueItem {
	id: number;
	text: string;
	voice: VoiceId;
	lang: LangCode;
	speed: number;
	steps: number;
	assetsDir: string;
	/** Called after this specific item finishes playing (or is skipped due to synthesis error). */
	onDone?: () => void;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export class SpeechQueue {
	private items: QueueItem[] = [];
	private processing = false;
	private counter = 0;
	private currentAc: AbortController | undefined;
	private cleared = false;

	get length(): number { return this.items.length; }
	get isProcessing(): boolean { return this.processing; }

	/**
	 * Add an item; start the processor if idle.
	 * Returns the 1-based sequence number (queue position at time of enqueue).
	 */
	enqueue(item: Omit<QueueItem, "id">): number {
		const queued: QueueItem = { ...item, id: ++this.counter };
		this.items.push(queued);
		if (!this.processing) void this.process();
		return this.counter;
	}

	/** Cancel the current item and clear all pending items. */
	clear(): void {
		this.items = [];
		this.cleared = true;
		this.currentAc?.abort();
	}

	/** Synthesise item to a temp WAV file. Returns the path, or null on error. */
	private async synthesiseToFile(item: QueueItem): Promise<string | null> {
		const tmpPath = join(tmpdir(), `pi-speak-${item.id}-${Date.now()}.wav`);
		try {
			const result = await synthesise(
				item.text,
				{ voice: item.voice, lang: item.lang, speed: item.speed, steps: item.steps },
				item.assetsDir,
			);
			await writeWav(tmpPath, result.wav, result.sampleRate);
			return tmpPath;
		} catch {
			// Synthesis failed — skip this item
			try { unlinkSync(tmpPath); } catch { /* ignore */ }
			return null;
		}
	}

	private async process(): Promise<void> {
		this.processing = true;
		this.cleared = false;

		let currentItem: QueueItem | undefined = this.items.shift();
		if (!currentItem) { this.processing = false; return; }

		let currentSynth: Promise<string | null> = this.synthesiseToFile(currentItem);

		while (currentItem) {
			const item = currentItem;

			// Wait for the current item's WAV to be ready.
			const tmpPath = await currentSynth;

			// Immediately start synthesising the next item so it runs
			// concurrently with playback of the current item — this is the
			// key pipeline overlap: by the time current playback ends, the
			// next WAV is already on disk.
			const nextItem: QueueItem | undefined = this.items.shift();
			const nextSynth: Promise<string | null> | null = nextItem
				? this.synthesiseToFile(nextItem)
				: null;

			// Play the current item.
			if (tmpPath) {
				const ac = new AbortController();
				this.currentAc = ac;
				const timeoutHandle = setTimeout(
					() => ac.abort(),
					executionTimeoutMs(item.text.length),
				);
				try {
					await playAudioFile(tmpPath, ac.signal);
				} catch {
					// Swallow — timeout, abort, or player error; queue continues.
				} finally {
					clearTimeout(timeoutHandle);
					this.currentAc = undefined;
					try { unlinkSync(tmpPath); } catch { /* ignore */ }
				}
			}
			// Fire per-item callback after this item finishes (or was skipped).
			item.onDone?.();

			// If clear() was called during synthesis or playback, discard any
			// prefetched WAV and stop the pipeline.
			if (this.cleared) {
				if (nextSynth) {
					void nextSynth.then((p) => {
						if (p) try { unlinkSync(p); } catch { /* ignore */ }
					});
				}
				break;
			}

			// Advance to the pre-synthesised next item.
			if (nextItem) {
				currentItem = nextItem;
				currentSynth = nextSynth!;
			} else {
				// No prefetch was possible — pick up any items that were
				// enqueued while we were playing.
				currentItem = this.items.shift();
				if (currentItem) {
					currentSynth = this.synthesiseToFile(currentItem);
				} else {
					break;
				}
			}
		}

		this.processing = false;
		// An enqueue() that arrived while cleared was true (and processing was
		// still true) would have pushed to this.items without kicking a worker.
		// Restart if anything is waiting.
		if (this.items.length > 0) {
			void this.process();
		}
	}
}
