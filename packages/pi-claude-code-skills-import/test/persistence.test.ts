import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const payload = JSON.parse(readFileSync(file, "utf8")) as unknown;
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

	// -- issue #0002 (H5): atomic write leaves no debris --
	it("writeDisabled leaves no .tmp files in the parent directory (issue #0002)", () => {
		const dir = join(tmpRoot, "atomic");
		const p = join(dir, "state.json");
		writeDisabled(p, new Set(["a", "b"]));
		const entries = readdirSync(dir);
		// Only the final file should remain; no `state.json.<pid>.tmp` etc.
		expect(entries).toEqual(["state.json"]);
	});

	it("writeDisabled uses rename-onto-final for atomicity (issue #0002)", () => {
		// Atomicity is observable via the on-disk contract: if the write fails
		// partway, the original file must be intact. We simulate "partway fail"
		// by making the parent directory read-only after seeding the original.
		// A naive `writeFileSync(p, ...)` truncates `p` first and then fails to
		// write the new bytes; an atomic (temp-then-rename) implementation
		// can't even create the temp file, so the original is untouched.
		const dir = join(tmpRoot, "ro-parent");
		mkdirSync(dir, { recursive: true });
		const p = join(dir, "state.json");
		writeDisabled(p, new Set(["original"]));

		chmodSync(dir, 0o555);
		try {
			expect(() => writeDisabled(p, new Set(["clobber"]))).toThrow();
			// Original content must still be on disk after the failed write.
			expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ disabled: ["original"] });
		} finally {
			chmodSync(dir, 0o755);
		}
	});

	it("writeDisabled writes atomically: an existing file is never observed half-written (issue #0002)", () => {
		// Approximation: after writeDisabled succeeds, the final bytes on disk
		// must parse as valid JSON with the expected shape. Any non-atomic
		// implementation that writes N times (e.g. truncate-then-write) would
		// still pass this, but the test is kept as documentation of intent.
		const p = join(tmpRoot, "atomic2.json");
		writeFileSync(p, JSON.stringify({ disabled: ["existing"] }));
		writeDisabled(p, new Set(["next"]));
		const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
		expect(parsed).toEqual({ disabled: ["next"] });
	});
});
