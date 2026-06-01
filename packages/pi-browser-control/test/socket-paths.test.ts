/**
 * Tests for src/socket-paths.ts
 * Path helpers that resolve to ~/.pi/agent (or $PI_CODING_AGENT_DIR).
 *
 * Env isolation: all tests call resolveAgentDir() with an explicit env object
 * and pass the resulting agentDir into the path helpers. No global env mutation.
 */

import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	resolveAgentDir,
	sockPath,
	logPath,
	launcherPath,
	manifestPath,
	GECKO_EXTENSION_ID,
	NM_HOST_NAME,
} from "../src/socket-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("resolveAgentDir", () => {
	it("returns PI_CODING_AGENT_DIR when set", () => {
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/test-agent-dir" })).toBe(
			"/tmp/test-agent-dir",
		);
	});

	it("falls back to ~/.pi/agent when env is unset", () => {
		const expected = join(homedir(), ".pi", "agent");
		expect(resolveAgentDir({})).toBe(expected);
	});

	it("falls back to ~/.pi/agent when PI_CODING_AGENT_DIR is undefined", () => {
		const expected = join(homedir(), ".pi", "agent");
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: undefined })).toBe(expected);
	});
});

describe("socket-paths — sockPath", () => {
	it("uses PI_CODING_AGENT_DIR when set", () => {
		const agentDir = resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/test-agent-dir" });
		expect(sockPath(agentDir)).toBe("/tmp/test-agent-dir/pi-browser-control.sock");
	});

	it("falls back to ~/.pi/agent when env is unset", () => {
		const agentDir = resolveAgentDir({});
		const expected = join(homedir(), ".pi", "agent", "pi-browser-control.sock");
		expect(sockPath(agentDir)).toBe(expected);
	});
});

describe("socket-paths — logPath", () => {
	it("returns <agentDir>/pi-browser-control-daemon.log", () => {
		const agentDir = resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/test-agent-dir" });
		expect(logPath(agentDir)).toBe("/tmp/test-agent-dir/pi-browser-control-daemon.log");
	});
});

describe("socket-paths — launcherPath", () => {
	it("returns <agentDir>/pi-browser-control/launch", () => {
		const agentDir = resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/test-agent-dir" });
		expect(launcherPath(agentDir)).toBe("/tmp/test-agent-dir/pi-browser-control/launch");
	});
});

describe("socket-paths — manifestPath", () => {
	it("returns macOS NM manifest path", () => {
		const expected = join(
			homedir(),
			"Library",
			"Application Support",
			"Mozilla",
			"NativeMessagingHosts",
			"pi_browser_control.json",
		);
		expect(manifestPath()).toBe(expected);
	});
});

describe("socket-paths — constants", () => {
	it("exports GECKO_EXTENSION_ID", () => {
		expect(GECKO_EXTENSION_ID).toBe("pi-browser-control@earendil-works");
	});

	it("exports NM_HOST_NAME", () => {
		expect(NM_HOST_NAME).toBe("pi_browser_control");
	});

	it("GECKO_EXTENSION_ID matches the value in firefox-addon/manifest.json", () => {
		const addonManifestPath = resolve(__dirname, "../firefox-addon/manifest.json");
		const manifest = JSON.parse(readFileSync(addonManifestPath, "utf-8")) as {
			browser_specific_settings?: { gecko?: { id?: string } };
		};
		expect(manifest.browser_specific_settings?.gecko?.id).toBe(GECKO_EXTENSION_ID);
	});
});
