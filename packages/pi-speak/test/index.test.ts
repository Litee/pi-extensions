import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	unlinkSync: vi.fn(),
}));

vi.mock("../src/menu.js", () => ({
	runSpeakMenu: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:os", () => ({
	tmpdir: () => "/tmp",
}));

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	discoverAssetsDir: vi.fn(() => "/fake/assets"),
	assetsReady: vi.fn(() => false),
	saveConfig: vi.fn(() => true),
}));

vi.mock("../src/tts.js", () => ({
	synthesise: vi.fn(),
	writeWav: vi.fn(),
}));

vi.mock("../src/audio.js", () => ({
	playAudioFile: vi.fn(),
}));

vi.mock("@earendil-works/pi-tui", () => ({
	Text: class {
		constructor(public content: string, public _l: number, public _r: number) {}
		render(): string[] { return this.content ? [this.content] : []; }
	},
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks)
// ---------------------------------------------------------------------------

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import speakExtension from "../src/index.js";
import { runSpeakMenu } from "../src/menu.js";
import { loadConfig, discoverAssetsDir, assetsReady } from "../src/config.js";
import { synthesise, writeWav } from "../src/tts.js";
import { playAudioFile } from "../src/audio.js";
import { SPEAK_STATE_CUSTOM_TYPE } from "../src/state.js";
import { MAX_TEXT_CHARS } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakePi(initial: { active: string[] } = { active: [] }) {
	let active = new Set(initial.active);
	const registeredTools: ToolDefinition[] = [];
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => unknown; getArgumentCompletions?: (prefix: string) => string[] }> = {};

	const registerTool = vi.fn((t: ToolDefinition) => { registeredTools.push(t); });
	const registerCommand = vi.fn((name: string, def: typeof commands[string]) => {
		commands[name] = def;
	});
	const on = vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
		(handlers[event] ??= []).push(handler);
	});
	const getActiveTools = vi.fn(() => [...active]);
	const setActiveTools = vi.fn((names: string[]) => { active = new Set(names); });
	const appendEntry = vi.fn();

	async function fire(name: string, event: unknown, ctx: unknown) {
		for (const h of (handlers[name] ?? [])) await h(event, ctx);
	}

	const api = {
		registerTool, registerCommand, on,
		getActiveTools, setActiveTools, appendEntry,
	} as unknown as ExtensionAPI;

	return {
		api,
		registerTool,
		registerCommand,
		on,
		setActiveTools,
		appendEntry,
		getActiveTools,
		get active() { return active; },
		get speakTool(): ToolDefinition {
			const t = registeredTools.find((r) => r.name === "speak");
			if (!t) throw new Error("speak tool not registered");
			return t;
		},
		async runCommand(name: string, args: string, ctx: unknown) {
			await commands[name]!.handler(args, ctx);
		},
		async fireEvent(name: string, event: unknown = {}, ctx: unknown = makeCtx()) {
			await fire(name, event, ctx);
		},
	};
}

function makeCtx(opts: {
	hasUI?: boolean;
	branch?: SessionEntry[];
	select?: (title: string, items: string[]) => Promise<string | null | undefined>;
} = {}): ExtensionCommandContext & { notify: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	return Object.assign(
		{
			hasUI: opts.hasUI ?? true,
			ui: { notify, custom: vi.fn(), ...(opts.select ? { select: opts.select } : {}) },
			sessionManager: { getBranch: vi.fn(() => opts.branch ?? []) },
		} as unknown as ExtensionCommandContext,
		{ notify },
	);
}

function makeSpeakEntry(enabled: boolean): SessionEntry {
	return {
		type: "custom",
		customType: SPEAK_STATE_CUSTOM_TYPE,
		data: { enabled },
		id: "test-id",
		timestamp: Date.now(),
	} as unknown as SessionEntry;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.resetAllMocks();
	// Default: assets not ready, no hfCli
	vi.mocked(assetsReady).mockReturnValue(false);
	vi.mocked(loadConfig).mockReturnValue({});
	vi.mocked(discoverAssetsDir).mockReturnValue("/fake/assets");
	vi.mocked(synthesise).mockResolvedValue({ wav: [0.1, 0.2], sampleRate: 44100, duration: [0.5] });
	vi.mocked(writeWav).mockResolvedValue(undefined);
	vi.mocked(playAudioFile).mockResolvedValue(undefined);
	vi.mocked(runSpeakMenu).mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. session_start — restores persisted state
// ---------------------------------------------------------------------------
describe("session_start", () => {
	it("fresh session (no saved state) → speak inactive", async () => {
		const pi = makeFakePi({ active: ["speak"] });
		speakExtension(pi.api);

		await pi.fireEvent("session_start");

		expect(pi.active.has("speak")).toBe(false);
	});

	it("resumed session with enabled=true → speak restored as active", async () => {
		const ctx = makeCtx({ branch: [makeSpeakEntry(true)] });
		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		await pi.fireEvent("session_start", {}, ctx);

		expect(pi.active.has("speak")).toBe(true);
	});

	it("resumed session with enabled=false → speak stays inactive", async () => {
		const ctx = makeCtx({ branch: [makeSpeakEntry(false)] });
		const pi = makeFakePi({ active: ["speak"] });
		speakExtension(pi.api);

		await pi.fireEvent("session_start", {}, ctx);

		expect(pi.active.has("speak")).toBe(false);
	});

	it("does not disturb other active tools", async () => {
		const pi = makeFakePi({ active: ["read"] });
		speakExtension(pi.api);

		await pi.fireEvent("session_start");

		expect(pi.active.has("speak")).toBe(false);
		expect(pi.active.has("read")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 2. session_tree with saved enabled=true → setActiveTools includes "speak"
// ---------------------------------------------------------------------------
describe("session_tree", () => {
	it("restores enabled=true from branch state", async () => {
		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const ctx = makeCtx({ branch: [makeSpeakEntry(true)] });
		await pi.fireEvent("session_tree", {}, ctx);

		expect(pi.active.has("speak")).toBe(true);
	});

	it("restores enabled=false from branch state", async () => {
		const pi = makeFakePi({ active: ["speak"] });
		speakExtension(pi.api);

		const ctx = makeCtx({ branch: [makeSpeakEntry(false)] });
		await pi.fireEvent("session_tree", {}, ctx);

		expect(pi.active.has("speak")).toBe(false);
	});

	it("defaults to disabled when no saved state", async () => {
		const pi = makeFakePi({ active: ["speak"] });
		speakExtension(pi.api);

		const ctx = makeCtx({ branch: [] });
		await pi.fireEvent("session_tree", {}, ctx);

		expect(pi.active.has("speak")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. /speak command — opens TUI menu
// ---------------------------------------------------------------------------
describe("/speak command", () => {
	it("calls runSpeakMenu with ctx and expected callbacks", async () => {
		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const select = vi.fn().mockResolvedValue(null);
		const ctx = makeCtx({ select });
		await pi.runCommand("speak", "", ctx);

		expect(runSpeakMenu).toHaveBeenCalledOnce();
		// Verify the menu was opened with the correct ctx surface and callbacks
		const [menuCtxArg, optionsArg] = vi.mocked(runSpeakMenu).mock.calls[0]!;
		expect((menuCtxArg as { ui: { select: unknown } }).ui.select).toBe(select);
		expect(typeof (optionsArg as { onToggle: unknown }).onToggle).toBe("function");
		expect(typeof (optionsArg as { onTest: unknown }).onTest).toBe("function");
		expect(typeof (optionsArg as { onSetSessionVoice: unknown }).onSetSessionVoice).toBe("function");
	});

	it("notifies and does not call runSpeakMenu when select is unavailable", async () => {
		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const ctx = makeCtx(); // no select
		await pi.runCommand("speak", "", ctx);

		expect(runSpeakMenu).not.toHaveBeenCalled();
		expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), expect.anything());
	});
});

// ---------------------------------------------------------------------------
// 9. turn_end — LLM toggled speak via manage_tools
// ---------------------------------------------------------------------------
describe("turn_end reconciliation", () => {
	it("LLM adding 'speak' to active tools → enabled flips, appendEntry called", async () => {
		vi.mocked(assetsReady).mockReturnValue(true);

		const pi = makeFakePi({ active: ["speak"] });
		speakExtension(pi.api);

		// Fresh session (no saved state) → enabled=false
		await pi.fireEvent("session_start", {}, makeCtx());
		// But active tools already includes speak (set externally by LLM)
		pi.setActiveTools(["speak"]);

		await pi.fireEvent("turn_end");

		expect(pi.appendEntry).toHaveBeenCalledWith(SPEAK_STATE_CUSTOM_TYPE, { enabled: true });
	});

	it("LLM removing 'speak' from active tools → enabled flips, appendEntry called", async () => {
		vi.mocked(assetsReady).mockReturnValue(true);

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		// Establish enabled=true via session_tree restore
		const ctx = makeCtx({ branch: [makeSpeakEntry(true)] });
		await pi.fireEvent("session_tree", {}, ctx);

		// LLM removes speak
		pi.setActiveTools([]);
		pi.appendEntry.mockClear();

		await pi.fireEvent("turn_end");

		expect(pi.appendEntry).toHaveBeenCalledWith(SPEAK_STATE_CUSTOM_TYPE, { enabled: false });
	});
});

// ---------------------------------------------------------------------------
// 10. execute — assets missing → error content, synthesise NOT called
// ---------------------------------------------------------------------------
describe("tool execute — assets missing", () => {
	it("returns error text and does not call synthesise", async () => {
		vi.mocked(assetsReady).mockReturnValue(false);

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const result = await pi.speakTool.execute(
			"tc",
			{ text: "hello" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect((result as { content: { text: string }[] }).content[0]!.text).toContain("assets not downloaded");
		expect(synthesise).not.toHaveBeenCalled();
		const d = (result as { details: { ok: boolean; voice: string; lang: string; text: string } }).details;
		expect(d.ok).toBe(false);
		expect(d.voice).toBe("M1");
		expect(d.lang).toBe("en");
		expect(d.text).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// 10b. execute — text too long → rejects before synthesis
// ---------------------------------------------------------------------------
describe("tool execute — text too long", () => {
	it("returns ok: false with 'too long' message and does not call synthesise", async () => {
		vi.mocked(assetsReady).mockReturnValue(true);

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const longText = "a".repeat(MAX_TEXT_CHARS + 1);
		const result = await pi.speakTool.execute(
			"tc",
			{ text: longText },
			undefined,
			undefined,
			makeCtx(),
		);

		const d = (result as { details: { ok: boolean; message: string } }).details;
		expect(d.ok).toBe(false);
		expect(d.message).toContain("too long");
		expect(synthesise).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 11. execute — happy path (wait: true)
// ---------------------------------------------------------------------------
describe("tool execute — happy path", () => {
	it("calls synthesise → writeWav → playAudioFile in order, details include required fields", async () => {
		vi.mocked(assetsReady).mockReturnValue(true);
		const callOrder: string[] = [];
		vi.mocked(synthesise).mockImplementation(() => {
			callOrder.push("synthesise");
			return Promise.resolve({ wav: [0], sampleRate: 44100, duration: [0.5] });
		});
		vi.mocked(writeWav).mockImplementation(() => { callOrder.push("writeWav"); return Promise.resolve(); });
		vi.mocked(playAudioFile).mockImplementation(() => { callOrder.push("playAudioFile"); return Promise.resolve(); });

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const result = await pi.speakTool.execute(
			"tc",
			{ text: "Hello world", wait: true },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(callOrder).toEqual(["synthesise", "writeWav", "playAudioFile"]);
		const r = result as { content: { text: string }[]; details: { ok: boolean; ms: number; voice: string; lang: string; text: string } };
		expect(r.details.ok).toBe(true);
		expect(r.details.voice).toBe("M1");
		expect(r.details.lang).toBe("en");
		expect(r.details.text).toBe("Hello world");
		expect(typeof r.details.ms).toBe("number");
		expect(r.content[0]!.text).toContain("Hello world");
	});

	it("does not await playAudioFile when wait: false", async () => {
		vi.mocked(assetsReady).mockReturnValue(true);

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const result = await pi.speakTool.execute(
			"tc",
			{ text: "async playback", wait: false },
			undefined,
			undefined,
			makeCtx(),
		);

		const r = result as { details: { ok: boolean } };
		expect(r.details.ok).toBe(true);
		// playAudioFile was called (fire-and-forget)
		expect(playAudioFile).toHaveBeenCalled();
	});

	it("calls onUpdate with increasing elapsed values", async () => {
		vi.useFakeTimers();
		vi.mocked(assetsReady).mockReturnValue(true);
		vi.mocked(synthesise).mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 3500));
			return { wav: [0], sampleRate: 44100, duration: [0.5] };
		});
		vi.mocked(writeWav).mockResolvedValue(undefined);
		vi.mocked(playAudioFile).mockResolvedValue(undefined);

		const onUpdate = vi.fn();
		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const execPromise = pi.speakTool.execute(
			"tc",
			{ text: "tick tock", wait: true },
			undefined,
			onUpdate,
			makeCtx(),
		);

		await vi.advanceTimersByTimeAsync(3500);
		await execPromise;
		vi.useRealTimers();

		expect(onUpdate).toHaveBeenCalled();
		const firstCall = onUpdate.mock.calls[0]![0] as { details: { elapsed: number } };
		expect(firstCall.details.elapsed).toBe(1);
		if (onUpdate.mock.calls.length > 1) {
			const secondCall = onUpdate.mock.calls[1]![0] as { details: { elapsed: number } };
			expect(secondCall.details.elapsed).toBeGreaterThan(firstCall.details.elapsed);
		}
	});
});

// ---------------------------------------------------------------------------
// 12. execute — sessionSpeed priority over params.speed
// ---------------------------------------------------------------------------
describe("tool execute — session param priority", () => {
	it("uses sessionSpeed over params.speed when sessionSpeed is set in saved state", async () => {
		vi.mocked(assetsReady).mockReturnValue(true);

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		// Restore session that has sessionSpeed = 0.8
		const ctx = makeCtx({
			branch: [{
				type: "custom",
				customType: SPEAK_STATE_CUSTOM_TYPE,
				data: { enabled: true, sessionSpeed: 0.8 },
				id: "test-speed-entry",
				timestamp: Date.now(),
			} as unknown as SessionEntry],
		});
		await pi.fireEvent("session_start", {}, ctx);

		// Execute with params.speed = 1.5 — sessionSpeed (0.8) should win
		await pi.speakTool.execute(
			"tc",
			{ text: "hello", speed: 1.5 },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(synthesise).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({ speed: 0.8 }),
			expect.any(String),
		);
	});

	it("uses params.speed when no sessionSpeed is set", async () => {
		vi.mocked(assetsReady).mockReturnValue(true);

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);
		await pi.fireEvent("session_start", {}, makeCtx());

		await pi.speakTool.execute(
			"tc",
			{ text: "hello", speed: 1.3 },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(synthesise).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({ speed: 1.3 }),
			expect.any(String),
		);
	});
});

describe("tool execute — timeout", () => {
	it("returns error when synthesis never resolves within 60s", async () => {
		vi.useFakeTimers();
		vi.mocked(assetsReady).mockReturnValue(true);
		// synthesise never resolves
		vi.mocked(synthesise).mockImplementation(() => new Promise(() => {}));

		const pi = makeFakePi({ active: [] });
		speakExtension(pi.api);

		const execPromise = pi.speakTool.execute(
			"tc",
			{ text: "never done" },
			undefined,
			undefined,
			makeCtx(),
		);

		// Advance past the ~30-second timeout for short text (executionTimeoutMs(10) = 30 s)
		await vi.advanceTimersByTimeAsync(31_000);
		const result = await execPromise;
		vi.useRealTimers();

		const d = (result as { details: { ok: boolean; message: string } }).details;
		expect(d.ok).toBe(false);
		expect(d.message).toContain("timed out");
	});
});

