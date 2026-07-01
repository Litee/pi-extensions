import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isLocalHeadroomUrl, loadHeadroomConfig, loadHeadroomSettings } from "../src/config.ts";

describe("headroom config", () => {
	it("defaults to local compression-only proxy with conservative thresholds", () => {
		const config = loadHeadroomConfig({});

		expect(config.enabled).toBe(true);
		expect(config.baseUrl).toBe("http://127.0.0.1:8788");
		expect(config.command).toBe("headroom");
		expect(config.minContextTokens).toBe(20_000);
		expect(config.minMessageChars).toBe(2_000);
		expect(config.timeoutMs).toBe(30_000);
	});

	it("recognises local vs remote proxy URLs", () => {
		expect(isLocalHeadroomUrl("http://127.0.0.1:8788")).toBe(true);
		expect(isLocalHeadroomUrl("http://localhost:8788")).toBe(true);
		expect(isLocalHeadroomUrl("http://[::1]:8788")).toBe(true);
		expect(isLocalHeadroomUrl("https://headroom.example.com/")).toBe(false);
		expect(isLocalHeadroomUrl("https://headroom.internal.corp/edge")).toBe(false);
		expect(isLocalHeadroomUrl("http://192.168.1.10:8788")).toBe(false);
	});

	it("parses boolean and integer env overrides", () => {
		const config = loadHeadroomConfig({
			PI_HEADROOM_ENABLED: "off",
			PI_HEADROOM_MIN_CONTEXT_TOKENS: "1000",
			PI_HEADROOM_MIN_MESSAGE_CHARS: "500",
			PI_HEADROOM_TIMEOUT_MS: "3000",
			PI_HEADROOM_COMMAND: "custom-headroom",
		});

		expect(config.enabled).toBe(false);
		expect(config.command).toBe("custom-headroom");
		expect(config.minContextTokens).toBe(1000);
		expect(config.minMessageChars).toBe(500);
		expect(config.timeoutMs).toBe(3000);
	});

	it("loads settings.json overrides", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-settings-"));
		try {
			const settingsPath = path.join(tmpDir, "pi-headroom.json");
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					enabled: false,
					baseUrl: "http://localhost:9999/",
					command: "custom-headroom",
					minContextTokens: 12345,
					minMessageChars: 678,
					timeoutMs: 4321,
				}),
				"utf-8",
			);

			const config = loadHeadroomConfig({}, loadHeadroomSettings(settingsPath));

			expect(config.enabled).toBe(false);
			expect(config.baseUrl).toBe("http://localhost:9999");
			expect(config.command).toBe("custom-headroom");
			expect(config.minContextTokens).toBe(12345);
			expect(config.minMessageChars).toBe(678);
			expect(config.timeoutMs).toBe(4321);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("lets settings.json override env values", () => {
		const config = loadHeadroomConfig(
			{
				PI_HEADROOM_MIN_CONTEXT_TOKENS: "1000",
				PI_HEADROOM_MIN_MESSAGE_CHARS: "500",
			},
			{
				minContextTokens: 30000,
				minMessageChars: "4000",
			},
		);

		expect(config.minContextTokens).toBe(30000);
		expect(config.minMessageChars).toBe(4000);
	});
});
