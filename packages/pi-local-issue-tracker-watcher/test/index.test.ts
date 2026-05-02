import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createExtension, {
	POLL_INTERVAL_MS,
	handleSessionStart,
	resolveDbRoot,
} from "../src/index.js";
import { STATE_ENTRY_TYPE } from "../src/persistence.js";
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
		const ctx = makeFakeCtx([]); // no prior state entries

		const out = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// appendEntry was called with STATE_ENTRY_TYPE and a snapshot containing our issue.
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		const [entryType, payload] = pi.appendEntry.mock.calls[0] as [string, { savedAt: number; snapshot: Snapshot }];
		expect(entryType).toBe(STATE_ENTRY_TYPE);
		expect(Object.keys(payload.snapshot)).toHaveLength(1);
		expect(typeof payload.savedAt).toBe("number");

		// No chat message delivered — nothing to report yet.
		expect(pi.sendMessage).not.toHaveBeenCalled();
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

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();

		// Startup announcement still fires even when there are no changes,
		// so the user can see the watcher is active (issue #0001).
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const issueStatus = statusCalls.find(([k]) => k === "issue-watcher");
		expect(issueStatus).toBeDefined();
		expect(issueStatus![1]).toContain("active");
		expect(issueStatus![1]).toContain(dbRoot);
	});

	it("missing-dbRoot path does NOT pin an 'active' status line", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		const missing = join(dbRoot, "does-not-exist");

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot: missing });

		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		// Existing warning path unchanged.
		expect(notifies.some((m) => m.includes("not found"))).toBe(true);

		// No status line pinned when the watcher bails out.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		expect(statusCalls.find(([k]) => k === "issue-watcher")).toBeUndefined();
	});

	it("startup announcement is emitted via ctx.ui.setStatus, NOT via pi.sendMessage (no triggerTurn)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// Announcement goes to the extension-status row, never to chat —
		// guarantees no agent turn is triggered by the startup message.
		const sendMessageTypes = pi.sendMessage.mock.calls.map(
			(c) => (c[0] as { customType?: string })?.customType,
		);
		expect(sendMessageTypes).not.toContain("issue-watcher");

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
		const ctx = makeFakeCtx([]);

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
		const ctx = makeFakeCtx([]); // first session: saves baseline, no diff
		await handler({}, ctx);

		// Baseline saved, no chat yet.
		expect(pi.sendMessage).not.toHaveBeenCalled();

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

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload, opts] = pi.sendMessage.mock.calls[0] as [
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
		// shutdown should not throw and should leave the runtime in a clean state.
		await sessionShutdown({}, makeFakeCtx([]));

		// Advance past one poll interval; because shutdown stopped the timer, no
		// sendMessage fires even if we modify the file.
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		expect(pi.sendMessage).not.toHaveBeenCalled();
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
		const ctx = makeFakeCtx([]);
		await handler({}, ctx);
		expect(pi.sendMessage).not.toHaveBeenCalled();

		// Simulate a mid-write catch: overwrite the file with invalid JSON.
		writeFileSync(filePath, "{ incomplete", "utf8");
		const { utimesSync } = await import("node:fs");
		const future = new Date(Date.now() + 60_000);
		utimesSync(filePath, future, future);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		warn.mockRestore();

		// No spurious `removed` message was sent — carry-forward kept the entry.
		expect(pi.sendMessage).not.toHaveBeenCalled();

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

		// Exactly ONE message, with a status_changed diff from the carried-forward
		// baseline — not a spurious `new` pair.
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload] = pi.sendMessage.mock.calls[0] as [
			{ content: string; details?: { changes?: Array<{ kind: string }> } },
		];
		expect(payload.content).toMatch(/status changed/);
		expect(payload.content).not.toMatch(/new issue/);
	});
});
