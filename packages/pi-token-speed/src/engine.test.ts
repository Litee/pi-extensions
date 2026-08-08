import { beforeEach, describe, expect, it } from "vitest";

import { TokenSpeedEngine } from "./engine.js";

describe("TokenSpeedEngine", () => {
	let engine: TokenSpeedEngine;

	beforeEach(() => {
		engine = new TokenSpeedEngine();
		engine.initialize();
	});

	describe("start / stop", () => {
		it("is not streaming initially", () => {
			expect(engine.isStreaming).toBe(false);
		});

		it("becomes streaming after start", () => {
			engine.start();
			expect(engine.isStreaming).toBe(true);
		});

		it("stops streaming after stop", () => {
			engine.start();
			engine.stop();
			expect(engine.isStreaming).toBe(false);
		});

		it("double-start is a no-op", () => {
			engine.start();
			engine.start();
			expect(engine.isStreaming).toBe(true);
		});
	});

	describe("token counting", () => {
		it("records 1 token per delta in direct mode", () => {
			engine.start();
			engine.recordDelta("hello");
			engine.recordDelta(" world");
			expect(engine.tokenCount).toBe(2);
		});

		it("does not record when not streaming", () => {
			engine.recordDelta("hello");
			expect(engine.tokenCount).toBe(0);
		});

		it("counts 1 token per delta even with usageOutput when useProviderTokens is false", () => {
			engine.start();
			engine.recordDelta("hello", 5);
			// Default config has useProviderTokens=false, so falls back to direct counting
			expect(engine.tokenCount).toBe(1);
		});
	});

	describe("delta edge cases", () => {
		it("counts 1 for non-empty delta", () => {
			engine.start();
			engine.recordDelta("hello world foo");
			expect(engine.tokenCount).toBe(1);
		});

		it("counts 1 for empty delta in direct mode (default config)", () => {
			engine.start();
			engine.recordDelta("");
			expect(engine.tokenCount).toBe(1);
		});
	});

	describe("reconcileTotal", () => {
		it("sets tokenCount to authoritative count", () => {
			engine.start();
			engine.recordDelta("hello");
			engine.recordDelta(" world");
			expect(engine.tokenCount).toBe(2);
			engine.reconcileTotal(100);
			expect(engine.tokenCount).toBe(100);
		});

		it("ignores zero or negative reconcile", () => {
			engine.start();
			engine.recordDelta("hello");
			engine.reconcileTotal(0);
			expect(engine.tokenCount).toBe(1);
			engine.reconcileTotal(-1);
			expect(engine.tokenCount).toBe(1);
		});
	});

	describe("elapsed time", () => {
		it("returns 0 elapsed before start", () => {
			expect(engine.elapsedMs).toBe(0);
			expect(engine.elapsedSeconds).toBe(0);
		});

		it("reports elapsed time during streaming", () => {
			engine.start();
			const elapsed = engine.elapsedMs;
			expect(elapsed).toBeGreaterThanOrEqual(0);
		});

		it("reports final elapsed time after stop", async () => {
			engine.start();
			await new Promise((r) => setTimeout(r, 10));
			engine.stop();
			expect(engine.elapsedMs).toBeGreaterThan(0);
		});

		it("computes average TPS after streaming ends", async () => {
			engine.start();
			engine.recordDelta("hello");
			engine.recordDelta(" world");
			await new Promise((r) => setTimeout(r, 10));
			engine.stop();
			expect(engine.tpsAvg).toBeGreaterThan(0);
		});
	});

	describe("TPS", () => {
		it("returns 0 TPS before start", () => {
			expect(engine.tps).toBe(0);
		});

		it("computes average TPS after streaming ends", async () => {
			engine.start();
			engine.recordDelta("hello");
			engine.recordDelta(" world");
			await new Promise((r) => setTimeout(r, 10));
			engine.stop();
			expect(engine.tpsAvg).toBeGreaterThan(0);
		});

		it("returns sliding window TPS while streaming", () => {
			engine.start();
			engine.recordDelta("hello");
			expect(engine.tps).toBeGreaterThanOrEqual(0);
		});

		it("returns average TPS after stop when endTpsBehavior is average", async () => {
			engine.start();
			engine.recordDelta("hello");
			await new Promise((r) => setTimeout(r, 10));
			engine.stop();
			expect(engine.tps).toBe(engine.tpsAvg);
		});
	});

	describe("TTFT", () => {
		it("returns 0 TTFT before startTTFT", () => {
			expect(engine.ttft).toBe(0);
		});

		it("captures TTFT when startTTFT and stopTTFT are called", () => {
			engine.startTTFT();
			engine.stopTTFT();
			expect(engine.ttft).toBeGreaterThanOrEqual(0);
		});

		it("captures TTFT only once", () => {
			engine.startTTFT();
			engine.stopTTFT();
			const firstTTFT = engine.ttft;
			// Simulate time passing
			engine.stopTTFT();
			expect(engine.ttft).toBe(firstTTFT);
		});
	});

	describe("pause / resume", () => {
		it("pauses the timer", () => {
			engine.start();
			engine.pause();
			engine.recordDelta("hello");
			// After resume, delta should be counted
			expect(engine.tokenCount).toBe(1);
		});

		it("resumes on next recordDelta", () => {
			engine.start();
			engine.pause();
			engine.recordDelta("hello");
			engine.recordDelta(" world");
			expect(engine.tokenCount).toBe(2);
		});
	});
});
