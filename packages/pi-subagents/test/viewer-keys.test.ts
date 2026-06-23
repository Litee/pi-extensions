/**
 * Tests for viewer-keys.ts — scroll key matchers for the conversation viewer.
 *
 * Covers both the "with keybindings manager" and "without keybindings manager"
 * branches of createViewerKeys, as well as the || alias branches for k/j/shift+arrow.
 */

import { describe, expect, it, vi } from "vitest";
import { createViewerKeys } from "../src/ui/viewer-keys.js";

// ANSI escape sequences for arrow keys (VT100 / xterm)
const UP_ARROW    = "\x1b[A";
const DOWN_ARROW  = "\x1b[B";
const PAGE_UP     = "\x1b[5~";
const PAGE_DOWN   = "\x1b[6~";
const SHIFT_UP    = "\x1b[1;2A";
const SHIFT_DOWN  = "\x1b[1;2B";

describe("createViewerKeys — without keybindings (fallback to matchesKey)", () => {
  const keys = createViewerKeys();

  describe("scrollUp", () => {
    it("returns true for up-arrow (primary fallback key)", () => {
      expect(keys.scrollUp(UP_ARROW)).toBe(true);
    });

    it("returns true for 'k' (alias)", () => {
      expect(keys.scrollUp("k")).toBe(true);
    });

    it("returns false for unrelated input", () => {
      expect(keys.scrollUp("x")).toBe(false);
    });
  });

  describe("scrollDown", () => {
    it("returns true for down-arrow (primary fallback key)", () => {
      expect(keys.scrollDown(DOWN_ARROW)).toBe(true);
    });

    it("returns true for 'j' (alias)", () => {
      expect(keys.scrollDown("j")).toBe(true);
    });

    it("returns false for unrelated input", () => {
      expect(keys.scrollDown("x")).toBe(false);
    });
  });

  describe("pageUp", () => {
    it("returns true for PageUp key sequence (primary fallback)", () => {
      expect(keys.pageUp(PAGE_UP)).toBe(true);
    });

    it("returns true for shift+up (alias)", () => {
      expect(keys.pageUp(SHIFT_UP)).toBe(true);
    });

    it("returns false for unrelated input", () => {
      expect(keys.pageUp("x")).toBe(false);
    });
  });

  describe("pageDown", () => {
    it("returns true for PageDown key sequence (primary fallback)", () => {
      expect(keys.pageDown(PAGE_DOWN)).toBe(true);
    });

    it("returns true for shift+down (alias)", () => {
      expect(keys.pageDown(SHIFT_DOWN)).toBe(true);
    });

    it("returns false for unrelated input", () => {
      expect(keys.pageDown("x")).toBe(false);
    });
  });
});

describe("createViewerKeys — with keybindings manager", () => {
  it("delegates primary key to keybindings.matches when provided", () => {
    const mockKeybindings = {
      matches: vi.fn().mockReturnValue(true),
    };
    const keys = createViewerKeys(mockKeybindings);

    expect(keys.scrollUp("some-data")).toBe(true);
    expect(mockKeybindings.matches).toHaveBeenCalledWith("some-data", "tui.select.up");
  });

  it("falls back to the alias key when keybindings.matches returns false", () => {
    const mockKeybindings = {
      // always returns false, so the || alias branch must kick in
      matches: vi.fn().mockReturnValue(false),
    };
    const keys = createViewerKeys(mockKeybindings);

    // "k" is the scrollUp alias — matchesKey(data, "k") must return true
    expect(keys.scrollUp("k")).toBe(true);
    // Ensure keybindings.matches WAS called (not bypassed)
    expect(mockKeybindings.matches).toHaveBeenCalledWith("k", "tui.select.up");
  });

  it("returns false when both keybindings.matches and the alias are false", () => {
    const mockKeybindings = {
      matches: vi.fn().mockReturnValue(false),
    };
    const keys = createViewerKeys(mockKeybindings);

    expect(keys.scrollUp("x")).toBe(false);
  });

  it("calls keybindings.matches with 'tui.select.down' for scrollDown", () => {
    const mockKeybindings = {
      matches: vi.fn().mockReturnValue(true),
    };
    const keys = createViewerKeys(mockKeybindings);
    expect(keys.scrollDown("data")).toBe(true);
    expect(mockKeybindings.matches).toHaveBeenCalledWith("data", "tui.select.down");
  });

  it("calls keybindings.matches with 'tui.select.pageUp' for pageUp", () => {
    const mockKeybindings = {
      matches: vi.fn().mockReturnValue(true),
    };
    const keys = createViewerKeys(mockKeybindings);
    expect(keys.pageUp("data")).toBe(true);
    expect(mockKeybindings.matches).toHaveBeenCalledWith("data", "tui.select.pageUp");
  });

  it("calls keybindings.matches with 'tui.select.pageDown' for pageDown", () => {
    const mockKeybindings = {
      matches: vi.fn().mockReturnValue(true),
    };
    const keys = createViewerKeys(mockKeybindings);
    expect(keys.pageDown("data")).toBe(true);
    expect(mockKeybindings.matches).toHaveBeenCalledWith("data", "tui.select.pageDown");
  });
});
