import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setCmuxSpawnerForTests } from "../src/cmux.js";
import createExtension, { shortCwd } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	events: {
		on: ReturnType<typeof vi.fn>;
		emit: ReturnType<typeof vi.fn>;
		handlers: Map<string, (data: unknown) => void>;
	};
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	readonly commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>;
}

function makeFakePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>();
	const on = vi.fn((evt: string, fn: (...a: unknown[]) => unknown) => { handlers.set(evt, fn); });
	const registerCommand = vi.fn((name: string, def: { description: string; handler: (args: string, ctx: unknown) => unknown }) => { commands.set(name, def); });
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const eventsOn = vi.fn((channel: string, fn: (data: unknown) => void) => { eventHandlers.set(channel, fn); });
	return {
		on, registerCommand,
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		events: { on: eventsOn, emit: vi.fn(), handlers: eventHandlers },
		handlers, commands,
	};
}

function makeFakeCtx() {
	return { ui: { notify: vi.fn(), setStatus: vi.fn() } };
}

function enterCmux(): () => void {
	const prevWs = process.env["CMUX_WORKSPACE_ID"];
	const prevTab = process.env["CMUX_TAB_ID"];
	const prevSurface = process.env["CMUX_SURFACE_ID"];
	process.env["CMUX_WORKSPACE_ID"] = "ws-test";
	process.env["CMUX_TAB_ID"] = "tab-test";
	delete process.env["CMUX_SURFACE_ID"];
	return () => {
		if (prevWs === undefined) delete process.env["CMUX_WORKSPACE_ID"];
		else process.env["CMUX_WORKSPACE_ID"] = prevWs;
		if (prevTab === undefined) delete process.env["CMUX_TAB_ID"];
		else process.env["CMUX_TAB_ID"] = prevTab;
		if (prevSurface === undefined) delete process.env["CMUX_SURFACE_ID"];
		else process.env["CMUX_SURFACE_ID"] = prevSurface;
	};
}

const IDLE_ARGV      = ["set-status", "pi", "idle",      "--icon", "circle.fill",      "--color", "#8e8e93"];
const WORKING_ARGV   = ["set-status", "pi", "working",   "--icon", "bolt",             "--color", "#ff9500"];
const UNREAD_ARGV    = ["set-status", "pi", "unread",    "--icon", "circle.fill",      "--color", "#007aff"];
const ATTENTION_ARGV = ["set-status", "pi", "attention", "--icon", "bubble.left.fill", "--color", "#ff3b30"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("shortCwd", () => {
	it("returns the trailing path component", () => {
		expect(shortCwd("/path/to/pi-extensions")).toBe("pi-extensions");
	});
	it("handles trailing slashes", () => {
		expect(shortCwd("/foo/bar/")).toBe("bar");
	});
	it("falls back to 'pi' for empty input", () => {
		expect(shortCwd("")).toBe("pi");
		expect(shortCwd("/")).toBe("pi");
	});
});

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

describe("event wiring", () => {
	it("subscribes to all lifecycle events", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
		for (const evt of ["session_start", "session_shutdown", "input", "before_agent_start", "agent_end"]) {
			expect(subscribed).toContain(evt);
		}
	});
	it("subscribes to attention events on pi.events", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.events.handlers.has("need_user_attention")).toBe(true);
		expect(pi.events.handlers.has("user_attention_resolved")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Pill states
// ---------------------------------------------------------------------------

describe("pill states", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(spawner as unknown as (args: string[]) => Promise<void>);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("session_start → grey circle idle + log line", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(IDLE_ARGV);
		expect(argvs.some((a) => a[0] === "log" && a.some((s) => s.includes("pi session started")))).toBe(true);
	});

	it("before_agent_start → orange bolt", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("before_agent_start")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(WORKING_ARGV);
	});

	it("agent_end when focused → grey circle idle (you were watching)", async () => {
		// focusedAway starts false (no focus events fired), so agent_end
		// should go straight to idle — no unread badge needed.
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs).toContainEqual(IDLE_ARGV);
		expect(argvs).not.toContainEqual(UNREAD_ARGV);
		expect(argvs.some((a) => a[0] === "log" && a.some((s) => s.includes("Response complete")))).toBe(true);
		// No desktop notification — pill change + log are the signal.
		expect(argvs.some((a) => a[0] === "notify")).toBe(false);
	});

	it("agent_end never sets the old 'done' value", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "done")).toBe(false);
	});

	it("attention → red speech bubble + desktop notify", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		pi.events.handlers.get("need_user_attention")!({ title: "What next?" });
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(ATTENTION_ARGV);
		expect(argvs.some((a) => a[0] === "notify" && a.some((s) => s.includes("What next?")))).toBe(true);
	});

	it("attention with no title falls back to generic message", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		pi.events.handlers.get("need_user_attention")!(undefined);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "notify" && a.some((s) => s.includes("Needs your input")))).toBe(true);
	});

	it("user_attention_resolved → orange bolt, no notify", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		pi.events.handlers.get("user_attention_resolved")!(undefined);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(WORKING_ARGV);
		expect(argvs.some((a) => a[0] === "notify")).toBe(false);
	});

	it("session_shutdown clears progress and pill", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_shutdown")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs).toContainEqual(["set-status", "pi", ""]);
	});
});

// ---------------------------------------------------------------------------
// Unread state — focus-aware agent_end
// ---------------------------------------------------------------------------

describe("unread state", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	// Simulate a focus-out event arriving on stdin by invoking the stdin
	// data listener that attachFocusReporting() registers. We capture it
	// by monkey-patching process.stdin.on before session_start fires.
	let stdinListeners: Array<(chunk: Buffer) => void> = [];

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(spawner as unknown as (args: string[]) => Promise<void>);

		stdinListeners = [];

		// Make stdin + stdout look like TTYs and capture the data listener.
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		vi.spyOn(process.stdin, "on").mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
			if (event === "data") stdinListeners.push(listener);
			return process.stdin;
		});
		vi.spyOn(process.stdin, "off").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
		vi.restoreAllMocks();
		Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
	});

	const FOCUS_OUT = Buffer.from("\x1b[O", "binary");
	const FOCUS_IN  = Buffer.from("\x1b[I", "binary");

	function sendFocus(buf: Buffer): void {
		for (const listener of stdinListeners) listener(buf);
	}

	it("agent_end while focused away → blue circle unread", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());

		sendFocus(FOCUS_OUT); // user leaves the pane
		spawner.mockClear();

		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(UNREAD_ARGV);
		expect(argvs).not.toContainEqual(IDLE_ARGV);
	});

	it("focus-in after unread → grey circle idle (user is back)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());

		sendFocus(FOCUS_OUT);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		spawner.mockClear();

		sendFocus(FOCUS_IN); // user returns to the pane
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(IDLE_ARGV);
	});

	it("focus-in when not unread (e.g. mid-turn) does not change the pill", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());

		sendFocus(FOCUS_OUT);
		await pi.handlers.get("before_agent_start")!({}, makeFakeCtx()); // pill = working
		spawner.mockClear();

		sendFocus(FOCUS_IN); // returns while agent still working — should not flip to idle
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).not.toContainEqual(IDLE_ARGV);
		expect(argvs).not.toContainEqual(UNREAD_ARGV);
	});

	it("new input while unread (user types before looking) → clears to working", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());

		sendFocus(FOCUS_OUT);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		spawner.mockClear();

		await pi.handlers.get("input")!({ source: "interactive", text: "another question" }, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(WORKING_ARGV);
		expect(argvs).not.toContainEqual(UNREAD_ARGV);
	});

	it("multiple agent_ends while away keep showing unread", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());

		sendFocus(FOCUS_OUT);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		await pi.handlers.get("before_agent_start")!({}, makeFakeCtx());
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());

		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		// Last agent_end should still produce unread
		const lastSetStatus = [...argvs].reverse().find((a) => a[0] === "set-status" && a[1] === "pi") ?? [];
		expect(lastSetStatus?.[2]).toBe("unread");
	});
});

// ---------------------------------------------------------------------------
// input handler gating
// ---------------------------------------------------------------------------

describe("input handler gating", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(spawner as unknown as (args: string[]) => Promise<void>);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("ignores slash commands", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!({ source: "interactive", text: "/help" }, makeFakeCtx());
		expect(spawner.mock.calls.map((c) => c[0] as string[]).some((a) => a[2] === "working")).toBe(false);
	});

	it("ignores empty text", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!({ source: "interactive", text: "   " }, makeFakeCtx());
		expect(spawner.mock.calls.map((c) => c[0] as string[]).some((a) => a[2] === "working")).toBe(false);
	});

	it("ignores non-interactive sources", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!({ source: "api", text: "hello" }, makeFakeCtx());
		expect(spawner.mock.calls.map((c) => c[0] as string[]).some((a) => a[2] === "working")).toBe(false);
	});

	it("flips to working on an eligible message", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!({ source: "interactive", text: "do a thing" }, makeFakeCtx());
		expect(spawner.mock.calls.map((c) => c[0] as string[])).toContainEqual(WORKING_ARGV);
	});
});
