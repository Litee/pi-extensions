import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

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

vi.mock("@earendil-works/pi-tui", () => ({
	truncateToWidth: vi.fn((_str: string, _width: number) => _str),
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER mocks are hoisted)
// ---------------------------------------------------------------------------

import { renderEntry } from "../src/render.js";
import type { ExtPackageEntry } from "../src/helpers.js";

// ---------------------------------------------------------------------------
// Typed mock handles
// ---------------------------------------------------------------------------

const mockExists = vi.mocked(existsSync);

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
// renderEntry — path color (Issue #0002 — non-existing paths highlighted in red)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// renderEntry — uncovered branches (isSelected, conflict, disabled, truncation)
// ---------------------------------------------------------------------------

describe("renderEntry — isSelected=true", () => {
	type Theme = Parameters<typeof renderEntry>[4];

	function makeTheme(): { theme: Theme; fgCalls: Array<[string, string]> } {
		const fgCalls: Array<[string, string]> = [];
		const theme: Theme = {
			fg: (color, text): string => {
				fgCalls.push([color, text]);
				return text;
			},
			bold: (text: string): string => text,
		};
		return { theme, fgCalls };
	}

	it("arrow uses accent color when isSelected=true", () => {
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({ name: "sel-ext", spec: "/path/to/sel-ext", health: "ok" });

		renderEntry(entry, true, 20, 80, theme);

		// Arrow is "> " colored with accent
		const arrowCall = fgCalls.find(([, text]) => text === "> ");
		expect(arrowCall).toBeDefined();
		expect(arrowCall![0]).toBe("accent");
	});

	it("nameColored uses accent when isSelected=true", () => {
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({ name: "sel-ext", spec: "/path", health: "ok" });

		renderEntry(entry, true, 20, 80, theme);

		// The padded name is colored accent (not error/dim)
		const nameCall = fgCalls.find(([color]) => color === "accent");
		expect(nameCall).toBeDefined();
	});

	it("conflict badge uses accent when isSelected=true and conflict=true", () => {
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({ name: "conf-ext", spec: "/path", health: "ok", conflict: true });

		renderEntry(entry, true, 20, 80, theme);

		// conflictBadge text is "⚡ " — should be colored accent (isSelected=true)
		const badgeCall = fgCalls.find(([, text]) => text === "⚡ ");
		expect(badgeCall).toBeDefined();
		expect(badgeCall![0]).toBe("accent");
	});
});

describe("renderEntry — conflict=true, isSelected=false", () => {
	type Theme = Parameters<typeof renderEntry>[4];

	function makeTheme(): { theme: Theme; fgCalls: Array<[string, string]> } {
		const fgCalls: Array<[string, string]> = [];
		const theme: Theme = {
			fg: (color, text): string => {
				fgCalls.push([color, text]);
				return text;
			},
			bold: (text: string): string => text,
		};
		return { theme, fgCalls };
	}

	it("conflict badge uses error color when isSelected=false", () => {
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({ name: "conf-ext", spec: "/path", health: "ok", conflict: true });

		renderEntry(entry, false, 20, 80, theme);

		const badgeCall = fgCalls.find(([, text]) => text === "⚡ ");
		expect(badgeCall).toBeDefined();
		expect(badgeCall![0]).toBe("error");
	});

	it("isWarning short-circuits via conflict (not just health)", () => {
		const { theme, fgCalls } = makeTheme();
		// health=ok but conflict=true → isWarning still true → name colored error
		const entry = mkEntry({ name: "conf-ok", spec: "/path", health: "ok", conflict: true });

		renderEntry(entry, false, 20, 80, theme);

		// Name padded to 20 chars
		const nameCall = fgCalls.find(([, text]) => text.startsWith("conf-ok"));
		expect(nameCall).toBeDefined();
		expect(nameCall![0]).toBe("error");
	});
});

describe("renderEntry — disabled=true", () => {
	type Theme = Parameters<typeof renderEntry>[4];

	function makeTheme(): { theme: Theme; fgCalls: Array<[string, string]> } {
		const fgCalls: Array<[string, string]> = [];
		const theme: Theme = {
			fg: (color, text): string => {
				fgCalls.push([color, text]);
				return text;
			},
			bold: (text: string): string => text,
		};
		return { theme, fgCalls };
	}

	it("icon uses dim color when entry is disabled", () => {
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({
			name: "dis-ext",
			spec: "/path/to/dis-ext",
			health: "ok",
			disabled: true,
			conflict: false,
		});

		renderEntry(entry, false, 20, 80, theme);

		// The icon ` ✓ ` should be colored dim (not success) because disabled=true
		const iconCall = fgCalls.find(([, text]) => text === " ✓ ");
		expect(iconCall).toBeDefined();
		expect(iconCall![0]).toBe("dim");
	});

	it("nameColored uses dim when disabled and not isSelected and not isWarning", () => {
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({
			name: "dis-ext",
			spec: "/path/to/dis-ext",
			health: "ok",
			disabled: true,
			conflict: false,
		});

		renderEntry(entry, false, 20, 80, theme);

		// The name column should be dim
		const nameCall = fgCalls.find(([, text]) => text.startsWith("dis-ext"));
		expect(nameCall).toBeDefined();
		expect(nameCall![0]).toBe("dim");
	});
});

describe("renderEntry — name truncation", () => {
	type Theme = Parameters<typeof renderEntry>[4];

	function makeTheme(): Theme {
		return {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
	}

	it("truncates name with ellipsis when longer than nameColWidth", () => {
		const theme = makeTheme();
		const longName = "this-extension-name-is-way-too-long";
		const nameColWidth = 10;
		const entry = mkEntry({ name: longName, spec: "/p", health: "ok" });

		const result = renderEntry(entry, false, nameColWidth, 200, theme);

		// The rendered name should be truncated to nameColWidth-1 chars + ellipsis
		expect(result).toContain(`${longName.slice(0, nameColWidth - 1)}…`);
	});

	it("does not truncate name that fits within nameColWidth", () => {
		const theme = makeTheme();
		const entry = mkEntry({ name: "short", spec: "/p", health: "ok" });

		const result = renderEntry(entry, false, 20, 200, theme);

		expect(result).not.toContain("…");
	});
});

// ---------------------------------------------------------------------------
// (original describe block below)
// ---------------------------------------------------------------------------

describe("renderEntry — path color", () => {
	type Theme = Parameters<typeof renderEntry>[4];

	function makeTheme(): { theme: Theme; fgCalls: Array<[string, string]> } {
		const fgCalls: Array<[string, string]> = [];
		const theme: Theme = {
			fg: (color, text): string => {
				fgCalls.push([color, text]);
				return text;
			},
			bold: (text: string): string => text,
		};
		return { theme, fgCalls };
	}

	it("colors the path with 'error' when the local path does not exist", () => {
		mockExists.mockReturnValue(false);
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({
			name: "gone-ext",
			raw: "/missing/path",
			spec: "/missing/path",
			kind: "local",
			health: "missing",
		});

		renderEntry(entry, false, 20, 80, theme);

		const pathCall = fgCalls.find(([, text]) => text === "/missing/path");
		expect(pathCall).toBeDefined();
		expect(pathCall![0]).toBe("error");
	});

	it("colors the path with 'dim' when the local path exists", () => {
		mockExists.mockReturnValue(true);
		const { theme, fgCalls } = makeTheme();
		const entry = mkEntry({
			name: "alive-ext",
			raw: "/existing/path",
			spec: "/existing/path",
			kind: "local",
			health: "ok",
		});

		renderEntry(entry, false, 20, 80, theme);

		const pathCall = fgCalls.find(([, text]) => text === "/existing/path");
		expect(pathCall).toBeDefined();
		expect(pathCall![0]).toBe("dim");
	});
});
