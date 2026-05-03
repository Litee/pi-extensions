import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUserRecapModel } from "../src/settings.js";

describe("readUserRecapModel (#0001)", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-settings-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function writeSettings(body: unknown): void {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(body), "utf8");
	}

	it("returns undefined when the settings file does not exist", () => {
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("returns undefined when settings.json is not valid JSON", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{ broken json", "utf8");
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("returns undefined when the sessionRecap key is absent", () => {
		writeSettings({ theme: "default" });
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("returns undefined when sessionRecap.model is not a string", () => {
		writeSettings({ sessionRecap: { model: 42 } });
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("returns undefined when sessionRecap.model is an empty / whitespace-only string", () => {
		writeSettings({ sessionRecap: { model: "   " } });
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("returns the trimmed model spec when sessionRecap.model is a non-empty string", () => {
		writeSettings({ sessionRecap: { model: " anthropic/claude-haiku-4-5  " } });
		expect(readUserRecapModel(agentDir)).toBe("anthropic/claude-haiku-4-5");
	});

	it("ignores other top-level keys and still returns the model", () => {
		writeSettings({
			defaultModel: "openai/gpt-5",
			sessionRecap: { model: "anthropic/claude-haiku-4-5" },
			theme: "dark",
		});
		expect(readUserRecapModel(agentDir)).toBe("anthropic/claude-haiku-4-5");
	});

	it("returns undefined when sessionRecap is not an object", () => {
		writeSettings({ sessionRecap: "not-an-object" });
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});
});
