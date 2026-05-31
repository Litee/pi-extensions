/**
 * Tests for createOutputFilePath in output-file.ts.
 *
 * Split into its own file so vi.mock("node:fs") does not interfere with the
 * real-filesystem tests in output-file.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
import { chmodSync, mkdirSync } from "node:fs";

vi.mock("node:os", () => ({ tmpdir: () => "/tmp" }));

import { createOutputFilePath } from "../src/output-file.js";

describe("createOutputFilePath -- win32 platform (chmodSync swallow)", () => {
  it("swallows a chmodSync EPERM error when process.platform is win32", () => {
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(chmodSync).mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(
      "win32",
    );
    try {
      // On win32, chmodSync errors must be swallowed, not re-thrown.
      expect(() =>
        createOutputFilePath("/some/cwd", "agent-a", "sess-win32"),
      ).not.toThrow();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("re-throws chmodSync errors on non-win32 platforms", () => {
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(chmodSync).mockImplementation(() => {
      throw new Error("EPERM");
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(
      "linux",
    );
    try {
      expect(() =>
        createOutputFilePath("/some/cwd", "agent-b", "sess-linux"),
      ).toThrow("EPERM");
    } finally {
      platformSpy.mockRestore();
    }
  });
});
