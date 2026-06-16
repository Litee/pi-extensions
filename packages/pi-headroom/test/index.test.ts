import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// parseSubcommand — the only exported function from index.ts.
// ---------------------------------------------------------------------------

import { createRuntimeState, parseSubcommand } from "../src/index.ts";
import type { HeadroomConfig } from "../src/types.ts";

describe("parseSubcommand", () => {
	it('returns null for empty string', () => {
		expect(parseSubcommand("")).toBeNull();
	});

	it('returns null for whitespace-only', () => {
		expect(parseSubcommand("   ")).toBeNull();
	});

	it('matches valid subcommands (case-insensitive)', () => {
		expect(parseSubcommand("status")).toBe("status");
		expect(parseSubcommand("STATUS")).toBe("status");
		expect(parseSubcommand("Status")).toBe("status");
		expect(parseSubcommand("on")).toBe("on");
		expect(parseSubcommand("off")).toBe("off");
		expect(parseSubcommand("health")).toBe("health");
		expect(parseSubcommand("stats")).toBe("stats");
	});

	it('returns "status" for unknown subcommands', () => {
		expect(parseSubcommand("foo")).toBe("status");
		expect(parseSubcommand("unknown")).toBe("status");
	});

	it('trims whitespace before matching', () => {
		expect(parseSubcommand("  on  ")).toBe("on");
	});
});

describe("createRuntimeState", () => {
	it('creates state from config', () => {
		const config: HeadroomConfig = {
			enabled: true,
			baseUrl: "http://127.0.0.1:8788",
			allowRemote: false,
			command: "headroom",
			minContextTokens: 20_000,
			minMessageChars: 2_000,
			timeoutMs: 30_000,
		};

		const state = createRuntimeState(config);

		expect(state.enabled).toBe(true);
		expect(state.proxyOnline).toBeNull();
		expect(state.remoteWarningShown).toBe(false);
		expect(state.offlineWarningShown).toBe(false);
		expect(state.stats).toEqual({ attempts: 0, applied: 0, tokensSaved: 0 });
	});

	it('copies enabled flag from config', () => {
		const config: HeadroomConfig = {
			enabled: false,
			baseUrl: "http://127.0.0.1:8788",
			allowRemote: false,
			command: "headroom",
			minContextTokens: 20_000,
			minMessageChars: 2_000,
			timeoutMs: 30_000,
		};

		const state = createRuntimeState(config);
		expect(state.enabled).toBe(false);
	});

	it('creates state with null proxyOnline by default', () => {
		const config: HeadroomConfig = {
			enabled: true,
			baseUrl: "http://127.0.0.1:8788",
			allowRemote: true,
			command: "headroom",
			minContextTokens: 20_000,
			minMessageChars: 2_000,
			timeoutMs: 30_000,
		};

		const state = createRuntimeState(config);
		expect(state.proxyOnline).toBeNull();
	});

	it('creates state with false warning flags', () => {
		const config: HeadroomConfig = {
			enabled: true,
			baseUrl: "http://example.com",
			allowRemote: true,
			command: "headroom",
			minContextTokens: 20_000,
			minMessageChars: 2_000,
			timeoutMs: 30_000,
		};

		const state = createRuntimeState(config);
		expect(state.remoteWarningShown).toBe(false);
		expect(state.offlineWarningShown).toBe(false);
	});
});
