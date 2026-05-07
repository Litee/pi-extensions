import { describe, expect, it } from "vitest";

import { BashFilter } from "../src/bash-filter.js";

describe("BashFilter — no rules", () => {
	it("hasRules is false when preset has no allowlist or blocklist", () => {
		const f = new BashFilter({});
		expect(f.hasRules).toBe(false);
	});

	it("hasRules is false when both arrays are empty", () => {
		const f = new BashFilter({ bashAllowlist: [], bashBlocklist: [] });
		expect(f.hasRules).toBe(false);
	});

	it("isSafe returns true for any command when no rules are defined", () => {
		const f = new BashFilter({});
		expect(f.isSafe("rm -rf /")).toBe(true);
	});
});

describe("BashFilter — blocklist only", () => {
	it("blocks a command matching the blocklist", () => {
		const f = new BashFilter({ bashBlocklist: ["\\brm\\b"] });
		expect(f.isSafe("rm -rf node_modules")).toBe(false);
	});

	it("is case-insensitive for the blocklist", () => {
		const f = new BashFilter({ bashBlocklist: ["\\brm\\b"] });
		expect(f.isSafe("RM -rf /tmp")).toBe(false);
	});

	it("allows a command that does not match the blocklist", () => {
		const f = new BashFilter({ bashBlocklist: ["\\brm\\b"] });
		expect(f.isSafe("ls -la")).toBe(true);
	});

	it("blocks when any blocklist pattern matches", () => {
		const f = new BashFilter({ bashBlocklist: ["\\brm\\b", "\\bsudo\\b"] });
		expect(f.isSafe("sudo apt-get install foo")).toBe(false);
	});
});

describe("BashFilter — allowlist only", () => {
	it("allows a command matching the allowlist", () => {
		const f = new BashFilter({ bashAllowlist: ["^\\s*ls\\b"] });
		expect(f.isSafe("ls -la")).toBe(true);
	});

	it("blocks a command not matching the allowlist", () => {
		const f = new BashFilter({ bashAllowlist: ["^\\s*ls\\b"] });
		expect(f.isSafe("someRandomBinary --help")).toBe(false);
	});

	it("allows when any allowlist pattern matches", () => {
		const f = new BashFilter({ bashAllowlist: ["^\\s*ls\\b", "^\\s*cat\\b"] });
		expect(f.isSafe("cat README.md")).toBe(true);
	});
});

describe("BashFilter — both blocklist and allowlist", () => {
	it("blocks a command that is on the allowlist but also hits the blocklist", () => {
		// The blocklist is evaluated first.
		const f = new BashFilter({
			bashAllowlist: ["^\\s*git\\b"],
			bashBlocklist: ["\\bgit\\s+push\\b"],
		});
		expect(f.isSafe("git push origin main")).toBe(false);
	});

	it("allows a command that matches the allowlist and misses the blocklist", () => {
		const f = new BashFilter({
			bashAllowlist: ["^\\s*git\\b"],
			bashBlocklist: ["\\bgit\\s+push\\b"],
		});
		expect(f.isSafe("git status")).toBe(true);
	});

	it("blocks a command that misses both lists", () => {
		const f = new BashFilter({
			bashAllowlist: ["^\\s*git\\b"],
			bashBlocklist: ["\\brm\\b"],
		});
		expect(f.isSafe("node server.js")).toBe(false);
	});
});

describe("BashFilter — hasRules", () => {
	it("is true when only allowlist is non-empty", () => {
		expect(new BashFilter({ bashAllowlist: ["^\\s*ls\\b"] }).hasRules).toBe(true);
	});

	it("is true when only blocklist is non-empty", () => {
		expect(new BashFilter({ bashBlocklist: ["\\brm\\b"] }).hasRules).toBe(true);
	});

	it("is true when both lists are non-empty", () => {
		expect(new BashFilter({ bashAllowlist: ["^\\s*ls\\b"], bashBlocklist: ["\\brm\\b"] }).hasRules).toBe(true);
	});
});
