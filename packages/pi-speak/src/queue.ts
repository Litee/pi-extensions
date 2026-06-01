/**
 * Async background speech queue.
 *
 * Items are processed sequentially: synthesise → play → next.
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
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export class SpeechQueue {
	private items: QueueItem[] = [];
	private processing = false;
	private counter = 0;
	private currentAc: AbortController | undefined;

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
		this.currentAc?.abort();
	}

	private async process(): Promise<void> {
		this.processing = true;
		while (this.items.length > 0) {
			const item = this.items.shift()!;
			await this.processOne(item);
		}
		this.processing = false;
	}

	private async processOne(item: QueueItem): Promise<void> {
		const ac = new AbortController();
		this.currentAc = ac;
		const tmpPath = join(tmpdir(), `pi-speak-${item.id}-${Date.now()}.wav`);
		const timeoutHandle = setTimeout(() => ac.abort(), executionTimeoutMs(item.text.length));
		try {
			const result = await synthesise(
				item.text,
				{ voice: item.voice, lang: item.lang, speed: item.speed, steps: item.steps },
				item.assetsDir,
			);
			await writeWav(tmpPath, result.wav, result.sampleRate);
			await playAudioFile(tmpPath, ac.signal);
		} catch {
			// Swallow errors — queue continues regardless
		} finally {
			clearTimeout(timeoutHandle);
			this.currentAc = undefined;
			try { unlinkSync(tmpPath); } catch { /* ignore */ }
		}
	}
}
