/**
 * Dispatch-level tests for the `/recap` command (tracker issue #0004).
 *
 * We stub out the `ExtensionAPI` just far enough to capture the handler
 * registered for `recap`, then exercise the four subcommand cases:
 *
 *   /recap           → generateAndShow path (side-effect: getBranch read)
 *   /recap status    → notify("...", "info"), no branch read, no LLM call
 *   /recap help      → notify("...", "info"), no branch read, no LLM call
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

import createExtension from "../src/index.js";

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	readonly commands: Map<
		string,
		{ description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }
	>;
	readonly handlers: Map<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>>;
}

function makeFakePi(
	opts: {
		flagValues?: Record<string, boolean | string>;
		getFlag?: (name: string) => boolean | string | undefined;
	} = {},
): StubPi {
	const commands = new Map<
		string,
		{ description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }
	>();
	const handlers = new Map<
		string,
		(event: unknown, ctx: unknown) => unknown | Promise<unknown>
	>();
	const on = vi.fn((event: string, fn: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) => {
		handlers.set(event, fn);
	});
	const registerFlag = vi.fn();
	const registerCommand = vi.fn(
		(
			name: string,
			def: { description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> },
		) => {
			commands.set(name, def);
		},
	);
	const sendMessage = vi.fn();
	// Return undefined for any flag unless the test seeded a value (or a
	// custom `getFlag` is wired in for regression tests).
	const flagValues = opts.flagValues ?? {};
	const getFlagImpl = opts.getFlag ?? ((name: string) => flagValues[name]);
	const getFlag = vi.fn(getFlagImpl);

	return {
		on,
		registerCommand,
		registerFlag,
		sendMessage,
		getFlag,
		commands,
		handlers,
	};
}

interface StubCtx {
	hasUI: boolean;
	model: { provider: string; id: string } | undefined;
	ui: {
		notify: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
		setWidget: ReturnType<typeof vi.fn>;
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
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: false })),
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
	): (args: string, ctx: unknown) => unknown | Promise<unknown> {
		const cmd = pi.commands.get("recap");
		expect(cmd).toBeDefined();
		return cmd!.handler;
	}

	it("registers /recap with the updated description that mentions status", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const cmd = pi.commands.get("recap");
		expect(cmd?.description).toBe("Generate a one-line recap, or show status (/recap status)");
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

	it("`status` subcommand does NOT call generateAndShow and emits exactly one chat-scroll message (no turn triggered)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("status", ctx);

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		// Status output lands in the main chat scroll, NOT as a toast.
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload, opts] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean },
			{ triggerTurn?: boolean; deliverAs?: string },
		];
		expect(payload.customType).toBe("pi-session-recap:subcommand");
		expect(payload.display).toBe(true);
		expect(payload.content.split("\n")[0]).toBe("recap status");
		expect(payload.content).toContain("anthropic/claude-sonnet-4-6");
		// `/recap status` MUST be informational — never causes an agent turn.
		expect(opts.triggerTurn).toBe(false);
	});

	it("`help` subcommand emits exactly one chat-scroll message listing status and help, with no turn triggered", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("help", ctx);

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload, opts] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean },
			{ triggerTurn?: boolean; deliverAs?: string },
		];
		expect(payload.customType).toBe("pi-session-recap:subcommand");
		expect(payload.display).toBe(true);
		expect(payload.content).toMatch(/\bstatus\b/);
		expect(payload.content).toMatch(/\bhelp\b/);
		expect(opts.triggerTurn).toBe(false);
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
		// Mention valid subcommands so the user has a next step.
		expect(body).toMatch(/\bstatus\b/);
		expect(body).toMatch(/\bhelp\b/);
	});

	it("normalises case and whitespace around the subcommand token", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await getHandler(pi)("  STATUS  ", ctx);

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [, opts] = pi.sendMessage.mock.calls[0] as [
			unknown,
			{ triggerTurn?: boolean },
		];
		expect(opts.triggerTurn).toBe(false);
	});
});

