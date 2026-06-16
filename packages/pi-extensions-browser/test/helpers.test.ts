import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
	homedir: vi.fn(() => "/home/testuser"),
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER mocks are hoisted)
// ---------------------------------------------------------------------------

import {
	buildSummary,
	checkHealth,
	deriveName,
	detectKind,
	filterEntries,
	isLocalPathMissing,
	loadEntries,
	markConflicts,
	readPackageName,
	resolveHome,
	type ExtPackageEntry,
} from "../src/helpers.js";

// ---------------------------------------------------------------------------
// Typed mock handles
// ---------------------------------------------------------------------------

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkEntry(overrides: Partial<ExtPackageEntry> = {}): ExtPackageEntry {
	return {
		name: "my-ext",
		raw: "/some/path",
		spec: "/some/path",
		scope: "user",
		kind: "local",
		health: "ok",
		disabled: false,
		conflict: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// detectKind
// ---------------------------------------------------------------------------

describe("detectKind", () => {
	it("absolute path starting with / → 'local'", () => {
		expect(detectKind("/foo/bar")).toBe("local");
	});

	it("tilde path ~/foo → 'local'", () => {
		expect(detectKind("~/foo")).toBe("local");
	});

	it("relative path ./foo → 'local'", () => {
		expect(detectKind("./foo")).toBe("local");
	});

	it("windows-style tilde path ~\\foo → 'local'", () => {
		expect(detectKind("~\\foo")).toBe("local");
	});

	it("npm: prefixed spec → 'npm'", () => {
		expect(detectKind("npm:some-pkg@1.0")).toBe("npm");
	});

	it("npm: scoped package → 'npm'", () => {
		expect(detectKind("npm:@scope/pkg")).toBe("npm");
	});

	it("git+https URL → 'other'", () => {
		expect(detectKind("git+https://github.com/owner/repo")).toBe("other");
	});

	it("relative path ../foo → 'local'", () => {
		expect(detectKind("../some/path")).toBe("local");
	});

	it("plain unrecognized string → 'other'", () => {
		expect(detectKind("some-package-name")).toBe("other");
	});
});

// ---------------------------------------------------------------------------
// resolveHome
// ---------------------------------------------------------------------------

describe("resolveHome", () => {
	it("expands ~/foo/bar to /home/testuser/foo/bar", () => {
		expect(resolveHome("~/foo/bar")).toBe(join("/home/testuser", "foo/bar"));
	});

	it("leaves an absolute path unchanged", () => {
		expect(resolveHome("/usr/local/lib/ext")).toBe("/usr/local/lib/ext");
	});

	it("expands windows-style ~\\foo correctly", () => {
		expect(resolveHome("~\\foo")).toBe(join("/home/testuser", "foo"));
	});

	it("leaves a path without a leading ./ or ~/ unchanged", () => {
		expect(resolveHome("relative-path")).toBe("relative-path");
	});

	it("leaves a plain string without tilde unchanged", () => {
		expect(resolveHome("no-tilde-here")).toBe("no-tilde-here");
	});

	it("resolves ./ path against explicit cwd", () => {
		expect(resolveHome("./some/path", "/base/dir")).toBe("/base/dir/some/path");
	});

	it("resolves ../ path against explicit cwd", () => {
		expect(resolveHome("../some/path", "/base/dir")).toBe("/base/some/path");
	});

	it("resolves ../ relative to settings file directory (.pi/)", () => {
		// ../packages/foo relative to .pi/ should resolve to packages/foo at project root
		expect(resolveHome("../packages/foo", "/base/.pi")).toBe("/base/packages/foo");
	});
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------

describe("checkHealth", () => {
	it("local + path exists → 'ok'", () => {
		mockExists.mockReturnValue(true);
		expect(checkHealth("/real/path", "local")).toBe("ok");
		expect(mockExists).toHaveBeenCalledWith("/real/path");
	});

	it("local + path missing → 'missing'", () => {
		mockExists.mockReturnValue(false);
		expect(checkHealth("/nonexistent/path", "local")).toBe("missing");
		expect(mockExists).toHaveBeenCalledWith("/nonexistent/path");
	});

	it("local + tilde path resolves before checking existence", () => {
		mockExists.mockReturnValue(true);
		expect(checkHealth("~/my-ext", "local")).toBe("ok");
		expect(mockExists).toHaveBeenCalledWith(join("/home/testuser", "my-ext"));
	});

	it("npm kind → 'unverified' (no fs call)", () => {
		expect(checkHealth("npm:some-pkg", "npm")).toBe("unverified");
		expect(mockExists).not.toHaveBeenCalled();
	});

	it("other kind → 'unverified' (no fs call)", () => {
		expect(checkHealth("git+https://github.com/x/y", "other")).toBe("unverified");
		expect(mockExists).not.toHaveBeenCalled();
	});

	it("local + relative path resolves against provided cwd (settings dir)", () => {
		// Simulate ../packages/foo from .pi/ resolving to /base/packages/foo
		mockExists.mockImplementation((p) => p === "/base/packages/foo");
		expect(checkHealth("../packages/foo", "local", "/base/.pi")).toBe("ok");
		expect(mockExists).toHaveBeenCalledWith("/base/packages/foo");
	});
});

// ---------------------------------------------------------------------------
// readPackageName
// ---------------------------------------------------------------------------

describe("readPackageName", () => {
	it("dir exists and package.json has name → returns the name", () => {
		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(JSON.stringify({ name: "cool-ext", version: "1.0.0" }));
		expect(readPackageName("/some/dir")).toBe("cool-ext");
		expect(mockExists).toHaveBeenCalledWith("/some/dir/package.json");
		expect(mockRead).toHaveBeenCalledWith("/some/dir/package.json", "utf8");
	});

	it("dir exists but package.json has no name field → undefined", () => {
		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(JSON.stringify({ version: "1.0.0" }));
		expect(readPackageName("/no-name/dir")).toBeUndefined();
	});

	it("existsSync returns false → undefined (no read attempt)", () => {
		mockExists.mockReturnValue(false);
		expect(readPackageName("/missing/dir")).toBeUndefined();
		expect(mockRead).not.toHaveBeenCalled();
	});

	it("readFileSync throws → undefined", () => {
		mockExists.mockReturnValue(true);
		mockRead.mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});
		expect(readPackageName("/unreadable/dir")).toBeUndefined();
	});

	it("package.json contains invalid JSON → undefined", () => {
		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue("{ this is: not valid json }");
		expect(readPackageName("/bad-json/dir")).toBeUndefined();
	});

	it("name field is not a string (number) → undefined", () => {
		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(JSON.stringify({ name: 42 }));
		expect(readPackageName("/number-name/dir")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// deriveName
// ---------------------------------------------------------------------------

describe("deriveName", () => {
	it("npm spec npm:my-pkg@1.2.3 → 'my-pkg'", () => {
		expect(deriveName("npm:my-pkg@1.2.3", "npm", "unverified")).toBe("my-pkg");
	});

	it("npm spec npm:@scope/pkg@2.0 → '@scope/pkg'", () => {
		expect(deriveName("npm:@scope/pkg@2.0", "npm", "unverified")).toBe("@scope/pkg");
	});

	it("npm spec with no version npm:unversioned → 'unversioned'", () => {
		expect(deriveName("npm:unversioned", "npm", "unverified")).toBe("unversioned");
	});

	it("npm scoped with no version npm:@scope/pkg → '@scope/pkg'", () => {
		expect(deriveName("npm:@scope/pkg", "npm", "unverified")).toBe("@scope/pkg");
	});

	it("local + health 'ok' + package.json has name → returns package name", () => {
		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(JSON.stringify({ name: "my-awesome-ext" }));
		expect(deriveName("/local/ext-dir", "local", "ok")).toBe("my-awesome-ext");
	});

	it("local + health 'missing' → returns last path segment (no fs read)", () => {
		expect(deriveName("/some/path/my-ext", "local", "missing")).toBe("my-ext");
		expect(mockExists).not.toHaveBeenCalled();
		expect(mockRead).not.toHaveBeenCalled();
	});

	it("local + health 'ok' + no package.json → returns last path segment", () => {
		mockExists.mockReturnValue(false); // no package.json
		expect(deriveName("/some/path/my-ext", "local", "ok")).toBe("my-ext");
	});

	it("local + tilde path + health 'ok' + package.json has name → resolves home first", () => {
		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(JSON.stringify({ name: "tilde-ext" }));
		expect(deriveName("~/my-ext", "local", "ok")).toBe("tilde-ext");
		expect(mockExists).toHaveBeenCalledWith(join("/home/testuser", "my-ext", "package.json"));
	});

	it("'other' kind → returns spec as-is", () => {
		expect(deriveName("git+https://github.com/x/y", "other", "unverified")).toBe(
			"git+https://github.com/x/y",
		);
	});
});

// ---------------------------------------------------------------------------
// markConflicts
// ---------------------------------------------------------------------------

describe("markConflicts", () => {
	it("no conflict when all names are unique", () => {
		const entries = [
			mkEntry({ name: "ext-a", scope: "user" }),
			mkEntry({ name: "ext-b", scope: "project" }),
		];
		const result = markConflicts(entries);
		expect(result.every((e) => !e.conflict)).toBe(true);
	});

	it("marks both entries when the same name appears in user and project", () => {
		const entries = [
			mkEntry({ name: "ext-a", scope: "user" }),
			mkEntry({ name: "ext-a", scope: "project" }),
		];
		const result = markConflicts(entries);
		expect(result[0]!.conflict).toBe(true);
		expect(result[1]!.conflict).toBe(true);
	});

	it("does not mark conflict when same name appears twice in the same scope", () => {
		const entries = [
			mkEntry({ name: "ext-a", scope: "user" }),
			mkEntry({ name: "ext-a", scope: "user" }),
		];
		const result = markConflicts(entries);
		expect(result.every((e) => !e.conflict)).toBe(true);
	});

	it("only marks the conflicting name, not others", () => {
		const entries = [
			mkEntry({ name: "shared", scope: "user" }),
			mkEntry({ name: "shared", scope: "project" }),
			mkEntry({ name: "unique", scope: "user" }),
		];
		const result = markConflicts(entries);
		expect(result.find((e) => e.name === "shared" && e.scope === "user")!.conflict).toBe(true);
		expect(result.find((e) => e.name === "shared" && e.scope === "project")!.conflict).toBe(true);
		expect(result.find((e) => e.name === "unique")!.conflict).toBe(false);
	});

	it("returns a new array and does not mutate input", () => {
		const entries = [
			mkEntry({ name: "ext-a", scope: "user" }),
			mkEntry({ name: "ext-a", scope: "project" }),
		];
		const original = entries.map((e) => ({ ...e }));
		markConflicts(entries);
		expect(entries).toEqual(original);
	});

	it("returns empty array for empty input", () => {
		expect(markConflicts([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// filterEntries
// ---------------------------------------------------------------------------

describe("filterEntries", () => {
	const ENTRIES: ExtPackageEntry[] = [
		mkEntry({ name: "alpha-ext", spec: "/home/user/alpha", kind: "local", health: "ok" }),
		mkEntry({ name: "beta-tool", spec: "/home/user/beta", kind: "local", health: "ok" }),
		mkEntry({ name: "gamma-util", spec: "npm:gamma-util@1.0", kind: "npm", health: "unverified" }),
		mkEntry({ name: "@scope/delta", spec: "npm:@scope/delta", kind: "npm", health: "unverified" }),
	];

	it("empty query returns the same array reference", () => {
		expect(filterEntries(ENTRIES, "")).toBe(ENTRIES);
	});

	it("matches on name substring (case-insensitive)", () => {
		const result = filterEntries(ENTRIES, "ALPHA");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("alpha-ext");
	});

	it("matches on spec substring (case-insensitive)", () => {
		const result = filterEntries(ENTRIES, "NPM:GAMMA");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("gamma-util");
	});

	it("matches multiple entries when query is a shared substring", () => {
		// Both "alpha-ext" spec and "beta-tool" spec contain "/home/user/"
		const result = filterEntries(ENTRIES, "/home/user/");
		expect(result).toHaveLength(2);
	});

	it("no match returns empty array", () => {
		expect(filterEntries(ENTRIES, "xyzzy-no-match")).toHaveLength(0);
	});

	it("does not mutate the input array", () => {
		const original = ENTRIES.map((e) => e.name);
		filterEntries(ENTRIES, "alpha");
		expect(ENTRIES.map((e) => e.name)).toEqual(original);
	});

	it("matches scoped npm package name", () => {
		const result = filterEntries(ENTRIES, "scope/delta");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("@scope/delta");
	});
});

// ---------------------------------------------------------------------------
// loadEntries
// ---------------------------------------------------------------------------

describe("loadEntries", () => {
	const CWD = "/workspace/my-project";
	const USER_SETTINGS = "/home/testuser/.pi/agent/settings.json";
	const PROJECT_SETTINGS = `${CWD}/.pi/settings.json`;

	it("reads user settings and assigns scope 'user'", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: ["/home/testuser/my-user-ext"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		const userEntries = entries.filter((e) => e.scope === "user");
		expect(userEntries).toHaveLength(1);
		expect(userEntries[0]!.spec).toBe("/home/testuser/my-user-ext");
	});

	it("reads project settings and assigns scope 'project'", () => {
		mockExists.mockImplementation((p) => {
			if (p === PROJECT_SETTINGS) return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === PROJECT_SETTINGS)
				return JSON.stringify({ packages: ["/workspace/my-project/local-ext"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		const projectEntries = entries.filter((e) => e.scope === "project");
		expect(projectEntries).toHaveLength(1);
		expect(projectEntries[0]!.spec).toBe("/workspace/my-project/local-ext");
		expect(projectEntries[0]!.scope).toBe("project");
	});

	it("handles missing settings files gracefully (returns empty for that scope)", () => {
		// Neither settings file exists
		mockExists.mockReturnValue(false);

		const entries = loadEntries(CWD);
		expect(entries).toHaveLength(0);
	});

	it("handles object-form entries { source: '/some/path' } in packages array", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: [{ source: "/home/testuser/object-ext" }] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.spec).toBe("/home/testuser/object-ext");
		expect(entries[0]!.raw).toBe("/home/testuser/object-ext");
	});

	it("_-prefixed entry: disabled=true, spec keeps _ (same as raw)", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (String(p) === "/home/testuser/disabled-ext") return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: ["_/home/testuser/disabled-ext"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.raw).toBe("_/home/testuser/disabled-ext");
		expect(entries[0]!.spec).toBe("_/home/testuser/disabled-ext");
		expect(entries[0]!.disabled).toBe(true);
		expect(entries[0]!.health).toBe("ok"); // path itself exists
	});

	it("non-prefixed entry has disabled=false", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (String(p) === "/home/testuser/active-ext") return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: ["/home/testuser/active-ext"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries[0]!.disabled).toBe(false);
	});

	it("local entry gets health 'ok' when path exists", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (p === "/home/testuser/existing-ext") return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: ["/home/testuser/existing-ext"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries[0]!.health).toBe("ok");
		expect(entries[0]!.kind).toBe("local");
	});

	it("local entry gets health 'missing' when path does not exist", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			// extension path itself does NOT exist
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: ["/home/testuser/gone-ext"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries[0]!.health).toBe("missing");
	});

	it("npm entry gets health 'unverified'", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS) return JSON.stringify({ packages: ["npm:my-npm-ext@1.0"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries[0]!.kind).toBe("npm");
		expect(entries[0]!.health).toBe("unverified");
	});

	it("combines user and project entries in order (user first)", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (p === PROJECT_SETTINGS) return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS) return JSON.stringify({ packages: ["npm:user-ext@1.0"] });
			if (p === PROJECT_SETTINGS)
				return JSON.stringify({ packages: ["/workspace/my-project/proj-ext"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.scope).toBe("user");
		expect(entries[0]!.spec).toBe("npm:user-ext@1.0");
		expect(entries[1]!.scope).toBe("project");
		expect(entries[1]!.spec).toBe("/workspace/my-project/proj-ext");
	});

	it("reads extensions[] array in addition to packages[]", () => {
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({
					packages: ["npm:pkg-one@1.0"],
					extensions: ["npm:ext-two@2.0"],
				});
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.spec)).toEqual(["npm:pkg-one@1.0", "npm:ext-two@2.0"]);
	});

	it("settings with only extensions[] (no packages key) still reads extensions", () => {
		// Covers: `settings.packages ?? []` right branch (packages key absent)
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			if (String(p).endsWith("package.json")) return false;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ extensions: ["npm:ext-only@1.0"] }); // no `packages` key
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.spec).toBe("npm:ext-only@1.0");
	});

	it("ignores a null entry in the packages array (else-if falsy guard)", () => {
		// Covers: `entry &&` false branch in readPackageList's else-if chain
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: [null, "npm:real-pkg@1.0"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		// null entry is silently skipped; only the npm string entry appears
		expect(entries).toHaveLength(1);
		expect(entries[0]!.spec).toBe("npm:real-pkg@1.0");
	});

	it("ignores an object entry without a 'source' field", () => {
		// Covers: `"source" in entry` false branch in readPackageList's else-if chain
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ packages: [{ path: "/some/path" }, "npm:real@1.0"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		// The object without 'source' is skipped
		expect(entries).toHaveLength(1);
		expect(entries[0]!.spec).toBe("npm:real@1.0");
	});

	it("ignores a non-string extension entry in extensions[]", () => {
		// Covers: `typeof entry === "string"` false branch in extensions loop
		mockExists.mockImplementation((p) => {
			if (p === USER_SETTINGS) return true;
			return false;
		});
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS)
				return JSON.stringify({ extensions: [42, "npm:valid-ext@1.0"] });
			throw new Error(`unexpected read: ${String(p)}`);
		});

		const entries = loadEntries(CWD);
		// 42 is silently skipped; only the string extension appears
		expect(entries).toHaveLength(1);
		expect(entries[0]!.spec).toBe("npm:valid-ext@1.0");
	});

	it("handles corrupt JSON in settings file gracefully", () => {
		mockExists.mockImplementation((p) => p === USER_SETTINGS);
		mockRead.mockImplementation((p) => {
			if (p === USER_SETTINGS) return "{ not valid json at all";
			throw new Error(`unexpected read: ${String(p)}`);
		});

		expect(() => loadEntries(CWD)).not.toThrow();
		expect(loadEntries(CWD)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// buildSummary (Issue #0001 — conflict count lives in the header legend)
// ---------------------------------------------------------------------------

describe("buildSummary", () => {
	function makeEntry(overrides: Partial<ExtPackageEntry>): ExtPackageEntry {
		return {
			name: "ext",
			raw: "/some/path",
			spec: "/some/path",
			scope: "user",
			kind: "local",
			health: "ok",
			disabled: false,
			conflict: false,
			...overrides,
		};
	}

	it("counts ok, missing, unverified, and conflict entries", () => {
		const entries: ExtPackageEntry[] = [
			makeEntry({ health: "ok" }),
			makeEntry({ health: "ok" }),
			makeEntry({ health: "missing" }),
			makeEntry({ health: "unverified" }),
			makeEntry({ health: "ok", conflict: true }),
		];
		expect(buildSummary(entries)).toEqual({
			ok: 3,
			missing: 1,
			unverified: 1,
			conflict: 1,
		});
	});

	it("returns zeros for an empty list", () => {
		expect(buildSummary([])).toEqual({ ok: 0, missing: 0, unverified: 0, conflict: 0 });
	});

	it("includes conflict count so the header summary legend has all info in one place", () => {
		const entries: ExtPackageEntry[] = [
			makeEntry({ conflict: true }),
			makeEntry({ conflict: true }),
			makeEntry({}),
		];
		// The conflict count is available via buildSummary — it should be rendered
		// in the header legend block, not hardcoded separately in the navigation footer.
		expect(buildSummary(entries).conflict).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// isLocalPathMissing (Issue #0002 — non-existing paths highlighted in red)
// ---------------------------------------------------------------------------

describe("isLocalPathMissing", () => {
	beforeEach(() => {
		mockExists.mockReset();
	});

	it("returns true for a local path that does not exist", () => {
		mockExists.mockReturnValue(false);
		expect(isLocalPathMissing("/home/user/.pi/extensions/my-ext")).toBe(true);
	});

	it("returns false for a local path that exists", () => {
		mockExists.mockReturnValue(true);
		expect(isLocalPathMissing("/home/user/.pi/extensions/my-ext")).toBe(false);
	});

	it("strips the leading underscore from disabled entries before checking", () => {
		mockExists.mockImplementation((p: unknown) => p === "/home/user/.pi/ext");
		expect(isLocalPathMissing("_/home/user/.pi/ext")).toBe(false);
		expect(isLocalPathMissing("_/home/user/.pi/missing")).toBe(true);
	});

	it("returns false for npm: specs (non-local) regardless of existsSync", () => {
		mockExists.mockReturnValue(false);
		expect(isLocalPathMissing("npm:some-package@1.0.0")).toBe(false);
		expect(mockExists).not.toHaveBeenCalled();
	});

	it("returns false for https: specs (non-local) regardless of existsSync", () => {
		mockExists.mockReturnValue(false);
		expect(isLocalPathMissing("https://example.com/ext.js")).toBe(false);
		expect(mockExists).not.toHaveBeenCalled();
	});

	it("resolves ~ home paths before calling existsSync", () => {
		mockExists.mockReturnValue(false);
		// Should not throw — home expansion is applied before existsSync
		expect(() => isLocalPathMissing("~/my-ext")).not.toThrow();
		expect(mockExists).toHaveBeenCalled();
		// The arg must be an absolute path (tilde expanded)
		const calledWith = (mockExists.mock.calls[0] as [string])[0];
		expect(calledWith).not.toContain("~");
		expect(calledWith).toMatch(/^\//);
	});

	it("returns false for a disabled npm spec _npm:some-package (non-local)", () => {
		mockExists.mockReturnValue(false);
		expect(isLocalPathMissing("_npm:some-package")).toBe(false);
		expect(mockExists).not.toHaveBeenCalled();
	});

	it("../ relative path that does not exist → true", () => {
		mockExists.mockReturnValue(false);
		expect(isLocalPathMissing("../.worktrees/nonexistent/pkg")).toBe(true);
		expect(mockExists).toHaveBeenCalled();
	});
});
