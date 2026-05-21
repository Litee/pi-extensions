/**
 * Dispatch-level tests for the `/recap` command (tracker issue #0004).
 *
 * We stub out the `ExtensionAPI` just far enough to capture the handler
 * registered for `recap`, then exercise the four subcommand cases:
 *
 *   /recap           → generateAndShow path (side-effect: getBranch read)
 *   /recap <other>   → notify("...", "warning"), no branch read, no LLM call
 *
 * `ctx.sessionManager.getBranch` being called is used as a proxy for
 * `generateAndShow` being entered — the status / help / unknown paths
 * must short-circuit before it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import createExtension from "../src/index.js";

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	readonly commands: Map<
		string,
		{ description: string; handler: (args: string, ctx: unknown) => unknown }
	>;
	readonly handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	readonly renderers: Map<
		string,
		(message: { customType: string; content: string; details?: unknown }, options: { expanded: boolean }, theme: unknown) => unknown
	>;
}

function makeFakePi(
	opts: {
		flagValues?: Record<string, boolean | string>;
		getFlag?: (name: string) => boolean | string | undefined;
	} = {},
): StubPi {
	const commands = new Map<
		string,
		{ description: string; handler: (args: string, ctx: unknown) => unknown }
	>();
	const handlers = new Map<
		string,
		(event: unknown, ctx: unknown) => unknown
	>();
	const renderers = new Map<
		string,
		(message: { customType: string; content: string; details?: unknown }, options: { expanded: boolean }, theme: unknown) => unknown
	>();
	const on = vi.fn((event: string, fn: (event: unknown, ctx: unknown) => unknown) => {
		handlers.set(event, fn);
	});
	const registerFlag = vi.fn();
	const registerMessageRenderer = vi.fn(
		(
			customType: string,
			renderer: (
				message: { customType: string; content: string; details?: unknown },
				options: { expanded: boolean },
				theme: unknown,
			) => unknown,
		) => {
			renderers.set(customType, renderer);
		},
	);
	const registerCommand = vi.fn(
		(
			name: string,
			def: { description: string; handler: (args: string, ctx: unknown) => unknown },
		) => {
			commands.set(name, def);
		},
	);
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();
	// Return undefined for any flag unless the test seeded a value (or a
	// custom `getFlag` is wired in for regression tests).
	const flagValues = opts.flagValues ?? {};
	const getFlagImpl = opts.getFlag ?? ((name: string) => flagValues[name]);
	const getFlag = vi.fn(getFlagImpl);

	return {
		on,
		registerCommand,
		registerFlag,
		registerMessageRenderer,
		sendMessage,
		appendEntry,
		getFlag,
		commands,
		handlers,
		renderers,
	};
}

interface StubCtx {
	hasUI: boolean;
	model: { provider: string; id: string } | undefined;
	ui: {
		notify: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
		setWidget: ReturnType<typeof vi.fn>;
		select: ReturnType<typeof vi.fn<(title: string, items: string[]) => Promise<string | null | undefined>>>;
		input: ReturnType<typeof vi.fn<(prompt: string, defaultValue?: string) => Promise<string | null | undefined>>>;
		theme: { fg: (color: string, text: string) => string; bold: (text: string) => string };
	};
	sessionManager: {
		getBranch: ReturnType<typeof vi.fn>;
		getLeafId: ReturnType<typeof vi.fn>;
	};
	modelRegistry: {
		getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
	};
}

function makeFakeCtx(): StubCtx {
	return {
		hasUI: true,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			select: vi.fn<(title: string, items: string[]) => Promise<string | null | undefined>>(
				() => Promise.resolve("Close"),
			),
			input: vi.fn<(prompt: string, defaultValue?: string) => Promise<string | null | undefined>>(
				() => Promise.resolve(null),
			),
			theme: {
				fg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			},
		},
		sessionManager: {
			// Empty branch keeps generateAndShow fully self-contained — it sees
			// an empty transcript and returns before any network / pi-ai call.
			getBranch: vi.fn(() => []),
			getLeafId: vi.fn(() => undefined),
		},
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(() => ({ ok: false })),
		},
	};
}

describe("/recap command dispatch (#0004)", () => {
	let agentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		// Point readUserRecapModel() at an empty temp dir so the tests never
		// observe the host machine's ~/.pi/agent/settings.json.
		agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-dispatch-"));
		prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	function getHandler(
		pi: StubPi,
	): (args: string, ctx: unknown) => unknown {
		const cmd = pi.commands.get("recap");
		expect(cmd).toBeDefined();
		return cmd!.handler;
	}

	it("registers /recap with a description that no longer advertises a status subcommand, and registers /recap-settings", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const recap = pi.commands.get("recap");
		expect(recap?.description).toBe("Generate a one-line recap of recent activity");
		expect(recap?.description).not.toMatch(/status/i);

		const settings = pi.commands.get("recap-settings");
		expect(settings).toBeDefined();
		expect(settings?.description).toMatch(/settings/i);
	});

	it("empty args runs the generateAndShow path (reads the current branch)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("", ctx);

		// generateAndShow reads the branch as its first step. Empty branch ->
		// empty transcript -> returns before any LLM call, but the read itself
		// is our observable signal that the manual path was entered.
		expect(ctx.sessionManager.getBranch).toHaveBeenCalledTimes(1);
		// No status/help-style notification on the manual path.
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("the legacy `status` subcommand is no longer recognised and produces a `Unknown` toast pointing at /recap-settings", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("status", ctx);

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [body, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(body).toMatch(/status/);
		expect(body).toMatch(/\/recap-settings/);
	});

	it("the legacy `help` subcommand is no longer recognised — produces an Unknown toast pointing at /recap-settings", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("help", ctx);

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [body, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(body).toMatch(/help/);
		expect(body).toMatch(/\/recap-settings/);
	});

	it("unknown subcommand emits exactly one warning toast (kept as a toast — typos should not pollute chat)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("banana", ctx);

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		// User-input errors stay as transient toasts, NOT chat messages.
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [body, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(body).toMatch(/banana/);
		// The toast must steer the user toward the dedicated settings command.
		expect(body).toMatch(/\/recap-settings/);
	});

	it("normalises case and whitespace around the unknown-subcommand payload (keeps the warning toast)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("  BANANA  ", ctx);

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [body, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(body).toMatch(/banana/);
	});
});

// ---------------------------------------------------------------------------
// Flag-key wiring (#0004 follow-up: pi.registerFlag / pi.getFlag parity)
// ---------------------------------------------------------------------------
//
// pi-coding-agent's `pi.registerFlag(name, …)` stores the key as `name`
// verbatim in the runtime's flagValues map — no `--` prefix is added or
// stripped. Earlier revisions of this extension read with `pi.getFlag("--…")`
// which silently returned undefined for every flag, so overrides were
// effectively dead. These tests pin the bare-name contract.

describe("flag-key wiring — pi.getFlag must match pi.registerFlag names (no `--` prefix)", () => {
	let agentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-flags-"));
		prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("surfaces all five flag values in the `/recap-settings` menu items when seeded under their bare registration names", async () => {
		const pi = makeFakePi({
			flagValues: {
				"recap-idle-seconds": "45",
				"recap-focus-min-seconds": "7",
				"recap-disable": true,
				"recap-disable-focus": true,
				"recap-model": "anthropic/claude-haiku-4-5",
			},
		});
		createExtension(pi as never);

		const cmd = pi.commands.get("recap-settings");
		expect(cmd).toBeDefined();
		const ctx = makeFakeCtx();
		await cmd!.handler("", ctx);

		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		const [, items] = ctx.ui.select.mock.calls[0] as [string, string[]];
		const body = items.join("\n");

		// Numeric flags flow through.
		expect(body).toContain("Idle trigger:   45s after turn_end");
		// --recap-disable-focus wins over focus seconds.
		expect(body).toContain("Focus trigger:  disabled");
		expect(body).toContain("Auto-recap:     disabled");
		expect(body).toContain("Disabled flags: --recap-disable, --recap-disable-focus");
		expect(body).toContain("anthropic/claude-haiku-4-5");
		expect(body).toMatch(/from --recap-model|override failed to resolve/);
		// The editable idle-timeout row reflects the same flag value.
		expect(items.some((it) => it.startsWith("Edit idle timeout: 45s"))).toBe(true);
		// And a Close row terminates the menu.
		expect(items[items.length - 1]).toBe("Close");
	});

	it("surfaces `recap-focus-min-seconds` in the Focus trigger row of the `/recap-settings` menu when `recap-disable-focus` is false", async () => {
		const pi = makeFakePi({
			flagValues: {
				"recap-focus-min-seconds": "7",
				// recap-disable-focus deliberately omitted → defaults to false.
			},
		});
		createExtension(pi as never);

		const ctx = makeFakeCtx();
		await pi.commands.get("recap-settings")!.handler("", ctx);

		const [, items] = ctx.ui.select.mock.calls[0] as [string, string[]];
		expect(items.join("\n")).toContain("Focus trigger:  enabled (min 7s away)");
	});

	it("regression guard — `pi.getFlag` is never called with a `--`-prefixed key on session_start, /recap (no args), or /recap-settings", async () => {
		const offenders: string[] = [];
		const pi = makeFakePi({
			getFlag: (name: string): boolean | string | undefined => {
				if (name.startsWith("--")) {
					offenders.push(name);
					throw new Error(
						`pi.getFlag called with '${name}'; registerFlag stores keys without the '--' prefix`,
					);
				}
				return undefined;
			},
		});
		createExtension(pi as never);

		const sessionStart = pi.handlers.get("session_start");
		expect(sessionStart).toBeDefined();
		await sessionStart!({ reason: "start" }, makeFakeCtx());

		const recap = pi.commands.get("recap")!.handler;
		const settings = pi.commands.get("recap-settings")!.handler;
		// /recap with an unknown payload short-circuits to a toast and reads
		// no flags, but run it anyway so future refactors that start reading
		// flags on the unknown branch are caught.
		await recap("banana", makeFakeCtx());
		// /recap-settings exercises all five registered flags via
		// resolveStatusOptions → configuredOverride / idleSeconds /
		// focusMinSeconds / isDisabled / isFocusDisabled.
		await settings("", makeFakeCtx());

		expect(offenders).toEqual([]);
	});
});

describe("orchestrator lifecycle — session replacement", () => {
	let agentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-lifecycle-"));
		prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("cancels the old orchestrator's pending recap timer on session replacement (prevents stale ctx access)", async () => {
		vi.useFakeTimers();
		try {
			const pi = makeFakePi();
			createExtension(pi as unknown as ExtensionAPI);

			// Branch with enough assistant words to pass hasMeaningfulActivity
			const meaningfulEntries = [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "tell me about X" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "word ".repeat(35).trim() }],
					},
				},
			];

			const ctx1 = makeFakeCtx();
			ctx1.sessionManager.getBranch.mockReturnValue(meaningfulEntries);
			// getApiKeyAndHeaders is the first ctx access inside runModelCall.
			// If the timer fires with a stale ctx, this spy will record the call.
			ctx1.modelRegistry.getApiKeyAndHeaders = vi.fn(() => ({ ok: false }));

			// Initial session start + turn end → recap timer scheduled on ctx1
			await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx1);
			await pi.handlers.get("turn_end")?.({}, ctx1);

			// Session is replaced (e.g. /reload, /new, /fork) — no session_shutdown in between
			const ctx2 = makeFakeCtx();
			await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx2);

			// Advance past the default idle timeout (300 s)
			await vi.advanceTimersByTimeAsync(200_000);

			// The old orchestrator's timer must have been cleared — ctx1 was never accessed
			expect(ctx1.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Session-scoped idle-timeout override applied via /recap-settings
// ---------------------------------------------------------------------------
//
// `/recap-settings` writes the new idle value into a closure-scoped variable
// that takes precedence over `--recap-idle-seconds`. The override must:
//   1) reflect immediately in the menu's read-only Idle trigger row,
//   2) survive across reopenings of the menu within the same session,
//   3) be cleared on session_shutdown so it never leaks into the next session.

describe("/recap-settings session-scoped idle override", () => {
	let agentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-idle-override-"));
		prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("setting an override via the menu wins over `--recap-idle-seconds` for the rest of the session", async () => {
		const pi = makeFakePi({ flagValues: { "recap-idle-seconds": "45" } });
		createExtension(pi as never);

		const ctx = makeFakeCtx();

		// First menu invocation: editable row reflects the flag-derived value.
		let phase = 0;
		ctx.ui.select.mockImplementation((_t: unknown, items: unknown) => {
			phase += 1;
			const list = items as string[];
			if (phase === 1) return Promise.resolve(list.find((i) => i.startsWith("Edit idle timeout:"))!);
			return Promise.resolve("Close");
		});
		ctx.ui.input.mockImplementation(() => Promise.resolve("600"));

		await pi.commands.get("recap-settings")!.handler("", ctx);

		const firstItems = ctx.ui.select.mock.calls[0]![1];
		expect(firstItems.find((i) => i.startsWith("Edit idle timeout:"))).toBe("Edit idle timeout: 45s");
		expect(firstItems.join("\n")).toContain("Idle trigger:   45s after turn_end");

		// Re-open the menu in the same session: override now wins.
		const ctx2 = makeFakeCtx();
		await pi.commands.get("recap-settings")!.handler("", ctx2);
		const secondItems = ctx2.ui.select.mock.calls[0]![1];
		expect(secondItems.find((i) => i.startsWith("Edit idle timeout:"))).toBe("Edit idle timeout: 600s");
		expect(secondItems.join("\n")).toContain("Idle trigger:   600s after turn_end");
	});

	it("clears the override on session_shutdown so it does not leak into the next session", async () => {
		const pi = makeFakePi({ flagValues: { "recap-idle-seconds": "45" } });
		createExtension(pi as never);

		const ctx = makeFakeCtx();
		ctx.ui.select.mockImplementationOnce((_t: unknown, items: unknown) =>
			Promise.resolve((items as string[]).find((i) => i.startsWith("Edit idle timeout:"))!),
		);
		ctx.ui.select.mockImplementationOnce(() => Promise.resolve("Close"));
		ctx.ui.input.mockImplementation(() => Promise.resolve("600"));
		await pi.commands.get("recap-settings")!.handler("", ctx);

		// Shutdown wipes the override.
		await pi.handlers.get("session_shutdown")?.({}, ctx);

		// Reopen menu after shutdown: idle row falls back to the flag again.
		const ctx2 = makeFakeCtx();
		await pi.commands.get("recap-settings")!.handler("", ctx2);
		const items = ctx2.ui.select.mock.calls[0]![1];
		expect(items.find((i) => i.startsWith("Edit idle timeout:"))).toBe("Edit idle timeout: 45s");
	});
});
