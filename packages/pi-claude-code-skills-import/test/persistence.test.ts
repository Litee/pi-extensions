import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDisabled, writeDisabled } from "../src/persistence.js";

describe("persistence: readDisabled / writeDisabled", () => {
	let tmpRoot: string;
	let file: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-persist-"));
		file = join(tmpRoot, "nested", "state.json");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("readDisabled returns an empty set when the file does not exist", () => {
		expect(readDisabled(file).size).toBe(0);
	});

	it("readDisabled returns an empty set for invalid JSON", () => {
		writeFileSync(file.replace(/\/nested\//, "/"), "not json");
		expect(readDisabled(file.replace(/\/nested\//, "/")).size).toBe(0);
	});

	it("readDisabled returns an empty set when disabled is not an array", () => {
		const p = join(tmpRoot, "state.json");
		writeFileSync(p, JSON.stringify({ disabled: "not-an-array" }));
		expect(readDisabled(p).size).toBe(0);
	});

	it("readDisabled returns a Set of the disabled ids", () => {
		const p = join(tmpRoot, "state.json");
		writeFileSync(p, JSON.stringify({ disabled: ["a", "b", "c"] }));
		const got = readDisabled(p);
		expect(got).toBeInstanceOf(Set);
		expect([...got].sort()).toEqual(["a", "b", "c"]);
	});

	it("writeDisabled creates parent directories as needed", () => {
		writeDisabled(file, new Set(["a"]));
		expect(existsSync(file)).toBe(true);
	});

	it("writeDisabled persists a JSON payload with sorted disabled array", () => {
		writeDisabled(file, new Set(["zulu", "alpha", "mike"]));
		const payload = JSON.parse(readFileSync(file, "utf8"));
		expect(payload).toEqual({ disabled: ["alpha", "mike", "zulu"] });
	});

	it("round-trips: writeDisabled then readDisabled returns the same set", () => {
		const input = new Set(["x", "y", "z"]);
		writeDisabled(file, input);
		expect(readDisabled(file)).toEqual(input);
	});

	it("writeDisabled overwrites an existing file", () => {
		writeDisabled(file, new Set(["old"]));
		writeDisabled(file, new Set(["new"]));
		expect(readDisabled(file)).toEqual(new Set(["new"]));
	});
});
