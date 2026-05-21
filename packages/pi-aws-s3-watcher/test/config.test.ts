import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/fake/agent",
}));

import { configFilePath, loadConfig, saveConfig } from "../src/config.js";

beforeEach(() => {
	vi.mocked(readFileSync).mockImplementation(() => {
		const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		throw err;
	});
});

describe("loadConfig", () => {
	it("returns {} when the config file is missing", () => {
		expect(loadConfig()).toEqual({});
	});

	it("returns {} and does not throw when the file contains invalid JSON", () => {
		vi.mocked(readFileSync).mockReturnValue("not json");
		expect(() => loadConfig()).not.toThrow();
		expect(loadConfig()).toEqual({});
	});

	it("returns {} when the file read throws a non-ENOENT error", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});
		expect(loadConfig()).toEqual({});
	});

	it("returns { defaultDisplayMode: 'widget' } when the file is valid", () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ defaultDisplayMode: "widget" }),
		);
		expect(loadConfig()).toEqual({ defaultDisplayMode: "widget" });
	});

	it("returns { defaultDisplayMode: 'statusline' } when the file is valid", () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ defaultDisplayMode: "statusline" }),
		);
		expect(loadConfig()).toEqual({ defaultDisplayMode: "statusline" });
	});

	it("strips defaultDisplayMode when the value is not one of the supported modes", () => {
		// Issue framing used "inline" as an illustrative example; the real
		// modes are "widget" and "statusline". An unsupported value must NOT
		// poison the runtime — it is silently ignored.
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ defaultDisplayMode: "inline" }),
		);
		expect(loadConfig()).toEqual({});
	});

	it("strips defaultDisplayMode when the value is not a string", () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ defaultDisplayMode: 42 }),
		);
		expect(loadConfig()).toEqual({});
	});

	it("returns {} when the JSON root is not an object", () => {
		vi.mocked(readFileSync).mockReturnValue("[]");
		expect(loadConfig()).toEqual({});
	});

	it("returns {} when the JSON root is null", () => {
		vi.mocked(readFileSync).mockReturnValue("null");
		expect(loadConfig()).toEqual({});
	});

	it("ignores unknown keys but keeps a valid defaultDisplayMode", () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ defaultDisplayMode: "statusline", future: "key" }),
		);
		expect(loadConfig()).toEqual({ defaultDisplayMode: "statusline" });
	});
});

describe("configFilePath", () => {
	it("resolves under getAgentDir()", () => {
		expect(configFilePath()).toBe("/fake/agent/pi-aws-s3-watcher.json");
	});
});

describe("saveConfig", () => {
	beforeEach(() => {
		vi.mocked(mkdirSync).mockReset();
		vi.mocked(writeFileSync).mockReset();
	});

	it("returns true on a clean write and persists merged JSON to the agent dir", () => {
		// loadConfig() returns {} via the ENOENT mock from the outer beforeEach.
		vi.mocked(mkdirSync).mockReturnValue(undefined);
		vi.mocked(writeFileSync).mockReturnValue(undefined);
		const ok = saveConfig({ defaultDisplayMode: "statusline" });
		expect(ok).toBe(true);
		expect(mkdirSync).toHaveBeenCalledWith("/fake/agent", { recursive: true });
		expect(writeFileSync).toHaveBeenCalledTimes(1);
		const [path, body] = vi.mocked(writeFileSync).mock.calls[0]!;
		expect(path).toBe("/fake/agent/pi-aws-s3-watcher.json");
		expect(JSON.parse(body as string)).toEqual({ defaultDisplayMode: "statusline" });
		// Trailing newline for POSIX-friendly text files.
		expect((body as string).endsWith("\n")).toBe(true);
	});

	it("merges over an existing file and preserves unknown keys for forward-compat", () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ defaultDisplayMode: "widget", futureField: "keep-me" }),
		);
		vi.mocked(mkdirSync).mockReturnValue(undefined);
		vi.mocked(writeFileSync).mockReturnValue(undefined);
		const ok = saveConfig({ defaultDisplayMode: "statusline" });
		expect(ok).toBe(true);
		const body = vi.mocked(writeFileSync).mock.calls[0]![1] as string;
		const parsed = JSON.parse(body) as Record<string, unknown>;
		expect(parsed["defaultDisplayMode"]).toBe("statusline");
		// Forward-compat contract: saveConfig must NOT clobber unknown keys
		// (loadConfig drops them, but saveConfig reads raw JSON before merging).
		expect(parsed["futureField"]).toBe("keep-me");
	});

	it("returns false on writeFileSync failure", () => {
		vi.mocked(mkdirSync).mockReturnValue(undefined);
		vi.mocked(writeFileSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(saveConfig({ defaultDisplayMode: "widget" })).toBe(false);
	});

	it("returns false on mkdirSync failure", () => {
		vi.mocked(mkdirSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(saveConfig({ defaultDisplayMode: "widget" })).toBe(false);
	});
});
