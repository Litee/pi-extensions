import { describe, expect, it } from "vitest";
import { extensionCanonicalName, parseExtSelectors, parseExtensionsSpec } from "../src/agent-runner.js";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for normal completion", () => {
    expect(getStatusNote("completed")).toBe("");
  });

  it("returns empty string for unknown/running status", () => {
    expect(getStatusNote("running")).toBe("");
    expect(getStatusNote("")).toBe("");
    expect(getStatusNote("queued")).toBe("");
  });

  it("returns stopped note for stopped status", () => {
    const note = getStatusNote("stopped");
    expect(note).toContain("STOPPED BY THE USER");
    expect(note).toContain("partial");
  });

  it("returns aborted note for aborted status", () => {
    const note = getStatusNote("aborted");
    expect(note).toContain("aborted");
    expect(note).toContain("turn limit");
  });

  it("returns steered note for steered status", () => {
    const note = getStatusNote("steered");
    expect(note).toContain("wrapped up");
    expect(note).toContain("turn limit");
  });
});

describe("extensionCanonicalName", () => {
  it("returns lowercased basename without extension for .ts files", () => {
    expect(extensionCanonicalName("/path/to/my-extension.ts")).toBe("my-extension");
    expect(extensionCanonicalName("/path/to/MyExt.ts")).toBe("myext");
  });

  it("returns lowercased basename without extension for .js files", () => {
    expect(extensionCanonicalName("/path/to/myext.js")).toBe("myext");
  });

  it("returns parent directory name for index.ts", () => {
    expect(extensionCanonicalName("/path/to/plan-mode/index.ts")).toBe("plan-mode");
  });

  it("returns parent directory name for index.js", () => {
    expect(extensionCanonicalName("/path/to/pi-subagents/index.js")).toBe("pi-subagents");
  });

  it("handles bare filename (no directory)", () => {
    expect(extensionCanonicalName("btw.ts")).toBe("btw");
  });
});

describe("parseExtensionsSpec", () => {
  it("classifies plain names as lowercased names", () => {
    const result = parseExtensionsSpec(["Foo", "Bar"], "/cwd");
    expect(result.names).toEqual(new Set(["foo", "bar"]));
    expect(result.paths).toEqual([]);
    expect(result.wildcard).toBe(false);
  });

  it("sets wildcard flag for '*' entry", () => {
    const result = parseExtensionsSpec(["*", "foo"], "/cwd");
    expect(result.wildcard).toBe(true);
    expect(result.names).toContain("foo");
  });

  it("classifies absolute paths into paths and derives canonical name", () => {
    const result = parseExtensionsSpec(["/abs/path/my-ext.ts"], "/cwd");
    expect(result.paths).toEqual(["/abs/path/my-ext.ts"]);
    expect(result.names).toContain("my-ext");
  });

  it("resolves relative paths against cwd", () => {
    const result = parseExtensionsSpec(["./extensions/my-ext.ts"], "/cwd");
    expect(result.paths).toEqual(["/cwd/extensions/my-ext.ts"]);
    expect(result.names).toContain("my-ext");
  });

  it("skips empty entries", () => {
    const result = parseExtensionsSpec(["", "foo", ""], "/cwd");
    expect(result.names).toEqual(new Set(["foo"]));
  });

  it("returns empty result for empty input", () => {
    const result = parseExtensionsSpec([], "/cwd");
    expect(result.names.size).toBe(0);
    expect(result.paths).toEqual([]);
    expect(result.wildcard).toBe(false);
  });
});

describe("parseExtSelectors", () => {
  it("parses bare ext:name selectors (lowercased)", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo", "ext:Bar"]);
    expect(extNames).toEqual(new Set(["foo", "bar"]));
    expect(narrowing.size).toBe(0);
  });

  it("parses ext:name/tool selectors with narrowing (tool case preserved)", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo/MyTool"]);
    expect(extNames).toContain("foo");
    expect(narrowing.get("foo")).toEqual(new Set(["MyTool"]));
  });

  it("accumulates multiple tools for the same extension", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo/toolA", "ext:foo/toolB"]);
    expect(extNames).toContain("foo");
    expect(narrowing.get("foo")).toEqual(new Set(["toolA", "toolB"]));
  });

  it("skips empty entries", () => {
    const { extNames } = parseExtSelectors(["", "ext:foo"]);
    expect(extNames).toEqual(new Set(["foo"]));
  });

  it("returns empty sets for empty input", () => {
    const { extNames, narrowing } = parseExtSelectors([]);
    expect(extNames.size).toBe(0);
    expect(narrowing.size).toBe(0);
  });
});
