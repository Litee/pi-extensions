import { describe, expect, it } from "vitest";
import { MAX_TIMEOUT_SECONDS, TARGETS, GitWatcherParams } from "../src/toolAction.js";

describe("MAX_TIMEOUT_SECONDS", () => {
  it("equals 604800 (7 days)", () => {
    expect(MAX_TIMEOUT_SECONDS).toBe(604_800);
  });
});

describe("TARGETS", () => {
  it("contains exactly the 4 valid TargetCondition values", () => {
    expect(TARGETS.size).toBe(4);
    expect(TARGETS.has("new_commit")).toBe(true);
    expect(TARGETS.has("branch_created")).toBe(true);
    expect(TARGETS.has("branch_deleted")).toBe(true);
    expect(TARGETS.has("tag_created")).toBe(true);
  });
});

describe("GitWatcherParams", () => {
  it("has all 6 top-level properties", () => {
    const keys = Object.keys(GitWatcherParams.properties);
    expect(keys).toContain("action");
    expect(keys).toContain("repoPath");
    expect(keys).toContain("branch");
    expect(keys).toContain("targets");
    expect(keys).toContain("timeoutSeconds");
    expect(keys).toContain("watchId");
    expect(keys).toHaveLength(6);
  });

  it("action union has 6 literals", () => {
    const actionType = GitWatcherParams.properties.action;
    expect(actionType.anyOf).toHaveLength(6);
    const values = actionType.anyOf.map((v: { const: string }) => v.const);
    expect(values).toContain("add");
    expect(values).toContain("remove");
    expect(values).toContain("list");
    expect(values).toContain("pause");
    expect(values).toContain("resume");
    expect(values).toContain("status");
  });

  it("targets array has minItems: 1", () => {
    const targetsType = GitWatcherParams.properties.targets;
    // targets is Optional wrapping an array; cast through unknown to access anyOf
    type AnySchema = { anyOf?: Array<{ type?: string; minItems?: number }>; minItems?: number };
    const schema = targetsType as unknown as AnySchema;
    const arr = schema.anyOf
      ? schema.anyOf.find((v) => v["type"] === "array")
      : schema;
    expect(arr?.minItems).toBe(1);
  });
});
