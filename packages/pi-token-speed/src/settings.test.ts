import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	COLOR_BLAZING,
	COLOR_FAST,
	COLOR_MEDIUM,
	COLOR_SLOW,
	COUNT_STRATEGY,
	DISPLAY_MODE,
	END_TPS_BEHAVIOR,
	SLIDING_WINDOW,
	TPS_THRESHOLD_BLAZING,
	TPS_THRESHOLD_FAST,
	TPS_THRESHOLD_MEDIUM,
	TPS_THRESHOLD_SLOW,
	USE_PROVIDER_TOKENS,
} from "./defaults.js";

describe("Settings", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-token-speed-"));
		// Create the directory before mocking so the singleton can use it
		mkdirSync(tmpDir, { recursive: true });
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => tmpDir,
		}));
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		vi.restoreAllMocks();
		vi.resetModules();
	});

	describe("getDefaultConfig", () => {
		it("returns the default configuration object", async () => {
			const { settings } = await import("./settings.js");
			const config = settings.getDefaultConfig();
			expect(config.display).toBe(DISPLAY_MODE);
			expect(config.countStrategy).toBe(COUNT_STRATEGY);
			expect(config.useProviderTokens).toBe(USE_PROVIDER_TOKENS);
			expect(config.endTpsBehavior).toBe(END_TPS_BEHAVIOR);
			expect(config.slidingWindow).toBe(SLIDING_WINDOW);
			expect(config.tpsSlow).toBe(TPS_THRESHOLD_SLOW);
			expect(config.tpsMedium).toBe(TPS_THRESHOLD_MEDIUM);
			expect(config.tpsFast).toBe(TPS_THRESHOLD_FAST);
			expect(config.tpsBlazing).toBe(TPS_THRESHOLD_BLAZING);
			expect(config.colorSlow).toBe(COLOR_SLOW);
			expect(config.colorMedium).toBe(COLOR_MEDIUM);
			expect(config.colorFast).toBe(COLOR_FAST);
			expect(config.colorBlazing).toBe(COLOR_BLAZING);
		});
	});

	describe("getConfig", () => {
		it("returns defaults when not initialized", async () => {
			const { settings } = await import("./settings.js");
			const config = settings.getConfig();
			expect(config.display).toBe(DISPLAY_MODE);
		});
	});

	describe("initialize", () => {
		it("reads user settings from file", async () => {
			const { settings } = await import("./settings.js");
			const settingsFile = join(tmpDir, "settings.json");
			writeFileSync(
				settingsFile,
				JSON.stringify({
					tokenSpeed: {
						display: "full",
						useProviderTokens: true,
					},
				}),
				"utf-8",
			);
			const config = await settings.initialize();
			expect(config.display).toBe("full");
			expect(config.useProviderTokens).toBe(true);
		});

		it("merges user settings with defaults", async () => {
			const { settings } = await import("./settings.js");
			const settingsFile = join(tmpDir, "settings.json");
			writeFileSync(
				settingsFile,
				JSON.stringify({
					tokenSpeed: {
						display: "tps",
					},
				}),
				"utf-8",
			);
			const config = await settings.initialize();
			expect(config.display).toBe("tps");
			// Other fields should still be defaults
			expect(config.countStrategy).toBe(COUNT_STRATEGY);
			expect(config.slidingWindow).toBe(SLIDING_WINDOW);
		});

		it("returns empty errors for valid user settings", async () => {
			const { settings } = await import("./settings.js");
			const settingsFile = join(tmpDir, "settings.json");
			writeFileSync(
				settingsFile,
				JSON.stringify({
					tokenSpeed: {
						display: "full",
						slidingWindow: 2000,
					},
				}),
				"utf-8",
			);
			await settings.initialize();
			expect(settings.getErrors()).toEqual([]);
		});

		it("reports errors for invalid user settings", async () => {
			const { settings } = await import("./settings.js");
			const settingsFile = join(tmpDir, "settings.json");
			writeFileSync(
				settingsFile,
				JSON.stringify({
					tokenSpeed: {
						display: "invalid",
						slidingWindow: 10,
					},
				}),
				"utf-8",
			);
			await settings.initialize();
			expect(settings.getErrors().length).toBeGreaterThan(0);
		});

		it("handles missing settings file gracefully", async () => {
			const { settings } = await import("./settings.js");
			const config = await settings.initialize();
			expect(config.display).toBe(DISPLAY_MODE);
		});

		it("handles corrupted JSON gracefully", async () => {
			const { settings } = await import("./settings.js");
			const settingsFile = join(tmpDir, "settings.json");
			writeFileSync(settingsFile, "not valid json{{{", "utf-8");
			const config = await settings.initialize();
			expect(config.display).toBe(DISPLAY_MODE);
		});
	});

	describe("setConfig", () => {
		it("writes partial config to file", async () => {
			const { settings } = await import("./settings.js");
			await settings.initialize();
			await settings.setConfig({ display: "full" });
			const settingsFile = join(tmpDir, "settings.json");
			const raw = JSON.parse(
				await import("node:fs").then((fs) => fs.readFileSync(settingsFile, "utf-8")),
			) as { tokenSpeed: { display: string } };
			expect(raw.tokenSpeed.display).toBe("full");
		});

		it("updates cached config after setConfig", async () => {
			const { settings } = await import("./settings.js");
			await settings.initialize();
			await settings.setConfig({ display: "ttft" });
			expect(settings.getConfig().display).toBe("ttft");
		});

		it("merges multiple setConfig calls", async () => {
			const { settings } = await import("./settings.js");
			await settings.initialize();
			await settings.setConfig({ display: "full" });
			await settings.setConfig({ useProviderTokens: true });
			const config = settings.getConfig();
			expect(config.display).toBe("full");
			expect(config.useProviderTokens).toBe(true);
		});
	});
});
