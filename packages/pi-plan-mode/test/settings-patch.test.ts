
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDefaultsSnapshot, restoreDefaults, resolveAgentDir } from "../src/settings-patch.js";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-plan-mode-settings-patch-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>;
}

function writeSettings(obj: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(obj), "utf-8");
}

describe("readDefaultsSnapshot", () => {
	it("returns {} when settings.json does not exist", () => {
		expect(readDefaultsSnapshot(agentDir)).toEqual({});
	});

	it("returns {} when settings.json is malformed JSON", () => {
		writeFileSync(join(agentDir, "settings.json"), "{not valid json", "utf-8");
		expect(readDefaultsSnapshot(agentDir)).toEqual({});
	});

	it("extracts the three default keys from a valid settings file", () => {
		writeSettings({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "medium",
			unrelated: "left alone",
		});
		expect(readDefaultsSnapshot(agentDir)).toEqual({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "medium",
		});
	});

	it("omits keys that are not present in the file", () => {
		writeSettings({ defaultModel: "claude-sonnet-4-5" });
		expect(readDefaultsSnapshot(agentDir)).toEqual({
			defaultModel: "claude-sonnet-4-5",
		});
	});
});

describe("restoreDefaults", () => {
	it("overwrites the three keys and leaves unrelated keys untouched", () => {
		writeSettings({
			defaultProvider: "plan-mode-provider",
			defaultModel: "plan-mode-model",
			defaultThinkingLevel: "xhigh",
			theme: "dark",
			shellPath: "/bin/zsh",
		});

		restoreDefaults(agentDir, {
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "medium",
		});

		expect(readSettings()).toEqual({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "medium",
			theme: "dark",
			shellPath: "/bin/zsh",
		});
	});

	it("deletes keys when snapshot values are undefined", () => {
		writeSettings({
			defaultProvider: "plan-mode-provider",
			defaultModel: "plan-mode-model",
			defaultThinkingLevel: "xhigh",
			other: "kept",
		});

		restoreDefaults(agentDir, {});

		expect(readSettings()).toEqual({ other: "kept" });
	});

	it("mixes sets and deletes when the snapshot is partial", () => {
		writeSettings({
			defaultProvider: "plan-mode-provider",
			defaultModel: "plan-mode-model",
			defaultThinkingLevel: "xhigh",
		});

		restoreDefaults(agentDir, { defaultModel: "claude-sonnet-4-5" });

		expect(readSettings()).toEqual({ defaultModel: "claude-sonnet-4-5" });
	});

	it("does not create settings.json when it is missing (no-op)", () => {
		restoreDefaults(agentDir, { defaultModel: "x" });
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	it("does not clobber settings.json when it contains malformed JSON", () => {
		const malformed = "{broken";
		writeFileSync(join(agentDir, "settings.json"), malformed, "utf-8");
		restoreDefaults(agentDir, { defaultModel: "x" });
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(malformed);
	});
});

describe("resolveAgentDir", () => {
	const original = process.env["PI_CODING_AGENT_DIR"];

	afterEach(() => {
		if (original === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = original;
		}
	});

	it("returns homedir() when PI_CODING_AGENT_DIR is '~'", () => {
		process.env["PI_CODING_AGENT_DIR"] = "~";
		expect(resolveAgentDir()).toBe(homedir());
	});

	it("expands ~/ prefix using homedir()", () => {
		process.env["PI_CODING_AGENT_DIR"] = "~/custom-dir";
		expect(resolveAgentDir()).toBe(homedir() + "/custom-dir");
	});

	it("returns the env var verbatim when it is an absolute path", () => {
		process.env["PI_CODING_AGENT_DIR"] = "/tmp/custom-agent-dir";
		expect(resolveAgentDir()).toBe("/tmp/custom-agent-dir");
	});
});

// ---------------------------------------------------------------------------
// resolveAgentDir — empty string env var (branch coverage)
// ---------------------------------------------------------------------------

describe("resolveAgentDir — edge cases", () => {
	const original = process.env["PI_CODING_AGENT_DIR"];

	afterEach(() => {
		if (original === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = original;
		}
	});

	it("returns fallback when PI_CODING_AGENT_DIR is an empty string", () => {
		process.env["PI_CODING_AGENT_DIR"] = "";
		expect(resolveAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	});
});
