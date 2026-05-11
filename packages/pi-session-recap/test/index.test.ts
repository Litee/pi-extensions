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

import { Text } from "@mariozechner/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildStatusLine } from "../src/helpers.js";
import createExtension from "../src/index.js";

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
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

	it("surfaces all five flag values in `/recap status` when seeded under their bare registration names", async () => {
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

		const cmd = pi.commands.get("recap");
		expect(cmd).toBeDefined();
		const ctx = makeFakeCtx();
		await cmd!.handler("status", ctx);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		const body = payload.content;

		// Numeric flags flow through.
		expect(body).toContain("Idle trigger:   45s after turn_end");
		// --recap-disable-focus also wins over focus seconds — focus row
		// becomes `disabled`, the seconds value is intentionally ignored.
		expect(body).toContain("Focus trigger:  disabled");
		// Boolean flags.
		expect(body).toContain("Auto-recap:     disabled");
		// Both disabled flags are surfaced, in registration order.
		expect(body).toContain("Disabled flags: --recap-disable, --recap-disable-focus");
		// CLI override spec is seeded. It won't resolve (pi-ai registry has no
		// such model in-test), so we expect the override-failed-to-resolve
		// line rather than `(from --recap-model)` — but the spec string and
		// the source label must both be present.
		expect(body).toContain("anthropic/claude-haiku-4-5");
		// Either the success label or the fallback-active line references the
		// source, depending on whether the test environment's pi-ai registry
		// happens to contain that model id.
		expect(body).toMatch(/from --recap-model|override failed to resolve/);
	});

	it("surfaces `recap-focus-min-seconds` in the Focus trigger line when `recap-disable-focus` is false", async () => {
		const pi = makeFakePi({
			flagValues: {
				"recap-focus-min-seconds": "7",
				// recap-disable-focus deliberately omitted → defaults to false.
			},
		});
		createExtension(pi as never);

		const ctx = makeFakeCtx();
		await pi.commands.get("recap")!.handler("status", ctx);

		const [payload] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(payload.content).toContain("Focus trigger:  enabled (min 7s away)");
	});

	it("regression guard — `pi.getFlag` is never called with a `--`-prefixed key on session_start, /recap status, or /recap help", async () => {
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
		// session_start fires attachFocusReporting (reads recap-disable-focus)
		// and the isDisabled() short-circuit (reads recap-disable). Reason
		// "start" skips the resume branch so no generateAndShow / no pi-ai.
		await sessionStart!({ reason: "start" }, makeFakeCtx());

		const handler = pi.commands.get("recap")!.handler;
		// /recap status exercises all five registered flags via
		// resolveStatusOptions → configuredOverride / idleSeconds /
		// focusMinSeconds / isDisabled / isFocusDisabled.
		await handler("status", makeFakeCtx());
		// /recap help does not read flags today, but run it anyway so future
		// refactors that start reading flags there are caught.
		await handler("help", makeFakeCtx());

		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Chromeless renderer for `/recap status` and `/recap help` (#0008)
// ---------------------------------------------------------------------------
//
// Without a registered renderer, pi's default custom-message display stamps
// the literal `[pi-session-recap:subcommand]` routing key onto the
// transcript. These tests pin that:
//   1) a renderer IS registered for the subcommand customType,
//   2) that renderer's output never surfaces the customType string,
//   3) all content lines are preserved verbatim (no decoration / no reorder),
//   4) a round-trip from `/recap status` → sendMessage → renderer produces
//      output that starts with the `buildStatusLine` first line, not the
//      machine-readable routing key.

describe("/recap subcommand renderer (#0008)", () => {
	let agentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-renderer-"));
		prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	const fakeTheme = {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};

	// Wide enough that a single status/help line never wraps, so `render()`
	// returns one string per original newline-delimited line.
	const RENDER_WIDTH = 400;

	it("registers a message renderer for the `pi-session-recap:subcommand` customType", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		expect(pi.registerMessageRenderer).toHaveBeenCalled();
		const calls = pi.registerMessageRenderer.mock.calls as Array<[string, unknown]>;
		const subcommandCalls = calls.filter(([type]) => type === "pi-session-recap:subcommand");
		expect(subcommandCalls).toHaveLength(1);
		expect(pi.renderers.get("pi-session-recap:subcommand")).toBeTypeOf("function");
	});

	it("renderer output does not include the `pi-session-recap:subcommand` customType string", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const renderer = pi.renderers.get("pi-session-recap:subcommand");
		expect(renderer).toBeDefined();

		const result = renderer!(
			{ customType: "pi-session-recap:subcommand", content: "line 1\nline 2" },
			{ expanded: false },
			fakeTheme,
		);

		// The returned component is the chromeless Text container.
		expect(result).toBeInstanceOf(Text);

		// Render at a wide enough width that nothing wraps, then join and
		// assert the routing key is nowhere in the output.
		const rendered = (result as Text).render(RENDER_WIDTH).join("\n");
		expect(rendered.includes("pi-session-recap:subcommand")).toBe(false);
		expect(rendered.includes("[pi-session-recap:subcommand]")).toBe(false);
	});

	it("renderer preserves every content line verbatim and in order", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const renderer = pi.renderers.get("pi-session-recap:subcommand");
		expect(renderer).toBeDefined();

		const result = renderer!(
			{ customType: "pi-session-recap:subcommand", content: "a\nb\nc" },
			{ expanded: false },
			fakeTheme,
		);

		// Chromeless Text (paddingX=0, paddingY=0) at a wide width returns
		// exactly one output line per input line, with no header / footer.
		// `Text.render` right-pads each line to the full render width, so
		// trim trailing whitespace before comparing against the raw content.
		const lines = (result as Text).render(RENDER_WIDTH).map((l) => l.trimEnd());
		expect(lines).toEqual(["a", "b", "c"]);
	});

	it("round-trip: `/recap status` payload fed through the renderer starts with `recap status`, not the routing key", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		// Exercise the status subcommand to capture the sendMessage payload.
		const ctx = makeFakeCtx();
		await pi.commands.get("recap")!.handler("status", ctx);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean },
			unknown,
		];
		expect(payload.customType).toBe("pi-session-recap:subcommand");

		// Feed the captured payload through the registered renderer.
		const renderer = pi.renderers.get("pi-session-recap:subcommand");
		expect(renderer).toBeDefined();
		const result = renderer!(payload, { expanded: false }, fakeTheme);

		const rawLines = (result as Text).render(RENDER_WIDTH);
		const lines = rawLines.map((l) => l.trimEnd());
		const rendered = lines.join("\n");

		// Routing-key label must not appear anywhere in the rendered output.
		expect(rendered.includes("[pi-session-recap:subcommand]")).toBe(false);
		expect(rendered.includes("pi-session-recap:subcommand")).toBe(false);

		// Structure must match `buildStatusLine` for the seeded options:
		// first line is the human-readable header, model line is present.
		const expectedFirst = buildStatusLine({
			override: null,
			activeModelSpec: "anthropic/claude-sonnet-4-6",
			autoRecapEnabled: true,
			idleSeconds: 120,
			focusMinSeconds: 3,
			disabledFlags: [],
		}).split("\n")[0];
		expect(lines[0]).toBe(expectedFirst);
		expect(lines[0]).toBe("recap status");
		expect(rendered).toContain("Model:");
		expect(rendered).toContain("anthropic/claude-sonnet-4-6");
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
			createExtension(pi as any);

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

			// Advance past the default idle timeout (180 s)
			await vi.advanceTimersByTimeAsync(200_000);

			// The old orchestrator's timer must have been cleared — ctx1 was never accessed
			expect(ctx1.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
