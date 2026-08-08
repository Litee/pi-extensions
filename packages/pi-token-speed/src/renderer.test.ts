import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TokenSpeedEngine } from "./engine.js";
import { Renderer } from "./renderer.js";

vi.mock("./settings.js", () => ({
	settings: {
		getConfig: () => ({
			slidingWindow: 1000,
			countStrategy: "direct" as const,
			useProviderTokens: false,
			endTpsBehavior: "average" as const,
			tpsSlow: 0,
			tpsMedium: 15,
			tpsFast: 30,
			tpsBlazing: 45,
			colorSlow: "#ff4444",
			colorMedium: "#ffaa00",
			colorFast: "#00ff88",
			colorBlazing: "#44ddff",
			display: "full" as const,
		}),
	},
}));

type ThresholdConfig = {
	tpsSlow: number;
	tpsMedium: number;
	tpsFast: number;
	tpsBlazing: number;
	colorSlow: string;
	colorMedium: string;
	colorFast: string;
	colorBlazing: string;
};

describe("Renderer", () => {
	let engine: TokenSpeedEngine;
	let renderer: Renderer;

	beforeEach(() => {
		engine = {
			isStreaming: false,
			tokenCount: 0,
			elapsedMs: 0,
			elapsedSeconds: 0,
			tps: 0,
			tpsAvg: 0,
			ttft: 0,
			start: vi.fn(),
			stop: vi.fn(),
			recordDelta: vi.fn(),
			startTTFT: vi.fn(),
			stopTTFT: vi.fn(),
			reconcileTotal: vi.fn(),
			pause: vi.fn(),
			initialize: vi.fn(),
		} as unknown as TokenSpeedEngine;
		renderer = new Renderer(engine);
	});

	function setEngineValues(ttft: number, tokenCount: number, elapsedSeconds: number) {
		Object.defineProperty(engine, "ttft", { value: ttft, writable: true, configurable: true });
		Object.defineProperty(engine, "tokenCount", { value: tokenCount, writable: true, configurable: true });
		Object.defineProperty(engine, "elapsedSeconds", { value: elapsedSeconds, writable: true, configurable: true });
	}

	describe("colorHex", () => {
		it("returns text unchanged for invalid hex", () => {
			const result = (renderer as unknown as { colorHex: (text: string, hex: string) => string }).colorHex("test", "invalid");
			expect(result).toBe("test");
		});

		it("applies 24-bit truecolor ANSI escape for valid hex", () => {
			const result = (renderer as unknown as { colorHex: (text: string, hex: string) => string }).colorHex("test", "#ff0000");
			expect(result).toBe("\x1b[38;2;255;0;0mtest\x1b[0m");
		});

		it("applies correct RGB values", () => {
			const result = (renderer as unknown as { colorHex: (text: string, hex: string) => string }).colorHex("test", "#00ff88");
			expect(result).toBe("\x1b[38;2;0;255;136mtest\x1b[0m");
		});
	});

	describe("getColor", () => {
		const thresholds: ThresholdConfig = {
			tpsSlow: 0,
			tpsMedium: 15,
			tpsFast: 30,
			tpsBlazing: 45,
			colorSlow: "#ff4444",
			colorMedium: "#ffaa00",
			colorFast: "#00ff88",
			colorBlazing: "#44ddff",
		};

		it("returns empty string for null tps", () => {
			const getColor = (renderer as unknown as { getColor: (config: ThresholdConfig, tps: number | null) => string }).getColor;
			expect(getColor(thresholds, null)).toBe("");
		});

		it("returns blazing color for high TPS", () => {
			const getColor = (renderer as unknown as { getColor: (config: ThresholdConfig, tps: number | null) => string }).getColor;
			expect(getColor(thresholds, 50)).toBe("#44ddff");
		});

		it("returns fast color for medium-high TPS", () => {
			const getColor = (renderer as unknown as { getColor: (config: ThresholdConfig, tps: number | null) => string }).getColor;
			expect(getColor(thresholds, 35)).toBe("#00ff88");
		});

		it("returns medium color for low TPS", () => {
			const getColor = (renderer as unknown as { getColor: (config: ThresholdConfig, tps: number | null) => string }).getColor;
			expect(getColor(thresholds, 20)).toBe("#ffaa00");
		});

		it("returns slow color for very low TPS", () => {
			const getColor = (renderer as unknown as { getColor: (config: ThresholdConfig, tps: number | null) => string }).getColor;
			expect(getColor(thresholds, 5)).toBe("#ff4444");
		});

		it("returns empty for below slow threshold", () => {
			const getColor = (renderer as unknown as { getColor: (config: ThresholdConfig, tps: number | null) => string }).getColor;
			expect(getColor(thresholds, -1)).toBe("");
		});
	});

	describe("formatStats", () => {
		it("shows just token count when elapsed is 0", () => {
			const formatStats = (renderer as unknown as { formatStats: (tokenCount: number, elapsedSeconds: number) => string }).formatStats;
			const result = formatStats(42, 0);
			expect(result).toBe("42 tok");
		});

		it("shows token count and elapsed time", () => {
			const formatStats = (renderer as unknown as { formatStats: (tokenCount: number, elapsedSeconds: number) => string }).formatStats;
			const result = formatStats(42, 2.5);
			expect(result).toBe("42 tok in 2.5s");
		});

		it("rounds elapsed to 1 decimal", () => {
			const formatStats = (renderer as unknown as { formatStats: (tokenCount: number, elapsedSeconds: number) => string }).formatStats;
			const result = formatStats(100, 3.14159);
			expect(result).toBe("100 tok in 3.1s");
		});
	});

	describe("buildSuffix", () => {
		it("returns zero-width space for tps display mode", () => {
			setEngineValues(500, 100, 2.5);
			const result = (renderer as unknown as { buildSuffix: (display: string) => string }).buildSuffix("tps");
			expect(result).toBe("\u200b");
		});

		it("returns TTFT suffix for ttft display mode", () => {
			setEngineValues(500, 100, 2.5);
			const result = (renderer as unknown as { buildSuffix: (display: string) => string }).buildSuffix("ttft");
			expect(result).toBe(" (TTFT: 500 ms)\u200b");
		});

		it("returns stats suffix for stats display mode", () => {
			setEngineValues(500, 100, 2.5);
			const result = (renderer as unknown as { buildSuffix: (display: string) => string }).buildSuffix("stats");
			expect(result).toBe(" (100 tok in 2.5s)\u200b");
		});

		it("returns full suffix for full display mode", () => {
			setEngineValues(500, 100, 2.5);
			const result = (renderer as unknown as { buildSuffix: (display: string) => string }).buildSuffix("full");
			expect(result).toBe(" (100 tok in 2.5s · TTFT: 500 ms)\u200b");
		});
	});
});
