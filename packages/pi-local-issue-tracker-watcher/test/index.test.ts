import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createExtension, {
	POLL_INTERVAL_MS,
	handleSessionStart,
	resolveDbRoot,
} from "../src/index.js";
import { RUNSTATE_ENTRY_TYPE, STATE_ENTRY_TYPE } from "../src/persistence.js";
import type { Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * A minimal `ExtensionAPI` stub. We only need the handful of methods the
 * extension actually calls so we can assert the interactions.
 */
interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	/** The `session_start` handler registered by the extension (captured for tests). */
	readonly sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;
	/** Map of commandName → registered handler (from registerCommand calls). */
	readonly commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }>;
}

function makeFakePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }>();

	const on = vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
		handlers.set(event, fn);
	});
	const registerCommand = vi.fn((name: string, def: { description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }) => {
		commands.set(name, def);
	});
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();

	return {
		on,
		registerCommand,
		sendMessage,
		appendEntry,
		get sessionStartHandler() {
			return handlers.get("session_start");
		},
		commands,
	};
}

/**
 * Minimal `ctx` the `session_start` handler is called with. We stub the few
 * pieces our code actually touches (`ui.notify`, `sessionManager.getEntries`).
 */
interface StubCtx {
	ui: {
		notify: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
		theme: {
			fg: ReturnType<typeof vi.fn>;
			bold: ReturnType<typeof vi.fn>;
		};
		hasUI: boolean;
	};
	hasUI: boolean;
	sessionManager: {
		getEntries: () => Array<{ type?: string; customType?: string; data?: unknown }>;
	};
	cwd: string;
}

function makeFakeCtx(entries: Array<{ type?: string; customType?: string; data?: unknown }> = []): StubCtx {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			// Minimal Theme stub — real pi ships a full Theme object on ctx.ui.theme.
			theme: {
				fg: vi.fn((_color: string, text: string) => `<fg:${_color}>${text}</fg>`),
				bold: vi.fn((text: string) => `<b>${text}</b>`),
			},
			hasUI: true,
		},
		hasUI: true,
		sessionManager: { getEntries: () => entries },
		cwd: "/tmp",
	};
}

/**
 * Build a `{ paused: false }` runstate entry for tests that need the watcher
 * in its explicit 'running' state. Since #0012, a fresh session with no
 * runstate entry defaults to PAUSED, so most tests that exercise active
 * behaviour (diff emit, startup chat, polling) need to seed this.
 */
function runningRunstate(): { type: string; customType: string; data: { savedAt: number; paused: boolean } } {
	return {
		type: "custom",
		customType: "issue-watcher-runstate",
		data: { savedAt: Date.now(), paused: false },
	};
}

// ---------------------------------------------------------------------------
// Registration — what the default export wires up on `pi`
// ---------------------------------------------------------------------------

describe("POLL_INTERVAL_MS", () => {
	it("is 60 seconds", () => {
		expect(POLL_INTERVAL_MS).toBe(60_000);
	});
});

describe("default export — wiring", () => {
	it("subscribes to session_start and registers the /issue-watcher command", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"issue-watcher",
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
			}),
		);
	});
});

describe("resolveDbRoot", () => {
	it("reads LOCAL_ISSUE_TRACKER_DB_ROOT from env when set", () => {
		expect(
			resolveDbRoot({ LOCAL_ISSUE_TRACKER_DB_ROOT: "/some/db" }, "/home/u"),
		).toBe("/some/db");
	});

	it("falls back to the default path under home when the env var is absent", () => {
		const out = resolveDbRoot({}, "/home/u");
		expect(out).toContain("/home/u");
		expect(out).toMatch(/local-skill-issues-tracker/);
	});

	it("treats empty LOCAL_ISSUE_TRACKER_DB_ROOT as unset", () => {
		const out = resolveDbRoot({ LOCAL_ISSUE_TRACKER_DB_ROOT: "" }, "/home/u");
		expect(out).toContain("/home/u");
	});

	it("does NOT read the legacy PI_ISSUE_WATCHER_DB_ROOT name", () => {
		// Guardrail against the old name leaking back in.
		const out = resolveDbRoot(
			{ PI_ISSUE_WATCHER_DB_ROOT: "/should/not/be/used" },
			"/home/u",
		);
		expect(out).not.toBe("/should/not/be/used");
	});
});

// ---------------------------------------------------------------------------
// handleSessionStart — the core, testable lifecycle unit
// ---------------------------------------------------------------------------

describe("handleSessionStart", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-idx-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	function writeIssue(skill: string, fname: string, body: Record<string, unknown>): string {
		const skillDir = join(dbRoot, skill);
		mkdirSync(skillDir, { recursive: true });
		const p = join(skillDir, fname);
		writeFileSync(p, JSON.stringify(body), "utf8");
		return p;
	}

	it("notifies 'db root not found' and does not poll when dbRoot does not exist", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		const missing = join(dbRoot, "does-not-exist");

		const out = await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot: missing,
		});

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("issue-watcher"),
			expect.any(String),
		);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(out.started).toBe(false);
	});

	it("first-time start (no baseline) saves current snapshot and emits no chat message", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", title: "t", skill: "skill-a" });

		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]); // no baseline; explicit running

		const out = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// appendEntry was called with STATE_ENTRY_TYPE and a snapshot containing our issue.
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		const [entryType, payload] = pi.appendEntry.mock.calls[0] as [string, { savedAt: number; snapshot: Snapshot }];
		expect(entryType).toBe(STATE_ENTRY_TYPE);
		expect(Object.keys(payload.snapshot)).toHaveLength(1);
		expect(typeof payload.savedAt).toBe("number");

		// No diff message delivered — nothing to report yet. (Since #0011, a
		// chat-visible startup summary is also emitted with triggerTurn:false;
		// that is tested separately in the 'startup chat message' block.)
		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		);
		expect(diffCalls).toHaveLength(0);
		expect(out.started).toBe(true);

		// Startup announcement emitted via ui.setStatus (pins to extension-status row),
		// not via sendMessage (no agent turn).
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const issueStatus = statusCalls.find(([k]) => k === "issue-watcher");
		expect(issueStatus).toBeDefined();
		expect(issueStatus![1]).toContain("active");
		expect(issueStatus![1]).toContain(dbRoot);
		expect(issueStatus![1]).toContain("1 open");
	});

	it("with a fresh persisted baseline and new changes: emits sendMessage with triggerTurn and updates baseline", async () => {
		// Baseline: one issue open.
		const filePath = writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "open",
			title: "t",
			skill: "skill-a",
		});
		// Baseline snapshot saved "fresh" (savedAt = now) but with a *different*
		// mtime than what's on disk so the diff fires.
		const baselineSnapshot: Snapshot = {
			[filePath]: {
				mtimeNs: 1n, // arbitrary — different from real fs mtime
				issueId: "0001",
				status: "open",
				title: "t",
				description: "",
				comments: [],
				skill: "skill-a",
				skillVersion: "",
			},
		};
		// Now write an *updated* version of the same file (status transition).
		writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "done",
			title: "t",
			skill: "skill-a",
		});

		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			runningRunstate(),
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), snapshot: baselineSnapshot },
			},
		]);

		const out = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload, opts] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean; details?: unknown },
			{ triggerTurn?: boolean; deliverAs?: string },
		];
		expect(payload.customType).toBe("issue-watcher");
		expect(payload.display).toBe(true);
		expect(payload.content).toMatch(/issue update/);
		expect(payload.content).toMatch(/status changed/);
		expect(opts).toMatchObject({ triggerTurn: true });

		// New baseline persisted.
		expect(pi.appendEntry).toHaveBeenCalledWith(
			STATE_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number), snapshot: expect.any(Object) }),
		);
		expect(out.started).toBe(true);
	});

	it("with a fresh baseline but no real changes: no sendMessage, no re-persist", async () => {
		const filePath = writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "open",
			title: "t",
			skill: "skill-a",
		});

		// Import the scanner to get the actual on-disk snapshot for the baseline.
		const { scanIssueFiles } = await import("../src/scanner.js");
		const snap = scanIssueFiles(dbRoot);
		expect(snap[filePath]).toBeDefined();

		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			runningRunstate(),
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				// serialise bigint -> string so rehydrate has to convert back
				data: {
					savedAt: Date.now(),
					snapshot: { [filePath]: { ...snap[filePath]!, mtimeNs: String(snap[filePath]!.mtimeNs) } },
				},
			},
		]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// Since #0011, the watcher emits a chat-visible startup summary on every
		// session_start (when not paused and dbRoot exists). The 'no real
		// changes' assertion is now about the DIFF path not firing.
		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		);
		expect(diffCalls).toHaveLength(0);
		expect(pi.appendEntry).not.toHaveBeenCalled();

		// Startup announcement still fires even when there are no changes,
		// so the user can see the watcher is active (issue #0001).
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const issueStatus = statusCalls.find(([k]) => k === "issue-watcher");
		expect(issueStatus).toBeDefined();
		expect(issueStatus![1]).toContain("active");
		expect(issueStatus![1]).toContain(dbRoot);
	});

	it("missing-dbRoot path pins a 'dbRoot missing' status line with the resolved path (issue #0014)", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		const missing = join(dbRoot, "does-not-exist");

		const out = await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot: missing,
		});

		// Existing warning notify path unchanged.
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => m.includes("not found"))).toBe(true);

		// The pinned status row now surfaces the misconfiguration so it stays
		// visible beyond the transient toast (#0014).
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pinned = statusCalls
			.filter(([k]) => k === "issue-watcher")
			.map(([, v]) => v ?? "");
		expect(pinned).toHaveLength(1);
		expect(pinned[0]).toContain("dbRoot missing");
		expect(pinned[0]).toContain(missing);

		// Watcher still short-circuits: no scan, no polling, no chat messages.
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(out.started).toBe(false);
	});

	it("pinned status line is emitted via ctx.ui.setStatus (#0009, #0011)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// The pinned status row is always set (#0009). The chat-visible startup
		// summary (#0011, reversed in #0013) goes through pi.sendMessage and
		// DOES trigger an agent turn so the LLM sees the tracker state at
		// session start — that is asserted separately in the #0011/#0013 block.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		expect(statusCalls.some(([k]) => k === "issue-watcher")).toBe(true);
	});

	// -- issue #0001 (H1): no double-scan on session_start --
	it("returns the snapshot it scanned so the caller can reuse it without rescanning (issue #0001)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([]);

		const out = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		expect(out.started).toBe(true);
		expect(out.snapshot).toBeDefined();
		// Exactly the file we wrote should be in the returned snapshot.
		const keys = Object.keys(out.snapshot ?? {});
		expect(keys).toHaveLength(1);
		expect(keys[0]).toContain("0001-a.json");
	});

	it("returns an empty snapshot when dbRoot is missing (issue #0001)", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		const missing = join(dbRoot, "does-not-exist");
		const out = await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot: missing,
		});
		expect(out.started).toBe(false);
		expect(out.snapshot).toEqual({});
	});

	// -- issue #0004 (S1): ctx.ui guards for headless mode --
	it("when ctx has no ui at all, still persists baseline and returns started=true (issue #0004)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx: unknown = {
			// No `ui`. This mirrors pi's print/RPC mode where ctx.hasUI === false.
			hasUI: false,
			sessionManager: { getEntries: () => [] },
		};
		const out = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		expect(out.started).toBe(true);
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("when ctx.hasUI is false, does not call ui.setStatus or ui.notify (issue #0004)", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		ctx.hasUI = false;
		ctx.ui.hasUI = false;

		const missing = join(dbRoot, "does-not-exist");
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot: missing });

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
	});

	// -- issue #0005 (S2): theme-aware status line --
	it("uses ctx.ui.theme.fg('accent', ...) for the pinned status line; no hard-coded ANSI (issue #0005)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// theme.fg('accent', ...) was called with the announcement string.
		const fgCalls = ctx.ui.theme.fg.mock.calls as Array<[string, string]>;
		const accentCall = fgCalls.find(([c]) => c === "accent");
		expect(accentCall).toBeDefined();
		expect(accentCall![1]).toContain("active");
		expect(accentCall![1]).toContain(dbRoot);

		// The pinned status text is the theme-wrapped output, not a raw ANSI escape.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const issueStatus = statusCalls.find(([k]) => k === "issue-watcher");
		expect(issueStatus![1]).not.toMatch(/\x1b\[36m/);
		expect(issueStatus![1]).toContain("<fg:accent>");
	});
});

// ---------------------------------------------------------------------------
// /issue-watcher command
// ---------------------------------------------------------------------------

describe("/issue-watcher command", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-cmd-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	function extensionWithDbRoot(pi: StubPi, root: string): void {
		// Force the dbRoot resolution to `root` regardless of env.
		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = root;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}
	}

	it("'pause' notifies the user and marks paused=true", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const cmd = pi.commands.get("issue-watcher");
		expect(cmd).toBeDefined();
		const ctx = makeFakeCtx();
		await cmd!.handler("pause", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringMatching(/paused/i),
			expect.any(String),
		);
	});

	it("'resume' notifies the user and marks paused=false", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const cmd = pi.commands.get("issue-watcher");
		const ctx = makeFakeCtx();
		// pause first, then resume
		await cmd!.handler("pause", ctx);
		await cmd!.handler("resume", ctx);

		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /resumed/i.test(m))).toBe(true);

		// Resume also updates the pinned status line to mirror session_start.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const resumedStatus = statusCalls
			.filter(([k]) => k === "issue-watcher")
			.map(([, v]) => v ?? "")
			.find((v) => /resumed/i.test(v));
		expect(resumedStatus).toBeDefined();
		expect(resumedStatus!).toContain(dbRoot);
		expect(resumedStatus!).toContain("poll=");
	});

	it("'pause' updates the pinned status line to show paused state", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const cmd = pi.commands.get("issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("pause", ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pausedStatus = statusCalls
			.filter(([k]) => k === "issue-watcher")
			.map(([, v]) => v ?? "")
			.find((v) => /paused/i.test(v));
		expect(pausedStatus).toBeDefined();
		expect(pausedStatus!).toContain(dbRoot);
	});

	// -- issue #0010: paused status line drops per-status counts --
	it("'pause' pinned line contains no per-status counts (issue #0010)", async () => {
		// Seed some issue files so a scan would actually produce a non-empty
		// count; the test proves the counts are still excluded.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", skill: "skill-a" }),
		);
		writeFileSync(
			join(dbRoot, "skill-a", "0002-b.json"),
			JSON.stringify({ id: "0002", status: "done", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("pause", ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pausedStatus = statusCalls
			.filter(([k]) => k === "issue-watcher")
			.map(([, v]) => v ?? "")
			.find((v) => /paused/i.test(v));
		expect(pausedStatus).toBeDefined();
		// No '1 open' / '1 done' / any other count-shape segment.
		expect(pausedStatus!).not.toMatch(/\d+ open/);
		expect(pausedStatus!).not.toMatch(/\d+ done/);
		expect(pausedStatus!).not.toMatch(/\d+ in_progress/);
	});

	it("with no args prints a status line that mentions the dbRoot", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const cmd = pi.commands.get("issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("", ctx);

		const lastMessage = ctx.ui.notify.mock.calls.map((c) => String(c[0])).join("\n");
		expect(lastMessage).toContain(dbRoot);
	});

	it("warns on an unknown subcommand", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("frobnicate", ctx);

		const [msg, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(msg).toMatch(/unknown subcommand/i);
		expect(level).toBe("warning");
	});

	it("'status' subcommand behaves like empty args", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("status", ctx);

		expect(ctx.ui.notify).toHaveBeenCalled();
		const msg = String(ctx.ui.notify.mock.calls[0]?.[0] ?? "");
		expect(msg).toContain(dbRoot);
	});
});

// ---------------------------------------------------------------------------
// Polling loop / session_shutdown
// ---------------------------------------------------------------------------

describe("polling lifecycle", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-poll-"));
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dbRoot, { recursive: true, force: true });
	});

	function writeIssue(skill: string, fname: string, body: Record<string, unknown>): string {
		const skillDir = join(dbRoot, skill);
		mkdirSync(skillDir, { recursive: true });
		const p = join(skillDir, fname);
		writeFileSync(p, JSON.stringify(body), "utf8");
		return p;
	}

	it("emits sendMessage for changes detected by the poll interval", async () => {
		const filePath = writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "open",
			title: "t",
			skill: "skill-a",
		});

		const pi = makeFakePi();
		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = dbRoot;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}

		const handler = pi.sessionStartHandler!;
		const ctx = makeFakeCtx([runningRunstate()]); // first session: saves baseline, no diff
		await handler({}, ctx);

		// Fresh session emits the #0011 startup summary (with triggerTurn:false)
		// but no diff message yet.
		const diffCallsBefore = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		);
		expect(diffCallsBefore).toHaveLength(0);

		// Mutate the file so the next poll produces a status_changed diff. We
		// set a later mtime explicitly so the scanner sees the change regardless
		// of filesystem timestamp resolution.
		writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "done",
			title: "t",
			skill: "skill-a",
		});
		const future = new Date(Date.now() + 60_000);
		const { utimesSync } = await import("node:fs");
		utimesSync(filePath, future, future);

		// Advance past the poll interval and let the microtask queue drain.
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

		const diffCallsAfter = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("status changed"),
		);
		expect(diffCallsAfter).toHaveLength(1);
		const [payload, opts] = diffCallsAfter[0] as [
			{ customType: string; content: string },
			{ triggerTurn?: boolean },
		];
		expect(payload.customType).toBe("issue-watcher");
		expect(payload.content).toMatch(/status changed/);
		expect(opts.triggerTurn).toBe(true);
	});

	it("session_shutdown stops the poll timer", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });

		const pi = makeFakePi();
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		pi.on.mockImplementation((event: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(event, fn);
		});

		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = dbRoot;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}

		const sessionStart = handlers.get("session_start")!;
		const sessionShutdown = handlers.get("session_shutdown")!;
		expect(sessionStart).toBeDefined();
		expect(sessionShutdown).toBeDefined();

		await sessionStart({}, makeFakeCtx([]));
		const diffsBefore = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		).length;
		// shutdown should not throw and should leave the runtime in a clean state.
		await sessionShutdown({}, makeFakeCtx([]));

		// Advance past one poll interval; because shutdown stopped the timer, no
		// DIFF message fires even if we modify the file. (The #0011 startup
		// summary may have been sent during session_start above; we care here
		// about diffs not firing post-shutdown.)
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		const diffsAfter = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		).length;
		expect(diffsAfter).toBe(diffsBefore);
	});

	// -- issue #0003 (H3): poll catching a mid-write parse failure emits no diff --
	it("poll catching a file mid-write (transient parse error) emits no spurious diff (issue #0003)", async () => {
		const filePath = writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "open",
			title: "t",
			skill: "skill-a",
		});

		const pi = makeFakePi();
		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = dbRoot;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}

		const handler = pi.sessionStartHandler!;
		const ctx = makeFakeCtx([runningRunstate()]);
		await handler({}, ctx);
		const diffsAfterStartup = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		).length;
		expect(diffsAfterStartup).toBe(0);

		// Simulate a mid-write catch: overwrite the file with invalid JSON.
		writeFileSync(filePath, "{ incomplete", "utf8");
		const { utimesSync } = await import("node:fs");
		const future = new Date(Date.now() + 60_000);
		utimesSync(filePath, future, future);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		warn.mockRestore();

		// No spurious `removed` message was sent — carry-forward kept the entry.
		const diffsAfterMidwrite = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		).length;
		expect(diffsAfterMidwrite).toBe(0);

		// Now the writer finishes — legitimate status change lands on disk.
		writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "done",
			title: "t",
			skill: "skill-a",
		});
		const future2 = new Date(Date.now() + 120_000);
		utimesSync(filePath, future2, future2);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

		// Exactly ONE diff message, with a status_changed diff from the carried-forward
		// baseline — not a spurious `new` pair.
		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("issue update"),
		);
		expect(diffCalls).toHaveLength(1);
		const [payload] = diffCalls[0] as [
			{ content: string; details?: { changes?: Array<{ kind: string }> } },
		];
		expect(payload.content).toMatch(/status changed/);
		expect(payload.content).not.toMatch(/new issue/);
	});
});

// ---------------------------------------------------------------------------
// Run-state persistence (issue "paused/running survives reload")
// ---------------------------------------------------------------------------

describe("run-state persistence", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-rs-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	function writeIssue(skill: string, fname: string, body: Record<string, unknown>): void {
		const skillDir = join(dbRoot, skill);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, fname), JSON.stringify(body), "utf8");
	}

	function extensionWithDbRoot(pi: StubPi, root: string): void {
		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = root;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}
	}

	// -- handleSessionStart returns the rehydrated paused flag ---------------

	it("handleSessionStart defaults paused=true when no run-state entry exists (issue #0012)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([]);
		const res = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		expect(res.started).toBe(true);
		expect(res.paused).toBe(true);
	});

	it("fresh session (no runstate, no baseline) pins 'paused' and emits no startup chat message (issue #0012)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// No chat message of any kind — paused watcher must stay silent.
		expect(pi.sendMessage).not.toHaveBeenCalled();

		// Pinned status line says 'paused', not 'active'.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pinned = statusCalls.find(([k]) => k === "issue-watcher")?.[1] ?? "";
		expect(pinned).toContain("paused");
		expect(pinned).not.toMatch(/\bactive\b/);
	});

	it("handleSessionStart returns paused=false when the newest run-state entry is explicitly running (issue #0012)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: RUNSTATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: false },
			},
		]);
		const res = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		expect(res.paused).toBe(false);
	});

	it("handleSessionStart returns paused=true when the newest run-state entry is paused", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: RUNSTATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: true },
			},
		]);
		const res = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		expect(res.started).toBe(true);
		expect(res.paused).toBe(true);
	});

	it("handleSessionStart announces 'paused' in the status line when rehydrated as paused", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: RUNSTATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: true },
			},
		]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pinned = statusCalls.find(([k]) => k === "issue-watcher")?.[1] ?? "";
		expect(pinned).toContain("paused");
		expect(pinned).not.toMatch(/\bactive\b/);
	});

	it("handleSessionStart does NOT replay diffs when rehydrated as paused", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
		const pi = makeFakePi();
		const stalePathKey = join(dbRoot, "skill-a", "0001-a.json");
		const ctx = makeFakeCtx([
			// A fresh baseline with status=open; disk now has status=done.
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					savedAt: Date.now(),
					snapshot: {
						[stalePathKey]: {
							mtimeNs: "1",
							issueId: "0001",
							status: "open",
							title: "",
							description: "",
							comments: [],
							skill: "skill-a",
							skillVersion: "",
						},
					},
				},
			},
			{
				type: "custom",
				customType: RUNSTATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: true },
			},
		]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		// Paused means: no chat message, no re-persisting the baseline.
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	// -- session_start wiring honours the paused flag ------------------------

	it("session_start does NOT start polling when the rehydrated run-state is paused", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		vi.useFakeTimers();
		try {
			const pi = makeFakePi();
			extensionWithDbRoot(pi, dbRoot);
			const ctx = makeFakeCtx([
				{
					type: "custom",
					customType: RUNSTATE_ENTRY_TYPE,
					data: { savedAt: Date.now(), paused: true },
				},
			]);
			await pi.sessionStartHandler!({}, ctx);
			// Mutate disk; a running poll would flag the change.
			writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
			expect(pi.sendMessage).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("session_start DOES start polling when the rehydrated run-state is running", async () => {
		const filePath = join(dbRoot, "skill-a", "0001-a.json");
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		vi.useFakeTimers();
		try {
			const pi = makeFakePi();
			extensionWithDbRoot(pi, dbRoot);
			const ctx = makeFakeCtx([
				{
					type: "custom",
					customType: RUNSTATE_ENTRY_TYPE,
					data: { savedAt: Date.now(), paused: false },
				},
			]);
			await pi.sessionStartHandler!({}, ctx);
			// Mutate disk with a bumped mtime so the scanner sees a change.
			writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
			const { utimesSync } = await import("node:fs");
			const future = new Date(Date.now() + 60_000);
			utimesSync(filePath, future, future);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			const diffCalls = pi.sendMessage.mock.calls.filter(
				(c) => (c[0] as { content: string }).content.includes("issue update"),
			);
			expect(diffCalls).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	// -- /issue-watcher pause|resume persist run-state -----------------------

	it("'/issue-watcher pause' appends a RUNSTATE_ENTRY_TYPE entry with paused=true", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		await pi.commands.get("issue-watcher")!.handler("pause", makeFakeCtx());
		const runStateCalls = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === RUNSTATE_ENTRY_TYPE,
		);
		expect(runStateCalls.length).toBeGreaterThanOrEqual(1);
		const lastPayload = runStateCalls[runStateCalls.length - 1]![1] as {
			savedAt: number;
			paused: boolean;
		};
		expect(lastPayload.paused).toBe(true);
		expect(typeof lastPayload.savedAt).toBe("number");
	});

	it("'/issue-watcher resume' appends a RUNSTATE_ENTRY_TYPE entry with paused=false", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		await pi.commands.get("issue-watcher")!.handler("pause", makeFakeCtx());
		await pi.commands.get("issue-watcher")!.handler("resume", makeFakeCtx());
		const runStateCalls = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === RUNSTATE_ENTRY_TYPE,
		);
		expect(runStateCalls.length).toBeGreaterThanOrEqual(2);
		const lastPayload = runStateCalls[runStateCalls.length - 1]![1] as {
			savedAt: number;
			paused: boolean;
		};
		expect(lastPayload.paused).toBe(false);
	});

	it("pause -> simulated reload -> session_start rehydrates as paused and stays quiet", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });

		// First extension instance — user runs /issue-watcher pause.
		const pi1 = makeFakePi();
		extensionWithDbRoot(pi1, dbRoot);
		await pi1.commands.get("issue-watcher")!.handler("pause", makeFakeCtx());
		const persistedEntries = pi1.appendEntry.mock.calls
			.filter((c) => c[0] === RUNSTATE_ENTRY_TYPE)
			.map(([t, d]) => ({
				type: "custom",
				customType: t as string,
				data: d,
			}));
		expect(persistedEntries.length).toBeGreaterThanOrEqual(1);

		// Simulate plugin reload: brand-new extension, brand-new runtime, but
		// the session log still carries the pause entry from pi1.
		vi.useFakeTimers();
		try {
			const pi2 = makeFakePi();
			extensionWithDbRoot(pi2, dbRoot);
			const ctx = makeFakeCtx(persistedEntries);
			await pi2.sessionStartHandler!({}, ctx);

			// Reloaded extension honours the paused flag: no polling, so disk
			// mutations do not produce chat messages.
			writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
			expect(pi2.sendMessage).not.toHaveBeenCalled();

			// The pinned status line on the reloaded instance reflects paused.
			const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
			const pinned = statusCalls.find(([k]) => k === "issue-watcher")?.[1] ?? "";
			expect(pinned).toContain("paused");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("persistRunState resilience", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-resilience-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	it("'/issue-watcher pause' does not throw when pi.appendEntry itself throws", async () => {
		const pi = makeFakePi();
		// Force every appendEntry invocation to throw. The pause handler must
		// still complete and update the in-memory runtime.
		pi.appendEntry.mockImplementation(() => {
			throw new Error("simulated storage failure");
		});
		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = dbRoot;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}
		const ctx = makeFakeCtx();
		await expect(
			pi.commands.get("issue-watcher")!.handler("pause", ctx),
		).resolves.toBeUndefined();
		// User-visible notify still fires even though persistence failed.
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /paused/i.test(m))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// last-update timestamp in pinned status line (#0009)
// ---------------------------------------------------------------------------

describe("last-update timestamp (#0009)", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-lua-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	function writeIssue(skill: string, fname: string, body: Record<string, unknown>): string {
		const skillDir = join(dbRoot, skill);
		mkdirSync(skillDir, { recursive: true });
		const p = join(skillDir, fname);
		writeFileSync(p, JSON.stringify(body), "utf8");
		return p;
	}

	it("handleSessionStart: first session (no baseline) does NOT set lastUpdateAt", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		const [, payload] = pi.appendEntry.mock.calls[0] as [
			string,
			{ savedAt: number; lastUpdateAt?: number },
		];
		expect(payload.lastUpdateAt).toBeUndefined();

		// The pinned status line shows "last update: never" when the clock
		// segment is rendered.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pinned = statusCalls.find(([k]) => k === "issue-watcher")?.[1] ?? "";
		expect(pinned).toContain("last update: never");
	});

	it("handleSessionStart: bumps lastUpdateAt to now when a diff is emitted", async () => {
		const filePath = writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "open",
			skill: "skill-a",
		});
		const baselineSnapshot: Snapshot = {
			[filePath]: {
				mtimeNs: 1n,
				issueId: "0001",
				status: "open",
				title: "",
				description: "",
				comments: [],
				skill: "skill-a",
				skillVersion: "",
			},
		};
		writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "done",
			skill: "skill-a",
		});

		const pi = makeFakePi();
		const oldStamp = Date.now() - 10 * 60_000;
		const ctx = makeFakeCtx([
			runningRunstate(),
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), snapshot: baselineSnapshot, lastUpdateAt: oldStamp },
			},
		]);
		const before = Date.now();
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		const after = Date.now();

		// Last appendEntry call — may be preceded by the baseline-adopt path.
		const lastCall = pi.appendEntry.mock.calls.at(-1) as [
			string,
			{ lastUpdateAt?: number },
		];
		expect(lastCall[1].lastUpdateAt).toBeGreaterThanOrEqual(before);
		expect(lastCall[1].lastUpdateAt).toBeLessThanOrEqual(after);
	});

	it("handleSessionStart: preserves rehydrated lastUpdateAt when no changes observed", async () => {
		const filePath = writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "open",
			skill: "skill-a",
		});
		const { scanIssueFiles } = await import("../src/scanner.js");
		const snap = scanIssueFiles(dbRoot);
		const oldStamp = Date.now() - 2 * 60_000;
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					savedAt: Date.now(),
					snapshot: { [filePath]: { ...snap[filePath]!, mtimeNs: String(snap[filePath]!.mtimeNs) } },
					lastUpdateAt: oldStamp,
				},
			},
		]);
		const pi = makeFakePi();
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// No changes observed → no appendEntry call at all.
		expect(pi.appendEntry).not.toHaveBeenCalled();

		// The pinned status line picks up the rehydrated lastUpdateAt and
		// renders 'Nm ago' rather than 'never'.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pinned = statusCalls.find(([k]) => k === "issue-watcher")?.[1] ?? "";
		expect(pinned).toMatch(/last update: \dm ago/);
		expect(pinned).not.toContain("last update: never");
	});

	it("pollOnce refreshes the pinned status line every tick, even with no changes", async () => {
		vi.useFakeTimers();
		try {
			writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });

			const pi = makeFakePi();
			const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = dbRoot;
			try {
				createExtension(pi as never);
			} finally {
				if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
				else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
			}

			const handler = pi.sessionStartHandler!;
			const ctx = makeFakeCtx([runningRunstate()]);
			await handler({}, ctx);

			const statusAtStart = ctx.ui.setStatus.mock.calls.filter(
				([k]) => k === "issue-watcher",
			).length;

			// Advance through 3 poll cycles with no disk changes.
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

			const statusAfter = ctx.ui.setStatus.mock.calls.filter(
				([k]) => k === "issue-watcher",
			).length;

			// Each poll re-pins the status line so the age phrase can tick forward.
			expect(statusAfter).toBeGreaterThanOrEqual(statusAtStart + 3);
			// pollOnce does not emit chat messages when there are no diffs.
			const pollDiffs = pi.sendMessage.mock.calls.filter(
				(c) => (c[0] as { content: string }).content.includes("issue update"),
			);
			expect(pollDiffs).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Startup chat message (#0011)
// ---------------------------------------------------------------------------

describe("startup chat message (#0011)", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-start-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	function writeIssue(skill: string, fname: string, body: Record<string, unknown>): string {
		const skillDir = join(dbRoot, skill);
		mkdirSync(skillDir, { recursive: true });
		const p = join(skillDir, fname);
		writeFileSync(p, JSON.stringify(body), "utf8");
		return p;
	}

	it("emits one chat-visible startup message with customType='issue-watcher' and triggerTurn=true on fresh session (issue #0013)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		const startupCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "issue-watcher",
		);
		expect(startupCalls).toHaveLength(1);
		const [payload, opts] = startupCalls[0] as [
			{ customType: string; content: string; display?: boolean },
			{ triggerTurn?: boolean; deliverAs?: string },
		];
		expect(payload.content).toContain("active");
		expect(payload.content).toContain(dbRoot);
		expect(payload.content).toMatch(/\d+ open/);
		// #0013 reversed the original #0011 decision: the startup summary now
		// triggers an agent turn so the LLM sees the tracker state at session
		// start instead of waiting for the next user input.
		expect(opts.triggerTurn).toBe(true);
		expect(payload.display).toBe(true);
	});

	it("does NOT send a startup message when dbRoot is missing", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		const missing = join(dbRoot, "does-not-exist");

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot: missing });

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does NOT send a startup message when the rehydrated run-state is paused", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		// Seed the session log with a run-state entry that marks the watcher paused.
		const ctx = makeFakeCtx([
			{ type: "custom", customType: RUNSTATE_ENTRY_TYPE, data: { savedAt: Date.now(), paused: true } },
		]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("when a diff is emitted, does NOT pile a second startup message on top", async () => {
		const filePath = writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "open",
			skill: "skill-a",
		});
		const baselineSnapshot: Snapshot = {
			[filePath]: {
				mtimeNs: 1n,
				issueId: "0001",
				status: "open",
				title: "",
				description: "",
				comments: [],
				skill: "skill-a",
				skillVersion: "",
			},
		};
		writeIssue("skill-a", "0001-a.json", {
			id: "0001",
			status: "done",
			skill: "skill-a",
		});

		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			runningRunstate(),
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), snapshot: baselineSnapshot },
			},
		]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		const sent = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "issue-watcher",
		);
		// Exactly one: the diff message. No second startup-summary message on top.
		expect(sent).toHaveLength(1);
		const payload = sent[0]![0] as { content: string };
		expect(payload.content).toMatch(/issue update/);
		expect(payload.content).not.toContain("active | dbRoot=");
	});
});

// ---------------------------------------------------------------------------
// deferMessages — defer sendMessage so the TUI renders its bubble before
// the first LLM turn absorbs the content (#0015)
// ---------------------------------------------------------------------------

describe("handleSessionStart deferMessages (#0015)", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-defer-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	it("calls pi.sendMessage synchronously by default (existing tests unchanged)", async () => {
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", skill: "skill-a" }),
			"utf8",
		);
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("does NOT call pi.sendMessage synchronously when deferMessages=true", async () => {
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", skill: "skill-a" }),
			"utf8",
		);
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot,
			deferMessages: true,
		});
		expect(pi.sendMessage).not.toHaveBeenCalled();
		// After one setImmediate tick, the deferred send fires.
		await new Promise((resolve) => setImmediate(resolve));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload, opts] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean },
			{ triggerTurn?: boolean },
		];
		expect(payload.customType).toBe("issue-watcher");
		expect(payload.content).toContain("active");
		expect(opts.triggerTurn).toBe(true);
	});
});
