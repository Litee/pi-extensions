import { describe, expect, it } from "vitest";
import { findVersionInAncestors } from "../src/index.js";

describe("findVersionInAncestors", () => {
	it("returns the version when package.json is in the start directory", () => {
		const readFile = (p: string) => {
			if (p === "/a/b/package.json")
				return JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.3" });
			throw new Error("ENOENT");
		};
		expect(findVersionInAncestors("/a/b", "@earendil-works/pi-coding-agent", readFile)).toBe("1.2.3");
	});

	it("walks up to a parent directory to find the package.json", () => {
		const readFile = (p: string) => {
			if (p === "/a/package.json")
				return JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "2.0.0" });
			throw new Error("ENOENT");
		};
		expect(findVersionInAncestors("/a/b/c", "@earendil-works/pi-coding-agent", readFile)).toBe("2.0.0");
	});

	it("skips a package.json whose name does not match", () => {
		const readFile = (p: string) => {
			if (p === "/a/b/package.json")
				return JSON.stringify({ name: "something-else", version: "9.9.9" });
			if (p === "/a/package.json")
				return JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "3.0.0" });
			throw new Error("ENOENT");
		};
		expect(findVersionInAncestors("/a/b", "@earendil-works/pi-coding-agent", readFile)).toBe("3.0.0");
	});

	it("returns 'unknown' when version field is missing", () => {
		const readFile = (p: string) => {
			if (p === "/a/package.json")
				return JSON.stringify({ name: "@earendil-works/pi-coding-agent" });
			throw new Error("ENOENT");
		};
		expect(findVersionInAncestors("/a/b", "@earendil-works/pi-coding-agent", readFile)).toBe("unknown");
	});

	it("returns 'unknown' when no matching package.json is found before the filesystem root", () => {
		const readFile = (_p: string) => { throw new Error("ENOENT"); };
		expect(findVersionInAncestors("/a/b", "@earendil-works/pi-coding-agent", readFile)).toBe("unknown");
	});

	it("handles malformed JSON gracefully and keeps walking", () => {
		const readFile = (p: string) => {
			if (p === "/a/b/package.json") return "{ not valid json";
			if (p === "/a/package.json")
				return JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "4.0.0" });
			throw new Error("ENOENT");
		};
		expect(findVersionInAncestors("/a/b", "@earendil-works/pi-coding-agent", readFile)).toBe("4.0.0");
	});
});
