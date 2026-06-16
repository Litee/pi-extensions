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
