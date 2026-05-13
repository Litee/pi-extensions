import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setCmuxSpawnerForTests } from "../src/cmux.js";
import createExtension, { shortCwd } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles — minimal ExtensionAPI / ExtensionContext
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
	readonly commands: Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => unknown;
		}
	>;
}

function makeFakePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => unknown;
		}
	>();
	const on = vi.fn((evt: string, fn: (...a: unknown[]) => unknown) => {
		handlers.set(evt, fn);
	});
	const registerCommand = vi.fn(
		(
			name: string,
			def: {
				description: string;
				handler: (args: string, ctx: unknown) => unknown;
			},
		) => {
			commands.set(name, def);
		},
	);
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const eventsOn = vi.fn((channel: string, fn: (data: unknown) => void) => {
		eventHandlers.set(channel, fn);
	});
	return {
		on,
		registerCommand,
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		events: {
			on: eventsOn,
			emit: vi.fn(),
			handlers: eventHandlers,
		},
		handlers,
		commands,
	};
}

function makeFakeCtx(): {
	ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
} {
	return { ui: { notify: vi.fn(), setStatus: vi.fn() } };
}

// ---------------------------------------------------------------------------
// Helpers to toggle cmuxAvailable() from tests
// ---------------------------------------------------------------------------

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

describe("default export — wiring", () => {
	it("subscribes to the three-state lifecycle events", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
		// Both `input` and `before_agent_start` flip to bolt — belt & braces
		// so non-interactive turn starts (slack-watcher injection, recovery)
		// also light up the working pill.
		for (const evt of [
			"session_start",
			"session_shutdown",
			"input",
			"before_agent_start",
			"agent_end",
		]) {
			expect(subscribed).toContain(evt);
		}
		// tool_execution_start/end are not wired — attention for
		// ask_user_question is now emitted via pi.events.
		expect(subscribed).not.toContain("tool_execution_start");
		expect(subscribed).not.toContain("tool_execution_end");
	});

	it("subscribes to attention events on pi.events", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.events.handlers.has("need_user_attention")).toBe(true);
		expect(pi.events.handlers.has("user_attention_resolved")).toBe(true);
	});

	it("does NOT register the /cmux-rename command (that lives in pi-cmux-update-workspace-name)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.commands.get("cmux-rename")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("session lifecycle side-effects", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(
			spawner as unknown as (args: string[]) => Promise<void>,
		);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("session_start emits set-status idle (green checkmark) + a session-started log line", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"set-status",
			"pi",
			"idle",
			"--icon",
			"checkmark",
			"--color",
			"#30d158",
		]);
		expect(
			argvs.some(
				(a) => a[0] === "log" && a.some((s) => s.includes("pi session started")),
			),
		).toBe(true);
	});

	it("agent_end clears progress, returns the pill to idle (green checkmark), logs, and does NOT desktop-notify", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs).toContainEqual([
			"set-status",
			"pi",
			"idle",
			"--icon",
			"checkmark",
			"--color",
			"#30d158",
		]);
		expect(
			argvs.some(
				(a) => a[0] === "log" && a.some((s) => s.includes("Response complete")),
			),
		).toBe(true);
		// Crucially, no desktop notification — the pill returning to idle and
		// the sidebar log are the signal. Notifications are reserved for the
		// `attention` state.
		expect(argvs.some((a) => a[0] === "notify")).toBe(false);
		// And no leftover "done" state from the old design.
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "done")).toBe(false);
	});

	it("session_shutdown clears progress and the status pill", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_shutdown")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs).toContainEqual(["set-status", "pi", ""]);
	});

	it("before_agent_start flips the pill to working (orange bolt)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("before_agent_start")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"set-status",
			"pi",
			"working",
			"--icon",
			"bolt",
			"--color",
			"#ff9500",
		]);
	});

	it("pi.events need_user_attention sets the speech-bubble red attention pill and fires a desktop notify", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const handler = pi.events.handlers.get("need_user_attention")!;
		expect(handler).toBeDefined();
		handler({ source: "plan-mode", title: "Plan mode \u2014 what next?" });
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"set-status",
			"pi",
			"attention",
			"--icon",
			"bubble.left.fill",
			"--color",
			"#ff3b30",
		]);
		expect(
			argvs.some(
				(a) => a[0] === "notify" && a.some((s) => s.includes("Plan mode")),
			),
		).toBe(true);
	});

	it("pi.events need_user_attention falls back to a generic title when payload omits one", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const handler = pi.events.handlers.get("need_user_attention")!;
		handler(undefined);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(
			argvs.some(
				(a) => a[0] === "notify" && a.some((s) => s.includes("Needs your input")),
			),
		).toBe(true);
	});

	it("pi.events user_attention_resolved flips pill back to working (bolt) silently", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const handler = pi.events.handlers.get("user_attention_resolved")!;
		expect(handler).toBeDefined();
		handler(undefined);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(true);
		expect(argvs.some((a) => a[0] === "notify")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// input handler gating
// ---------------------------------------------------------------------------

describe("input handler", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(
			spawner as unknown as (args: string[]) => Promise<void>,
		);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("ignores slash commands", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "/help" },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(false);
	});

	it("ignores empty text", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "   " },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(false);
	});

	it("ignores non-interactive sources (covered by before_agent_start instead)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!(
			{ source: "api", text: "hello" },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		// `input` from a non-interactive source is filtered, but the
		// before_agent_start hook (tested elsewhere) still lights up the
		// bolt for these turns.
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(false);
	});

	it("flips the pill to 'working' on an eligible user message", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "do a thing" },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"set-status",
			"pi",
			"working",
			"--icon",
			"bolt",
			"--color",
			"#ff9500",
		]);
	});

	it("flips the pill to 'working' on every eligible user message (not just the first)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();

		await pi.handlers.get("input")!(
			{ source: "interactive", text: "first" },
			ctx,
		);
		const afterFirst = spawner.mock.calls.length;
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "second" },
			ctx,
		);
		const argvsAfterSecond = spawner.mock.calls
			.slice(afterFirst)
			.map((c) => c[0] as string[]);
		expect(argvsAfterSecond).toContainEqual([
			"set-status",
			"pi",
			"working",
			"--icon",
			"bolt",
			"--color",
			"#ff9500",
		]);
	});
});
