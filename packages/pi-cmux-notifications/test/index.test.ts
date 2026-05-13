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
		expect(shortCwd("/path/to/pi-extensions")).toBe(
			"pi-extensions",
		);
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
	it("subscribes to the status-pill lifecycle events", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
		for (const evt of [
			"session_start",
			"session_shutdown",
			"input",
			"agent_end",
		]) {
			expect(subscribed).toContain(evt);
		}
		// `before_agent_start` is intentionally not wired — the pill is
		// flipped to 'working' from the `input` handler instead.
		expect(subscribed).not.toContain("before_agent_start");
		// tool_execution_start/end are no longer wired — attention for
		// ask_user_question is now emitted by pi-ask-user-question via pi.events.
		expect(subscribed).not.toContain("tool_execution_start");
		expect(subscribed).not.toContain("tool_execution_end");
	});

	it("does NOT register the /cmux-rename command (that lives in pi-cmux-update-workspace-name)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.commands.get("cmux-rename")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// session_start → idle pill, session_shutdown → clear
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

	it("session_start emits set-status idle + a session-started log line", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "idle")).toBe(true);
		expect(argvs.some((a) => a[0] === "log" && a.some((s) => s.includes("pi session started")))).toBe(true);
	});

	it("agent_end clears progress, sets done pill (red circle), logs, and fires a smart-mode desktop notify when focus state is unknown", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "done")).toBe(true);
		expect(argvs.some((a) => a[0] === "log" && a.some((s) => s.includes("Response complete")))).toBe(true);
		// Smart mode (default): no TTY in tests means focus reporting is off,
		// so we fall back to notifying — the user has no other way to tell.
		expect(argvs.some((a) => a[0] === "notify" && a.some((s) => s.includes("Response ready")))).toBe(true);
	});

	it("agent_end stays silent when PI_CMUX_NOTIFY_ON_DONE=never", async () => {
		const prev = process.env["PI_CMUX_NOTIFY_ON_DONE"];
		process.env["PI_CMUX_NOTIFY_ON_DONE"] = "never";
		try {
			const pi = makeFakePi();
			createExtension(pi as never);
			await pi.handlers.get("agent_end")!({}, makeFakeCtx());
			const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
			expect(argvs.some((a) => a[0] === "set-status" && a[2] === "done")).toBe(true);
			expect(argvs.some((a) => a[0] === "notify")).toBe(false);
		} finally {
			if (prev === undefined) delete process.env["PI_CMUX_NOTIFY_ON_DONE"];
			else process.env["PI_CMUX_NOTIFY_ON_DONE"] = prev;
		}
	});

	it("agent_end always notifies when PI_CMUX_NOTIFY_ON_DONE=always", async () => {
		const prev = process.env["PI_CMUX_NOTIFY_ON_DONE"];
		process.env["PI_CMUX_NOTIFY_ON_DONE"] = "always";
		try {
			const pi = makeFakePi();
			createExtension(pi as never);
			await pi.handlers.get("agent_end")!({}, makeFakeCtx());
			const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
			expect(argvs.some((a) => a[0] === "notify" && a.some((s) => s.includes("Response ready")))).toBe(true);
		} finally {
			if (prev === undefined) delete process.env["PI_CMUX_NOTIFY_ON_DONE"];
			else process.env["PI_CMUX_NOTIFY_ON_DONE"] = prev;
		}
	});

	it("agent_end sets circle.fill red status pill (not idle checkmark)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "done")).toBe(true);
		expect(argvs.some((a) => a.includes("circle.fill"))).toBe(true);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "idle")).toBe(false);
	});

	it("input after agent_end clears the pending dot (pill changes to working, not idle)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		spawner.mockClear();
		await pi.handlers.get("input")!({ source: "interactive", text: "hi" }, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		// Should flip to working, not idle
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(true);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "idle")).toBe(false);
	});

	it("session_shutdown clears progress and the status pill", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_shutdown")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs).toContainEqual(["set-status", "pi", ""]);
	});

	it("pi.events need_user_attention flips pill to waiting and fires a desktop notify", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const handler = pi.events.handlers.get("need_user_attention")!;
		expect(handler).toBeDefined();
		handler({ source: "plan-mode", title: "Plan mode \u2014 what next?" });
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "waiting")).toBe(true);
		expect(argvs.some((a) => a[0] === "notify" && a.some((s) => s.includes("Plan mode")))).toBe(true);
	});

	it("pi.events user_attention_resolved flips pill back to working", () => {
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
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(
			false,
		);
	});

	it("ignores empty text", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "   " },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(
			false,
		);
	});

	it("ignores non-interactive sources", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("input")!(
			{ source: "api", text: "hello" },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(
			false,
		);
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
