import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
import { readFileSync } from "node:fs";

import { loadConfig } from "../src/config.js";

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
