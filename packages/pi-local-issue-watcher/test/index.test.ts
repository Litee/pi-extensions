import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createExtension, {
	POLL_INTERVAL_MS,
	__setInfoPickerForTests,
	buildMissingDbRootStatus,
	buildStartupChatMessage,
	buildStatusDetailMessage,
	handleSessionStart,
	resolveDbRoot,
	scanIssueFiles,
} from "../src/index.js";
import type { InfoPicker, InfoRow } from "../src/infoHandler.js";
import { RUNSTATE_ENTRY_TYPE, STATE_ENTRY_TYPE } from "../src/persistence.js";
import { abbreviatePath } from "../src/path.js";
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
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	/** The `session_start` handler registered by the extension (captured for tests). */
	readonly sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;
	/** Map of commandName → registered handler (from registerCommand calls). */
	readonly commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }>;
	/** Map of customType → registered renderer (from registerMessageRenderer calls). */
	readonly renderers: Map<
		string,
		(message: { customType: string; content: unknown; details?: unknown }, options: { expanded: boolean }, theme: unknown) => unknown
	>;
}

function makeFakePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }>();
	const renderers = new Map<
		string,
		(message: { customType: string; content: unknown; details?: unknown }, options: { expanded: boolean }, theme: unknown) => unknown
	>();

	const on = vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
		handlers.set(event, fn);
	});
	const registerCommand = vi.fn((name: string, def: { description: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> }) => {
		commands.set(name, def);
	});
	const registerMessageRenderer = vi.fn(
		(
			customType: string,
			renderer: (
				message: { customType: string; content: unknown; details?: unknown },
				options: { expanded: boolean },
				theme: unknown,
			) => unknown,
		) => {
			renderers.set(customType, renderer);
		},
	);
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();

	return {
		on,
		registerCommand,
		registerMessageRenderer,
		sendMessage,
		appendEntry,
		get sessionStartHandler() {
			return handlers.get("session_start");
		},
		commands,
		renderers,
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
		customType: "local-issue-watcher-runstate",
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
	it("subscribes to session_start and registers the /local-issue-watcher command", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"local-issue-watcher",
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
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-idx-"));
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
		// #0019: paused = silent + zero-IO, so the missing-dbRoot notify only
		// fires on the non-paused path. Seed a running runstate so we exercise it.
		const ctx = makeFakeCtx([runningRunstate()]);
		const missing = join(dbRoot, "does-not-exist");

		const out = await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot: missing,
		});

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("local-issue-watcher"),
			expect.any(String),
		);
		// A chat message with remediation steps IS now emitted.
		expect(pi.sendMessage).toHaveBeenCalledOnce();
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
		const issueStatus = statusCalls.find(([k]) => k === "pi-local-issue-watcher");
		expect(issueStatus).toBeDefined();
		expect(issueStatus![1]).toContain("active");
		expect(issueStatus![1]).not.toContain(abbreviatePath(dbRoot));
		expect(issueStatus![1]).not.toContain("poll=");
		expect(issueStatus![1]).toContain("1 open");
		expect(issueStatus![1]).not.toContain("total");
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
		expect(payload.customType).toBe("pi-local-issue-watcher");
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
		const issueStatus = statusCalls.find(([k]) => k === "pi-local-issue-watcher");
		expect(issueStatus).toBeDefined();
		expect(issueStatus![1]).toContain("active");
		expect(issueStatus![1]).not.toContain(abbreviatePath(dbRoot));
		expect(issueStatus![1]).not.toContain("poll=");
		expect(issueStatus![1]).not.toContain("total");
	});

	it("missing-dbRoot path pins a 'dbRoot missing' status line with the resolved path (issue #0014)", async () => {
		const pi = makeFakePi();
		// #0019: paused path skips existsSync/setStatus entirely, so the
		// 'dbRoot missing' pin is a non-paused-only behaviour. Seed running.
		const ctx = makeFakeCtx([runningRunstate()]);
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
			.filter(([k]) => k === "pi-local-issue-watcher")
			.map(([, v]) => v ?? "");
		expect(pinned).toHaveLength(1);
		expect(pinned[0]).toContain("dbRoot missing");
		expect(pinned[0]).toContain(abbreviatePath(missing));

		// Watcher still short-circuits: no scan, no polling.
		// A chat message IS emitted with remediation steps.
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(msg.content).toContain("dbRoot missing");
		expect(msg.content).toContain("mkdir");
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
		expect(statusCalls.some(([k]) => k === "pi-local-issue-watcher")).toBe(true);
	});

	// -- issue #0001 (H1): no double-scan on session_start --
	it("returns the snapshot it scanned so the caller can reuse it without rescanning (issue #0001)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		// #0019: paused branch returns baseline?.snapshot ?? {} without scanning.
		// This test proves the scan path populates the returned snapshot, so we
		// must exercise the running path.
		const ctx = makeFakeCtx([runningRunstate()]);

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
		// #0019: missing-dbRoot branch is non-paused-only. Seed running.
		const ctx = makeFakeCtx([runningRunstate()]);
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
			// #0019: paused branch skips the scan + appendEntry entirely. This
			// test covers the headless running path, so seed a running runstate.
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: "local-issue-watcher-runstate",
						data: { savedAt: Date.now(), paused: false },
					},
				],
			},
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
		expect(accentCall![1]).not.toContain(abbreviatePath(dbRoot));
		expect(accentCall![1]).not.toContain("poll=");
		expect(accentCall![1]).not.toContain("total");
		expect(accentCall![1]).toContain("open");

		// The pinned status text is the theme-wrapped output, not a raw ANSI escape.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const issueStatus = statusCalls.find(([k]) => k === "pi-local-issue-watcher");
		expect(issueStatus![1]).not.toMatch(/\x1b\[36m/);
		expect(issueStatus![1]).toContain("<fg:accent>");
	});
});

// ---------------------------------------------------------------------------
// /local-issue-watcher command
// ---------------------------------------------------------------------------

describe("/local-issue-watcher command", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-cmd-"));
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

		const cmd = pi.commands.get("local-issue-watcher");
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

		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		// pause first, then resume
		await cmd!.handler("pause", ctx);
		await cmd!.handler("resume", ctx);

		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /resumed/i.test(m))).toBe(true);

		// Resume also updates the pinned status line to mirror session_start.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const activeStatus = statusCalls
			.filter(([k]) => k === "pi-local-issue-watcher")
			.map(([, v]) => v ?? "")
			.find((v) => /active/i.test(v));
		expect(activeStatus).toBeDefined();
		// #0022: pinned status is just `<state> | <counts>` — no path,
		// no poll-period segment.
		expect(activeStatus!).not.toContain(abbreviatePath(dbRoot));
		expect(activeStatus!).not.toContain("poll=");
	});

	it("'pause' clears the pinned status row (#0019: paused = silent, no pinned row)", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("pause", ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const ourCalls = statusCalls.filter(([k]) => k === "pi-local-issue-watcher");
		// #0019: paused = no pinned row. Every setStatus call for our key
		// must be a clear (undefined) — no 'paused' string should be pinned.
		expect(ourCalls.length).toBeGreaterThanOrEqual(1);
		for (const [, v] of ourCalls) {
			expect(v).toBeUndefined();
		}
		// In particular the last setStatus for our key must be a clear.
		expect(ourCalls[ourCalls.length - 1]![1]).toBeUndefined();
	});

	// -- issue #0010 subsumed by #0019: paused line has no counts because
	// the row itself is cleared. Test kept so the #0010 guarantee is
	// explicitly preserved under the new behaviour.
	it("'pause' pinned line contains no per-status counts (issue #0010, reinforced by #0019)", async () => {
		// Seed some issue files so a scan would actually produce a non-empty
		// count; the test proves no count string is pinned.
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
		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("pause", ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		// #0019: paused = cleared row. No pinned string means no counts.
		const pinnedStrings = statusCalls
			.filter(([k]) => k === "pi-local-issue-watcher")
			.map(([, v]) => v)
			.filter((v): v is string => typeof v === "string");
		expect(pinnedStrings).toHaveLength(0);
	});

	it("'/local-issue-watcher' (empty args) sends the chat-message payload, not a toast (#0027)", async () => {
		// Seed one open issue so the snapshot payload is non-trivial.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("", ctx);

		// Regression guard for the `case "":` fallthrough into `case "status":`:
		// empty args must route through the same chat-message payload.
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean },
		];
		expect(payload.customType).toBe("pi-local-issue-watcher");
		expect(payload.content).toBe(buildStatusDetailMessage(dbRoot, scanIssueFiles(dbRoot)));
		expect(payload.display).toBe(true);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("warns on an unknown subcommand (mentions `browse` in the hint)", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("frobnicate", ctx);

		const [msg, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(msg).toMatch(/unknown subcommand/i);
		expect(msg).toMatch(/\bbrowse\b/);
		expect(level).toBe("warning");
	});

	it("'status' subcommand sends a chat message, not a toast (#0027)", async () => {
		// Seed one open issue so the chat-message payload is non-trivial and
		// we can byte-compare it against buildStartupChatMessage(dbRoot, snap).
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("status", ctx);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean },
		];
		expect(payload.customType).toBe("pi-local-issue-watcher");
		expect(payload.content).toBe(buildStatusDetailMessage(dbRoot, scanIssueFiles(dbRoot)));
		expect(payload.display).toBe(true);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("'status' renders immediately without triggering an agent turn (#0027, #0030)", async () => {
		// #0030: `deliverAs: "nextTurn"` buffers the chat message in
		// `_pendingNextTurnMessages` and does NOT emit `message_start` /
		// `message_end` until the user sends their next prompt — so the user
		// sees nothing after `/local-issue-watcher status` until they type
		// something unrelated. Agent-session's default branch
		// (`deliverAs` omitted, `triggerTurn` not truthy, agent idle) pushes
		// the message straight into `agent.state.messages` and emits the
		// render events synchronously, which renders immediately while still
		// costing zero LLM calls — same as `nextTurn` for the LLM context,
		// but visible now. See #0027 for the zero-LLM-call requirement.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("status", ctx);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [, opts] = pi.sendMessage.mock.calls[0] as [
			unknown,
			{ deliverAs?: string; triggerTurn?: boolean } | undefined,
		];
		expect(opts?.deliverAs).not.toBe("nextTurn");
		expect(opts?.triggerTurn).not.toBe(true);
	});

	it("'status' with missing dbRoot falls back to ui.notify warning and does NOT send a chat message (#0027)", async () => {
		const missing = join(
			tmpdir(),
			`pi-local-issue-watcher-missing-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
		);
		const pi = makeFakePi();
		extensionWithDbRoot(pi, missing);
		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		await cmd!.handler("status", ctx);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [body, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(body).toBe(buildMissingDbRootStatus(missing));
	});

	it("'status' on a paused watcher still scans and emits the chat message (#0027)", async () => {
		// #0019 constrains paused watchers to zero-IO on the AUTOMATIC
		// session_start scan path. An explicit user-invoked `/status` is a
		// different contract: the user is asking for a fresh snapshot, so
		// scanning + emitting the chat message is the expected behaviour here.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher");
		const ctx = makeFakeCtx();
		// Toggle the runtime into paused state via the public command.
		await cmd!.handler("pause", ctx);
		const notifyBefore = ctx.ui.notify.mock.calls.length;
		const runstateAppendsBefore = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === RUNSTATE_ENTRY_TYPE,
		).length;

		await cmd!.handler("status", ctx);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string },
		];
		expect(payload.customType).toBe("pi-local-issue-watcher");
		expect(payload.content).toBe(buildStatusDetailMessage(dbRoot, scanIssueFiles(dbRoot)));

		// `/status` must not toggle pause state or produce any additional
		// notify toasts beyond what pause/resume already emitted.
		expect(ctx.ui.notify.mock.calls.length).toBe(notifyBefore);
		const runstateAppendsAfter = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === RUNSTATE_ENTRY_TYPE,
		).length;
		expect(runstateAppendsAfter).toBe(runstateAppendsBefore);
	});
});

// ---------------------------------------------------------------------------
// Polling loop / session_shutdown
// ---------------------------------------------------------------------------

describe("polling lifecycle", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-poll-"));
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
		expect(payload.customType).toBe("pi-local-issue-watcher");
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
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-rs-"));
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

	it("fresh session (no runstate, no baseline) pins no status row and emits no startup chat (issue #0012, #0019)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// No chat message of any kind — paused watcher must stay silent.
		expect(pi.sendMessage).not.toHaveBeenCalled();

		// #0019: paused = no pinned row. Any setStatus call on our key must
		// be a clear (undefined), never a 'paused' string.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const ourCalls = statusCalls.filter(([k]) => k === "pi-local-issue-watcher");
		for (const [, v] of ourCalls) {
			expect(v).toBeUndefined();
		}
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

	it("handleSessionStart pins no status row when rehydrated as paused (#0019)", async () => {
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
		const ourCalls = statusCalls.filter(([k]) => k === "pi-local-issue-watcher");
		// #0019: paused = no pinned row. Every setStatus call on our key must
		// be a clear — never an 'active' or 'paused' string.
		for (const [, v] of ourCalls) {
			expect(v).toBeUndefined();
		}
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

	// -- /local-issue-watcher pause|resume persist run-state -----------------------

	it("'/local-issue-watcher pause' appends a RUNSTATE_ENTRY_TYPE entry with paused=true", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		await pi.commands.get("local-issue-watcher")!.handler("pause", makeFakeCtx());
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

	it("'/local-issue-watcher resume' appends a RUNSTATE_ENTRY_TYPE entry with paused=false", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		await pi.commands.get("local-issue-watcher")!.handler("pause", makeFakeCtx());
		await pi.commands.get("local-issue-watcher")!.handler("resume", makeFakeCtx());
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

		// First extension instance — user runs /local-issue-watcher pause.
		const pi1 = makeFakePi();
		extensionWithDbRoot(pi1, dbRoot);
		await pi1.commands.get("local-issue-watcher")!.handler("pause", makeFakeCtx());
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

			// The reloaded extension pins no status row because paused =
			// silent under #0019. Every setStatus call for our key must be
			// a clear, not a 'paused' string.
			const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
			const ourCalls = statusCalls.filter(([k]) => k === "pi-local-issue-watcher");
			for (const [, v] of ourCalls) {
				expect(v).toBeUndefined();
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("persistRunState resilience", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-resilience-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	it("'/local-issue-watcher pause' does not throw when pi.appendEntry itself throws", async () => {
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
			pi.commands.get("local-issue-watcher")!.handler("pause", ctx),
		).resolves.toBeUndefined();
		// User-visible notify still fires even though persistence failed.
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /paused/i.test(m))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// last-update timestamp in pinned status line (#0009)
// ---------------------------------------------------------------------------

describe("status line — refresh on every poll (#0016 supersedes #0009)", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-lua-"));
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

	it("handleSessionStart: pinned status line has no 'last update' segment (#0016)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const pinned = statusCalls.find(([k]) => k === "pi-local-issue-watcher")?.[1] ?? "";
		expect(pinned).not.toMatch(/last update/);
		expect(pinned).not.toMatch(/\b(never|just now|\ds ago|\dm ago|\dh ago|\dd ago)\b/);
	});

	it("appendEntry payload does not include lastUpdateAt, even when rehydrating an old entry that had one (#0016)", async () => {
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
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });

		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			runningRunstate(),
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				// Simulate a pre-#0016 payload: `lastUpdateAt` is present on read
				// but must be dropped from any fresh write.
				data: {
					savedAt: Date.now(),
					snapshot: baselineSnapshot,
					lastUpdateAt: Date.now() - 10 * 60_000,
				},
			},
		]);
		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		for (const [, payload] of pi.appendEntry.mock.calls as Array<[
			string,
			{ lastUpdateAt?: unknown },
		]>) {
			expect(payload).not.toHaveProperty("lastUpdateAt");
		}
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
				([k]) => k === "pi-local-issue-watcher",
			).length;

			// Advance through 3 poll cycles with no disk changes.
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

			const statusAfter = ctx.ui.setStatus.mock.calls.filter(
				([k]) => k === "pi-local-issue-watcher",
			).length;

			// Each poll re-pins the status line so the counts segment reflects
			// the latest rescan (#0016: the 'age' phrase that motivated this in
			// #0009 no longer exists; the repaint still happens so the segment
			// stays current).
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
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-start-"));
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

	it("emits one chat-visible startup message with customType='local-issue-watcher' and triggerTurn=true on fresh session (issue #0013)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		const startupCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "pi-local-issue-watcher",
		);
		expect(startupCalls).toHaveLength(1);
		const [payload, opts] = startupCalls[0] as [
			{ customType: string; content: string; display?: boolean },
			{ triggerTurn?: boolean; deliverAs?: string },
		];
		expect(payload.content).toContain("active");
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
			(c) => (c[0] as { customType?: string }).customType === "pi-local-issue-watcher",
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
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-defer-"));
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
		expect(payload.customType).toBe("pi-local-issue-watcher");
		expect(payload.content).toContain("active");
		expect(opts.triggerTurn).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// #0019: paused watcher = silent (no pinned row) + zero-IO (no fs calls)
// ---------------------------------------------------------------------------

describe("paused watcher = silent + zero-IO (#0019)", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-0019-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("session_start with paused runstate: no scanIssueFiles, no missing-dbRoot notify, no pinned row, no chat startup", async () => {
		// Proof strategy for zero-IO:
		//   * `scanIssueFiles` is spied on the scanner module namespace — if the
		//     paused branch called it we'd see a recorded invocation.
		//   * `existsSync` cannot be spied (node:fs exports are frozen), so we
		//     prove it was NOT called by pointing `dbRoot` at a path that does
		//     NOT exist: if the non-paused `existsSync(dbRoot)` branch ran, it
		//     would emit a 'dbRoot not found' notify and pin a misconfig row.
		//     Absence of both is the external symptom we assert against.
		const scannerModule = await import("../src/scanner.js");
		const scanSpy = vi.spyOn(scannerModule, "scanIssueFiles");

		const missing = join(dbRoot, "does-not-exist");

		const pi = makeFakePi();
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: RUNSTATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: true },
			},
		]);

		const res = await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot: missing,
		});

		// Zero-IO: the scanner was never called.
		expect(scanSpy).not.toHaveBeenCalled();

		// Zero-IO, part 2: if existsSync had run on a non-existent path we'd
		// hit the missing-dbRoot branch and emit a warning notify. Neither
		// happened, so existsSync was skipped.
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		// No chat-visible startup summary, no diff message.
		expect(pi.sendMessage).not.toHaveBeenCalled();

		// No pinned row. Any setStatus call for our key must be a clear
		// (undefined); a fresh paused session with a UI attached clears the
		// row defensively so stale content from a prior non-paused session
		// does not linger.
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const ourCalls = statusCalls.filter(([k]) => k === "pi-local-issue-watcher");
		for (const [, v] of ourCalls) {
			expect(v).toBeUndefined();
		}

		// Return shape: the caller can still rely on a snapshot baseline so
		// a later /local-issue-watcher resume diffs from the last known-good
		// state. With no baseline entry rehydrated the snapshot is {}.
		expect(res.paused).toBe(true);
		expect(res.started).toBe(true);
		expect(res.snapshot).toEqual({});
	});

	it("'/local-issue-watcher pause' clears the pinned status line but keeps the one-shot notify toast", async () => {
		const pi = makeFakePi();
		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = dbRoot;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}

		const ctx = makeFakeCtx([runningRunstate()]);
		// Kick off an active session so the running path pins a row first.
		await pi.sessionStartHandler!({}, ctx);
		const activePinCount = (ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>)
			.filter(([k, v]) => k === "pi-local-issue-watcher" && typeof v === "string")
			.length;
		expect(activePinCount).toBeGreaterThanOrEqual(1);

		const notifyCallsBefore = ctx.ui.notify.mock.calls.length;

		// Now invoke pause.
		await pi.commands.get("local-issue-watcher")!.handler("pause", ctx);

		// Last setStatus for our key must be a clear (undefined).
		const statusCalls = ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>;
		const ourCalls = statusCalls.filter(([k]) => k === "pi-local-issue-watcher");
		expect(ourCalls[ourCalls.length - 1]![1]).toBeUndefined();

		// One-shot notify still fires so the user knows the command worked.
		const notifyCallsAfter = ctx.ui.notify.mock.calls.length;
		expect(notifyCallsAfter).toBe(notifyCallsBefore + 1);
		const lastNotify = ctx.ui.notify.mock.calls[notifyCallsAfter - 1] as [string, string];
		expect(lastNotify[0]).toMatch(/paused/i);
		expect(lastNotify[0]).toContain(dbRoot);
	});

	it("'/local-issue-watcher resume' re-pins the status row (non-empty string, state 'active')", async () => {
		const pi = makeFakePi();
		const prev = process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
		process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = dbRoot;
		try {
			createExtension(pi as never);
		} finally {
			if (prev === undefined) delete process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
			else process.env["LOCAL_ISSUE_TRACKER_DB_ROOT"] = prev;
		}

		// Start from a paused session: no pinned row.
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: RUNSTATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: true },
			},
		]);
		await pi.sessionStartHandler!({}, ctx);
		const pausedPinStrings = (ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>)
			.filter(([k, v]) => k === "pi-local-issue-watcher" && typeof v === "string");
		expect(pausedPinStrings).toHaveLength(0);

		// Resume — the first setStatus write afterwards must repopulate the row.
		await pi.commands.get("local-issue-watcher")!.handler("resume", ctx);

		const afterResume = (ctx.ui.setStatus.mock.calls as Array<[string, string | undefined]>)
			.filter(([k]) => k === "pi-local-issue-watcher");
		const activePin = afterResume
			.map(([, v]) => v)
			.find((v) => typeof v === "string" && /active/i.test(v));
		expect(activePin).toBeDefined();
		expect(typeof activePin).toBe("string");
		expect((activePin as string).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// /local-issue-watcher browse subcommand (#0023 / renamed under #0025)
// ---------------------------------------------------------------------------

describe("/local-issue-watcher browse subcommand (#0025)", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-browse-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
		__setInfoPickerForTests(null);
	});

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

	it("does NOT register the legacy /local-issue-watcher-info command (#0025)", () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		expect(pi.commands.has("local-issue-watcher-info")).toBe(false);
		const registeredNames = pi.registerCommand.mock.calls.map((c) => c[0] as string);
		expect(registeredNames).not.toContain("local-issue-watcher-info");
	});

	it("dispatches 'browse' to handleInfo with the resolved dbRoot, live scanner, and an InfoPicker that receives open rows + summary", async () => {
		// Seed the dbRoot with one open + one done issue so the picker gets a
		// non-trivial payload.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "open one", skill: "skill-a" }),
		);
		writeFileSync(
			join(dbRoot, "skill-a", "0002-b.json"),
			JSON.stringify({ id: "0002", status: "done", title: "done one", skill: "skill-a" }),
		);

		const received: Array<{ rows: InfoRow[]; summary: string }> = [];
		const fakePicker: InfoPicker = async (args) => {
			received.push(args);
		};
		__setInfoPickerForTests(fakePicker);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();
		await pi.commands.get("local-issue-watcher")!.handler("browse", ctx);

		expect(received).toHaveLength(1);
		expect(received[0]!.rows).toHaveLength(1);
		expect(received[0]!.rows[0]!.info.issueId).toBe("0001");
		expect(received[0]!.summary).toBe("1 open, 2 total");
		// Happy path fires no notify — the TUI owns the UX from here.
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("'browse' emits a warning notify (and does NOT invoke the picker) when dbRoot is not configured", async () => {
		const pickerCalls: number[] = [];
		__setInfoPickerForTests(async () => {
			pickerCalls.push(1);
		});

		const missing = join(dbRoot, "does-not-exist");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, missing);
		const ctx = makeFakeCtx();
		await pi.commands.get("local-issue-watcher")!.handler("browse", ctx);

		expect(pickerCalls).toHaveLength(0);
		const calls = ctx.ui.notify.mock.calls as Array<[string, string]>;
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toMatch(/local-issue-watcher browse/);
		expect(calls[0]![0]).toContain(missing);
		expect(calls[0]![1]).toBe("warning");
	});
});

// ---------------------------------------------------------------------------
// Styled message renderer (#0028)
// ---------------------------------------------------------------------------
//
// Without a registered `pi.registerMessageRenderer`, pi's default display
// stamps the raw customType literal (e.g. `[pi-local-issue-watcher]`)
// onto the transcript. The fix registers a renderer that:
//   - Wraps output in a Box with the `customMessageBg` background so messages
//     are visually distinct.
//   - Adds "pi-local-issue-watcher" as a bold header line in the
//     `customMessageLabel` colour so the user can see which watcher fired.
//   - Suppresses the default `[customType]` bracket label pi would otherwise
//     prepend.
// This applies equally to session-start announcements, poll-cycle event
// updates, and /local-issue-watcher status output.

/** Minimal theme stub: strips all colour/bold ANSI so assertions work on plain text. */
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("/local-issue-watcher message renderer (#0028)", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-renderer-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

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

	/** Run a pi-tui Text component and collect its rendered lines (right-pad trimmed). */
	function renderText(component: unknown, width = 500): string[] {
		// pi-tui's `Text` component exposes `.render(width)` returning styled line
		// strings. We strip the right-pad whitespace so equality checks are stable.
		// Use a wide width so the renderer doesn't wrap/truncate long content
		// lines (e.g. paths in buildStartupChatMessage).
		const renderable = component as { render: (w: number) => string[] };
		return renderable.render(width).map((line) => line.trimEnd());
	}

	it("registers a renderer for the extension's CUSTOM_MESSAGE_TYPE during init", () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		// One registration, for the shared customType used by session-start and /status.
		expect(pi.registerMessageRenderer).toHaveBeenCalled();
		const calls = pi.registerMessageRenderer.mock.calls as Array<[string, unknown]>;
		expect(calls).toHaveLength(1);
		const [customType, renderer] = calls[0]!;
		expect(customType).toBe("pi-local-issue-watcher");
		expect(typeof renderer).toBe("function");
		expect(pi.renderers.get(customType)).toBe(renderer);
	});

	it("renderer output contains the extension name as header and content, without bracket wrapping", () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const [customType, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(
				message: { customType: string; content: string },
				options: { expanded: boolean },
				theme: typeof fakeTheme,
			) => unknown,
		];
		const result = renderer(
			{ customType, content: "line 1\nline 2" },
			{ expanded: false },
			fakeTheme,
		);
		const lines = renderText(result);
		const joined = lines.join("\n");

		// Extension name is shown without brackets.
		expect(joined).toContain(customType);
		expect(joined).not.toContain(`[${customType}]`);
		// Content still comes through.
		expect(joined).toContain("line 1");
		expect(joined).toContain("line 2");
	});

	it("renderer preserves all content lines in order", () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const [customType, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(
				message: { customType: string; content: string },
				options: { expanded: boolean },
				theme: typeof fakeTheme,
			) => unknown,
		];
		const result = renderer(
			{ customType, content: "ALPHA\nBETA\nGAMMA" },
			{ expanded: false },
			fakeTheme,
		);
		const lines = renderText(result);

		// Three content lines, in order. Extra padding/blank lines from the Box
		// and header label are OK as long as the markers appear in sequence.
		const indexA = lines.findIndex((l) => l.includes("ALPHA"));
		const indexB = lines.findIndex((l) => l.includes("BETA"));
		const indexC = lines.findIndex((l) => l.includes("GAMMA"));
		expect(indexA).toBeGreaterThanOrEqual(0);
		expect(indexB).toBeGreaterThan(indexA);
		expect(indexC).toBeGreaterThan(indexB);
	});

	it("/local-issue-watcher status round-trip: renderer shows the header label and content without the bracket label", async () => {
		// Seed a non-trivial snapshot so buildStartupChatMessage has content to render.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();

		await pi.commands.get("local-issue-watcher")!.handler("status", ctx);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string },
		];
		const [customType, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(
				message: { customType: string; content: string },
				options: { expanded: boolean },
				theme: typeof fakeTheme,
			) => unknown,
		];
		expect(payload.customType).toBe(customType);

		const rendered = renderText(renderer(payload, { expanded: false }, fakeTheme));
		const joined = rendered.join("\n");

		// Extension name shown without brackets.
		expect(joined).toContain(customType);
		expect(joined).not.toContain(`[${customType}]`);
		// Every non-blank content line appears in the rendered output
		// (Box paddingX=1 adds a leading space per line so the raw multi-line
		// string cannot be matched as a block).
		for (const line of payload.content.split("\n").filter((l) => l.trim())) {
			expect(joined).toContain(line);
		}
	});

	it("session-start round-trip: renderer shows the header label and content without the bracket label", async () => {
		// Running runstate + one issue => session_start may emit the #0011 startup chat.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx([runningRunstate()]);
		await pi.sessionStartHandler!({}, ctx);
		// session_start uses `deferMessages: true` — sendMessage calls emitted
		// during handleSessionStart are queued via setImmediate, not fired
		// synchronously. Flush the setImmediate queue before inspecting.
		await new Promise((resolve) => setImmediate(resolve));

		const [customType, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(
				message: { customType: string; content: string },
				options: { expanded: boolean },
				theme: typeof fakeTheme,
			) => unknown,
		];

		// Session_start emits at least one customType-tagged payload (the startup
		// chat). Every such payload must render with the header label present and
		// without the bracket form.
		const customTypedCalls = pi.sendMessage.mock.calls.filter((c) => {
			const msg = c[0] as { customType?: string };
			return msg.customType === customType;
		});
		expect(customTypedCalls.length).toBeGreaterThan(0);

		for (const [payload] of customTypedCalls as Array<[{ customType: string; content: string }]>) {
			const rendered = renderText(renderer(payload, { expanded: false }, fakeTheme));
			const joined = rendered.join("\n");
			expect(joined).toContain(customType);
			expect(joined).not.toContain(`[${customType}]`);
			for (const line of payload.content.split("\n").filter((l) => l.trim())) {
				expect(joined).toContain(line);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// #0029 — one-shot parse-failure toast invariants.
//
// These tests lock in the contract: across every scan site
// (`handleSessionStart`, the 60s poll loop, the `/status` command, and
// `resume`) a session must emit at most ONE `ui.notify(..., "warning")` for
// parse failures, the toast summary must be count-only (no paths), and
// UI-absent sessions must NOT burn the one-shot opportunity for a later
// UI-enabled session.
// ---------------------------------------------------------------------------

describe("one-shot parse-failure toast (#0029)", () => {
	let dbRoot: string;
	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-0029-"));
	});
	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

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

	/** Write one malformed JSON file to `dbRoot/<skill>/<name>`. */
	function writeBadIssue(skill: string, name: string, body = "{ not json"): string {
		const skillDir = join(dbRoot, skill);
		mkdirSync(skillDir, { recursive: true });
		const p = join(skillDir, name);
		writeFileSync(p, body, "utf8");
		return p;
	}

	/**
	 * Collect every `ui.notify` call whose level argument is exactly
	 * `"warning"` — the watcher uses `"info"` for many other user-facing
	 * lines (pause acknowledgement etc.) and those must not count against
	 * the one-shot toast budget.
	 */
	function warningNotifies(
		ctx: { ui: { notify: ReturnType<typeof vi.fn> } },
	): string[] {
		return ctx.ui.notify.mock.calls
			.filter((c) => c[1] === "warning")
			.map((c) => String(c[0]));
	}

	// -- session_start --

	it("session_start toasts exactly once when parse failures exist (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad-a.json");
		writeBadIssue("skill-b", "0002-bad-b.json");
		writeBadIssue("skill-b", "0003-bad-c.json");
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		const state = { hasToasted: false };
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot,
			parseFailureToastState: state,
		});

		const warnings = warningNotifies(ctx);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/3/);
		expect(state.hasToasted).toBe(true);
	});

	it("session_start toast summary is count-only and does not leak file or skill paths (#0029)", async () => {
		writeBadIssue("skill-with-a-very-distinctive-name-xyz", "0042-distinctive-slug-abc.json");
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot,
			parseFailureToastState: { hasToasted: false },
		});

		const warnings = warningNotifies(ctx);
		expect(warnings).toHaveLength(1);
		const body = warnings[0]!;
		expect(body).not.toContain("skill-with-a-very-distinctive-name-xyz");
		expect(body).not.toContain("0042-distinctive-slug-abc");
		expect(body).not.toContain(dbRoot);
		expect(body).toMatch(/1/);
	});

	it("session_start does not toast when there are no parse failures (#0029)", async () => {
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-ok.json"),
			JSON.stringify({ id: "0001", status: "open", skill: "skill-a" }),
			"utf8",
		);
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		const state = { hasToasted: false };
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot,
			parseFailureToastState: state,
		});

		expect(warningNotifies(ctx)).toHaveLength(0);
		expect(state.hasToasted).toBe(false);
	});

	it("session_start does NOT flip hasToasted when ctx has no UI (#0029)", async () => {
		// A session without UI (e.g. non-interactive mode) has no toast channel
		// and therefore must NOT burn the session's one-shot opportunity —
		// otherwise a later UI-enabled session reading the same dbRoot would
		// silently fail to warn the user about persistent bad files.
		writeBadIssue("skill-a", "0001-bad.json");
		const pi = makeFakePi();
		const ctx = {
			ui: undefined,
			hasUI: false,
			sessionManager: { getEntries: () => [runningRunstate() as never] },
			cwd: process.cwd(),
		} as unknown as StubCtx;
		const state = { hasToasted: false };
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot,
			parseFailureToastState: state,
		});

		expect(state.hasToasted).toBe(false);
	});

	it("session_start with a missing dbRoot does not toast and leaves flag untouched (#0029)", async () => {
		const missing = join(tmpdir(), `pi-issue-missing-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		const state = { hasToasted: false };
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot: missing,
			parseFailureToastState: state,
		});

		expect(warningNotifies(ctx).filter((w) => !w.startsWith("local-issue-watcher: dbRoot not found"))).toHaveLength(0);
		expect(state.hasToasted).toBe(false);
	});

	it("repeated handleSessionStart calls sharing state fire at most one toast total (#0029)", async () => {
		// Stand-in for "session_start + many polls" at the handleSessionStart
		// layer: with a single shared `parseFailureToastState`, the second
		// call observing the same bad files must not re-toast.
		writeBadIssue("skill-a", "0001-bad.json");
		const pi = makeFakePi();
		const ctx = makeFakeCtx([runningRunstate()]);
		const state = { hasToasted: false };
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot,
			parseFailureToastState: state,
		});
		await handleSessionStart({
			pi: pi as never,
			ctx: ctx as never,
			dbRoot,
			parseFailureToastState: state,
		});

		expect(warningNotifies(ctx)).toHaveLength(1);
	});

	// -- /local-issue-watcher status --

	it("/status toasts on the FIRST invocation when bad files exist and no prior toast fired (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad.json");
		writeBadIssue("skill-a", "0002-bad.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("status", ctx);

		const warnings = warningNotifies(ctx);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/2/);
	});

	it("/status called twice in a row toasts only the first time (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher")!;
		const ctx = makeFakeCtx();

		await cmd.handler("status", ctx);
		await cmd.handler("status", ctx);
		await cmd.handler("status", ctx);

		expect(warningNotifies(ctx)).toHaveLength(1);
	});

	it("/status scan uses singular phrasing for a single failing file (#0029)", async () => {
		writeBadIssue("skill-a", "0001-only.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("status", ctx);

		const warnings = warningNotifies(ctx);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/\b1 issue file\b/);
		expect(warnings[0]).not.toMatch(/\bissue files\b/);
	});

	// -- pause / resume interaction --

	it("pause does not reset hasToasted and resume does not re-toast the same session (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher")!;
		const ctx = makeFakeCtx();

		// First scan via /status fires the single allowed toast.
		await cmd.handler("status", ctx);
		expect(warningNotifies(ctx)).toHaveLength(1);

		await cmd.handler("pause", ctx);
		await cmd.handler("resume", ctx); // resume scans again with bad files still present

		// Still exactly one warning — resume must NOT re-toast because the
		// session has already spent its one-shot budget.
		expect(warningNotifies(ctx)).toHaveLength(1);
	});

	// -- message shape, non-negotiable --

	it("toast uses level 'warning' not 'info' or 'error' (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const cmd = pi.commands.get("local-issue-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("status", ctx);

		const parseFailureCalls = ctx.ui.notify.mock.calls.filter((c) =>
			String(c[0]).includes("failed to parse"),
		);
		expect(parseFailureCalls).toHaveLength(1);
		expect(parseFailureCalls[0]?.[1]).toBe("warning");
	});
});
