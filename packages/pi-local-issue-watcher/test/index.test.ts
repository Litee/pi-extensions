import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import createExtension, {
	POLL_INTERVAL_MS,
	__setInfoPickerForTests,
	handleSessionStart,
	resolveDbRoot,
} from "../src/index.js";
import {
	ITEM_BROWSE_PREFIX,
	ITEM_CLOSE,
	ITEM_ENABLE,
	ITEM_DISABLE,
	ITEM_REFRESH,
	MENU_TITLE,
} from "../src/command.js";
import type { InfoPicker, InfoRow } from "../src/infoHandler.js";
import { STATE_ENTRY_TYPE, ENABLED_ENTRY_TYPE } from "../src/persistence.js";
import { abbreviatePath } from "../src/path.js";
import type { Snapshot } from "../src/types.js";

// Local const for backward compat (runstate persistence removed)
const RUNSTATE_ENTRY_TYPE = "pi-local-issue-watcher:runstate";

// ---------------------------------------------------------------------------
// Session-entry helpers
// ---------------------------------------------------------------------------

/** Build a persisted enabled=true entry (sticky, no TTL). */
function makeEnabledEntry(enabled = true) {
	return {
		type: "custom",
		customType: ENABLED_ENTRY_TYPE,
		data: { savedAt: Date.now(), items: [], baselines: { enabled } },
	};
}

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
	readonly commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>;
	/** Map of customType → registered renderer (from registerMessageRenderer calls). */
	readonly renderers: Map<
		string,
		(message: { customType: string; content: unknown; details?: unknown }, options: { expanded: boolean }, theme: unknown) => unknown
	>;
}

function makeFakePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>();
	const renderers = new Map<
		string,
		(message: { customType: string; content: unknown; details?: unknown }, options: { expanded: boolean }, theme: unknown) => unknown
	>();

	const on = vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
		handlers.set(event, fn);
	});
	const registerCommand = vi.fn((name: string, def: { description: string; handler: (args: string, ctx: unknown) => unknown }) => {
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
		select: ReturnType<typeof vi.fn>;
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
			// Default select always closes the menu — tests that need specific menu
			// interactions override this with .mockResolvedValueOnce(...).
			select: vi.fn().mockResolvedValue(ITEM_CLOSE),
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
function runningRunstate() {
	// Legacy helper — run-state entries are now ignored by session rehydration
	return {
		type: "custom",
		customType: RUNSTATE_ENTRY_TYPE,
		data: { savedAt: Date.now(), items: [] },
	};
}

// ---------------------------------------------------------------------------
// Helper: build a new-format STATE_ENTRY_TYPE session entry.
// In the new persistence, snapshot is stored as Object.entries(serialised)
// (array of [path, info] tuples where mtimeNs is a string).
// ---------------------------------------------------------------------------
function makeStateEntry(
	snapshot: Snapshot,
	savedAt = Date.now(),
): { type: string; customType: string; data: unknown } {
	return {
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: {
			savedAt,
			snapshot: Object.entries(snapshot).map(([path, info]) => [
				path,
				{ ...info, mtimeNs: info.mtimeNs.toString() },
			]),
			baselines: {},
		},
	};
}

// ---------------------------------------------------------------------------
// Menu-driving helpers (for the new /local-issue-watcher menu interface)
// ---------------------------------------------------------------------------

/**
 * Build a minimal ctx suitable for tests that exercise the TUI menu.
 * The `select` mock defaults to returning `ITEM_CLOSE` unless overridden.
 */
function makeMenuCtx(
	select: (title: string, items: string[]) => Promise<string | null>,
	notify: ReturnType<typeof vi.fn> = vi.fn(),
	setStatus: ReturnType<typeof vi.fn> = vi.fn(),
) {
	return {
		hasUI: true,
		ui: {
			hasUI: true,
			select,
			notify,
			setStatus,
			theme: {
				fg: vi.fn((_c: string, t: string) => `<fg:${_c}>${t}</fg>`),
				bold: vi.fn((t: string) => `<b>${t}</b>`),
			},
		},
		sessionManager: { getEntries: () => [] },
		cwd: "/tmp",
	};
}
/** Drive the command handler to Refresh once via the menu, then close. */
async function refreshViaMenu(pi: StubPi, ctx: StubCtx): Promise<void> {
	ctx.ui.select
		.mockResolvedValueOnce(ITEM_REFRESH)
		.mockResolvedValueOnce(ITEM_CLOSE);
	await pi.commands.get("local-issue-watcher")!.handler("", ctx);
}

/** Drive the command handler to Browse once via the menu, then close. */
async function browseViaMenu(pi: StubPi, ctx: StubCtx): Promise<void> {
	// The browse item label includes the open count; match on prefix.
	ctx.ui.select
		.mockImplementationOnce(
			(_title: string, items: string[]) => {
				const browseItem = items.find((i) => i.startsWith(ITEM_BROWSE_PREFIX))!;
				return browseItem;
			},
		)
		.mockResolvedValueOnce(ITEM_CLOSE);
	await pi.commands.get("local-issue-watcher")!.handler("", ctx);
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
				description: expect.any(String) as unknown,
				handler: expect.any(Function) as unknown,
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

	let _pi_local_issue_watcher_idx_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_idx_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-idx-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_idx_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_idx_)) {
			rmSync(join(_pi_local_issue_watcher_idx_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_idx_;
	});

	afterEach(() => {});

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
		const [entryType, payload] = pi.appendEntry.mock.calls[0] as [string, { savedAt: number; snapshot: Array<[string, unknown]> }];
		expect(entryType).toBe(STATE_ENTRY_TYPE);
		// New format: snapshot is stored as array of [path, info] entries
		expect(Array.isArray(payload.snapshot)).toBe(true);
		expect(payload.snapshot).toHaveLength(1);
		expect(typeof payload.savedAt).toBe("number");

		// No diff message delivered — nothing to report yet. (Since #0011, a
		// chat-visible startup summary is also emitted with triggerTurn:false;
		// that is tested separately in the 'startup chat message' block.)
		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("update:"),
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
			makeStateEntry(baselineSnapshot),
		]);

		const out = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [payload, opts] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display?: boolean; details?: unknown },
			{ triggerTurn?: boolean; deliverAs?: string },
		];
		expect(payload.customType).toBe("pi-local-issue-watcher");
		expect(payload.display).toBe(true);
		expect(payload.content).toMatch(/\] \d+ updates?:/);
		expect(payload.content).toMatch(/status changed/);
		expect(opts).toMatchObject({ triggerTurn: true });

		// New baseline persisted.
		expect(pi.appendEntry).toHaveBeenCalledWith(
			STATE_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) as unknown, snapshot: expect.any(Object) as unknown }),
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
					// New format: array of [path, info] tuples
					snapshot: [[filePath, { ...snap[filePath]!, mtimeNs: String(snap[filePath]!.mtimeNs) }]],
					baselines: {},
				},
			},
		]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		// Since #0011, the watcher emits a chat-visible startup summary on every
		// session_start (when not paused and dbRoot exists). The 'no real
		// changes' assertion is now about the DIFF path not firing.
		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("update:"),
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
						customType: RUNSTATE_ENTRY_TYPE,
						data: { savedAt: Date.now(), items: [], baselines: {} },
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

// ---------------------------------------------------------------------------
// /local-issue-watcher command (menu-driven)
// ---------------------------------------------------------------------------

describe("/local-issue-watcher command", () => {
	let dbRoot: string;
	let _pi_local_issue_watcher_cmd_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_cmd_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-cmd-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_cmd_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_cmd_)) {
			rmSync(join(_pi_local_issue_watcher_cmd_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_cmd_;
	});

	afterEach(() => {});

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

	it("opens menu via ctx.ui.select, items match expected shape, exits on Close", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await pi.commands.get("local-issue-watcher")!.handler("", makeMenuCtx(select, notify));
		expect(select).toHaveBeenCalledTimes(1);
		const [title, items] = select.mock.calls[0] as [string, string[]];
		expect(title).toBe(MENU_TITLE);
		expect(items[0]).toMatch(new RegExp(`^${ITEM_BROWSE_PREFIX} \\(`));
		expect(items[1]).toBe(ITEM_REFRESH);
		expect(items[2]).toBe(ITEM_ENABLE); // rt.enabled starts false
		expect(items[3]).toBe(ITEM_CLOSE);
		expect(items).toHaveLength(4);
	});

	it("ignores any args — menu always opens", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await pi.commands.get("local-issue-watcher")!.handler("status", makeMenuCtx(select));
		expect(select).toHaveBeenCalledTimes(1);
		await pi.commands.get("local-issue-watcher")!.handler("pause", makeMenuCtx(vi.fn().mockResolvedValueOnce(ITEM_CLOSE)));
		await pi.commands.get("local-issue-watcher")!.handler("frobnicate", makeMenuCtx(vi.fn().mockResolvedValueOnce(ITEM_CLOSE)));
	});

	it("exits on null choice (Esc cancels the menu)", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const select = vi.fn().mockResolvedValueOnce(null);
		await pi.commands.get("local-issue-watcher")!.handler("", makeMenuCtx(select));
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("shows N open count in Browse item based on current rt.snapshot", async () => {
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(join(dbRoot, "skill-a", "0001-a.json"), JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }));
		writeFileSync(join(dbRoot, "skill-a", "0002-b.json"), JSON.stringify({ id: "0002", status: "done", title: "t2", skill: "skill-a" }));
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// session_start populates rt.snapshot
		const ctx = makeFakeCtx([runningRunstate(), makeEnabledEntry()]);
		await pi.sessionStartHandler!({}, ctx);
		// Now invoke the menu and capture the items
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await pi.commands.get("local-issue-watcher")!.handler("", makeMenuCtx(select));
		const [, items] = select.mock.calls[0] as [string, string[]];
		expect(items[0]).toBe(`${ITEM_BROWSE_PREFIX} (1 open)`);
	});

	it("warns and exits when ctx.ui.select is unavailable", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const notify = vi.fn();
		await pi.commands.get("local-issue-watcher")!.handler("", {
			hasUI: true,
			ui: { hasUI: true, notify },
		});
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/requires an interactive UI/),
			"warning",
		);
	});

	// -- hasUI calculation branches (command.ts lines 102-103) --

	it("hasUI falls through to anyCtx.ui?.hasUI when anyCtx.hasUI is undefined", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// hasUI is undefined → falls through to ui.hasUI
		const uiObj = {
			hasUI: true,
			notify: vi.fn(),
			select: vi.fn().mockResolvedValueOnce(ITEM_CLOSE),
		};
		const ctx = { ui: uiObj };
		await pi.commands.get("local-issue-watcher")!.handler("", ctx);
		// Handler proceeds normally — ui.hasUI=true → hasUI=true → rt.ui set
		// (no select-unavailable warning)
		expect(uiObj.notify).not.toHaveBeenCalledWith(
			expect.stringMatching(/requires an interactive UI/),
		);
	});

	it("hasUI falls through to anyCtx.ui !== undefined when both hasUI and ui?.hasUI are absent", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// hasUI is undefined, ui is defined but ui.hasUI is not → ui !== undefined is true
		const uiObj = {
			notify: vi.fn(),
			select: vi.fn().mockResolvedValueOnce(ITEM_CLOSE),
		};
		const ctx = { ui: uiObj };
		await pi.commands.get("local-issue-watcher")!.handler("", ctx);
		// Handler proceeds — ui !== undefined → hasUI=true
		expect(uiObj.notify).not.toHaveBeenCalledWith(
			expect.stringMatching(/requires an interactive UI/),
		);
	});

	it("hasUI is false when ctx.hasUI is explicitly false — handler still works", async () => {
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const uiObj = {
			hasUI: false,
			notify: vi.fn(),
			select: vi.fn().mockResolvedValueOnce(ITEM_CLOSE),
		};
		const ctx = { hasUI: false, ui: uiObj };
		await pi.commands.get("local-issue-watcher")!.handler("", ctx);
		// hasUI=false → rt.ui is NOT modified, but the menu still works
		// (hasUI only controls rt.ui assignment, not the menu loop)
		expect(uiObj.select).toHaveBeenCalledTimes(1);
	});

	it("'Browse issues …' → calls the test-injected picker", async () => {
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);
		const pickerCalled: number[] = [];
		__setInfoPickerForTests(() => {
			pickerCalled.push(1);
			return Promise.resolve();
		});
		try {
			const pi = makeFakePi();
			extensionWithDbRoot(pi, dbRoot);
			const ctx = makeFakeCtx();
			await browseViaMenu(pi, ctx);
			expect(pickerCalled).toHaveLength(1);
		} finally {
			__setInfoPickerForTests(null);
		}
	});

	it("'Browse issues …' with missing dbRoot → notify warning, picker NOT called, menu loop continues", async () => {
		const missing = join(dbRoot, "does-not-exist");
		const pickerCalled: number[] = [];
		__setInfoPickerForTests(() => {
			pickerCalled.push(1);
			return Promise.resolve();
		});
		try {
			const pi = makeFakePi();
			extensionWithDbRoot(pi, missing);
			const notify = vi.fn();
			// First select returns a browse item, menu continues; second returns Close.
			const select = vi
				.fn()
				.mockImplementationOnce((_title: string, items: string[]) =>
					Promise.resolve(items.find((i) => i.startsWith(ITEM_BROWSE_PREFIX))!),
				)
				.mockResolvedValueOnce(ITEM_CLOSE);
			await pi.commands.get("local-issue-watcher")!.handler("", makeMenuCtx(select, notify));
			expect(pickerCalled).toHaveLength(0);
			expect(select).toHaveBeenCalledTimes(2); // loop continued after warning
			const warns = notify.mock.calls.filter((c) => c[1] === "warning");
			expect(warns).toHaveLength(1);
			expect(String(warns[0]![0])).toMatch(/local-issue-watcher browse/);
		} finally {
			__setInfoPickerForTests(null);
		}
	});

	it("'Refresh' with no changes → no diff sendMessage, notify 'refreshed'", async () => {
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// Run session_start so rt.snapshot is populated (no diff on subsequent Refresh)
		const ctx = makeFakeCtx([runningRunstate(), makeEnabledEntry()]);
		await pi.sessionStartHandler!({}, ctx);
		pi.sendMessage.mockClear();

		await refreshViaMenu(pi, ctx);

		// No diff message (snapshot unchanged)
		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("update:"),
		);
		expect(diffCalls).toHaveLength(0);

		// But notify 'refreshed' fires
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => m.includes("refreshed"))).toBe(true);
	});

	it("cold-start Refresh (empty rt.snapshot, single open issue) → first-update message with triggerTurn:false and display:true", async () => {
		// rt.snapshot starts as {} because session_start was never called (watcher
		// enabled mid-session). The fix emits a concise first-update listing instead
		// of flooding chat with per-issue 'new' notifications.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// Do NOT call sessionStartHandler so rt.snapshot remains {}
		const ctx = makeFakeCtx();
		await refreshViaMenu(pi, ctx);

		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "pi-local-issue-watcher",
		);
		expect(diffCalls).toHaveLength(1);
		const [payload, opts] = diffCalls[0] as [
			{ customType: string; content: string; display?: boolean; details?: unknown },
			{ triggerTurn?: boolean },
		];
		// New behavior: first-update format, NOT the normal diff format
		expect(payload.content).toMatch(/tracking 1 open issue/);
		expect(payload.content).not.toMatch(/update:|new issue/i);
		expect(payload.display).toBe(true);
		expect(payload.details).toBeUndefined();
		expect(opts.triggerTurn).toBe(false);
	});

	it("cold-start Refresh with multiple issues of mixed statuses → first-update lists only open issues, no flood", async () => {
		// 2 open + 1 done + 1 wont_fix on disk; rt.snapshot = {} (no prior session_start)
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		mkdirSync(join(dbRoot, "skill-b"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "Alpha", skill: "skill-a" }),
		);
		writeFileSync(
			join(dbRoot, "skill-a", "0002-b.json"),
			JSON.stringify({ id: "0002", status: "open", title: "Beta", skill: "skill-a" }),
		);
		writeFileSync(
			join(dbRoot, "skill-b", "0003-c.json"),
			JSON.stringify({ id: "0003", status: "done", title: "Gamma", skill: "skill-b" }),
		);
		writeFileSync(
			join(dbRoot, "skill-b", "0004-d.json"),
			JSON.stringify({ id: "0004", status: "wont_fix", title: "Delta", skill: "skill-b" }),
		);
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// Do NOT call sessionStartHandler so rt.snapshot remains {}
		const ctx = makeFakeCtx();
		await refreshViaMenu(pi, ctx);

		const watcherCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "pi-local-issue-watcher",
		);
		// Exactly one message emitted (no flood)
		expect(watcherCalls).toHaveLength(1);
		const [payload, opts] = watcherCalls[0] as [
			{ customType: string; content: string; display?: boolean; details?: unknown },
			{ triggerTurn?: boolean },
		];
		// Header lists 2 open issues
		expect(payload.content).toContain("tracking 2 open issues:");
		// Both open issues appear as bullets
		expect(payload.content).toContain("issue #0001");
		expect(payload.content).toContain("issue #0002");
		// done and wont_fix issues are NOT mentioned
		expect(payload.content).not.toContain("issue #0003");
		expect(payload.content).not.toContain("issue #0004");
		expect(payload.content).not.toContain("Gamma");
		expect(payload.content).not.toContain("Delta");
		// No 'new issue' flood
		expect(payload.content).not.toMatch(/new issue/i);
		// Delivery opts: display:true, triggerTurn:false
		expect(payload.display).toBe(true);
		expect(payload.details).toBeUndefined();
		expect(opts.triggerTurn).toBe(false);

		// Baseline is now established — a second identical Refresh emits NO further watcher message
		pi.sendMessage.mockClear();
		await refreshViaMenu(pi, ctx);
		const watcherCalls2 = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "pi-local-issue-watcher",
		);
		expect(watcherCalls2).toHaveLength(0);
	});

	it("'Refresh' with missing dbRoot → notify warning, no sendMessage", async () => {
		const missing = join(dbRoot, "does-not-exist");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, missing);
		const notify = vi.fn();
		const select = vi
			.fn()
			.mockResolvedValueOnce(ITEM_REFRESH)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await pi.commands.get("local-issue-watcher")!.handler("", makeMenuCtx(select, notify));
		expect(pi.sendMessage).not.toHaveBeenCalled();
		const warns = notify.mock.calls.filter((c) => c[1] === "warning");
		expect(warns).toHaveLength(1);
		expect(String(warns[0]![0])).toContain("dbRoot not found");
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
		const ctx = makeFakeCtx([runningRunstate(), makeEnabledEntry()]); // first session: saves baseline, no diff
		await handler({}, ctx);

		// Fresh session emits the #0011 startup summary (with triggerTurn:false)
		// but no diff message yet.
		const diffCallsBefore = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("update:"),
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

		await sessionStart({}, makeFakeCtx([makeEnabledEntry()]));
		const diffsBefore = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("update:"),
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
			(c) => (c[0] as { content: string }).content.includes("update:"),
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
		const ctx = makeFakeCtx([runningRunstate(), makeEnabledEntry()]);
		await handler({}, ctx);
		const diffsAfterStartup = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("update:"),
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
			(c) => (c[0] as { content: string }).content.includes("update:"),
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
			(c) => (c[0] as { content: string }).content.includes("update:"),
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

	let _pi_local_issue_watcher_rs_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_rs_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-rs-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_rs_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_rs_)) {
			rmSync(join(_pi_local_issue_watcher_rs_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_rs_;
	});

	afterEach(() => {});

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
					data: { savedAt: Date.now(), items: [], baselines: {} },
				},
				makeEnabledEntry(),
			]);
			await pi.sessionStartHandler!({}, ctx);
			// Mutate disk with a bumped mtime so the scanner sees a change.
			writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
			const { utimesSync } = await import("node:fs");
			const future = new Date(Date.now() + 60_000);
			utimesSync(filePath, future, future);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			const diffCalls = pi.sendMessage.mock.calls.filter(
				(c) => (c[0] as { content: string }).content.includes("update:"),
			);
			expect(diffCalls).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Enabled/disabled lifecycle (default inactive, menu-activated)
// ---------------------------------------------------------------------------

describe("enabled/disabled lifecycle", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-en-"));
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

	it("session_start with no enabled entry → does NOT start polling (stays inactive)", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// No enabled entry — watcher defaults to inactive.
		const ctx = makeFakeCtx([]);
		await pi.sessionStartHandler!({}, ctx);

		// No status pinned, no message sent, no snapshot persisted.
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();

		// Advance past one poll interval — no diff fires.
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("session_start with enabled:true persisted → starts polling", async () => {
		const filePath = writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx([makeEnabledEntry()]);
		await pi.sessionStartHandler!({}, ctx);

		// Snapshot was persisted (baseline saved on first session).
		expect(pi.appendEntry).toHaveBeenCalled();

		// Mutate disk so the poll produces a diff.
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
		const { utimesSync } = await import("node:fs");
		utimesSync(filePath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

		const diffCalls = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content.includes("status changed"),
		);
		expect(diffCalls).toHaveLength(1);
	});

	it("menu 'Enable watcher' → persistEnabled(true) called, startPolling fires", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// Start disabled (no enabled entry).
		await pi.sessionStartHandler!({}, makeFakeCtx([]));
		pi.appendEntry.mockClear();

		// Open menu and click Enable.
		const select = vi.fn()
			.mockResolvedValueOnce(ITEM_ENABLE)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const ctx = makeMenuCtx(select);
		await pi.commands.get("local-issue-watcher")!.handler("", ctx);

		// persistEnabled(true) appended an ENABLED_ENTRY_TYPE entry.
		const enableCalls = pi.appendEntry.mock.calls.filter(
			([ct]) => ct === ENABLED_ENTRY_TYPE,
		) as Array<[string, Record<string, unknown>]>;
		expect(enableCalls).toHaveLength(1);
		expect((enableCalls[0]![1]["baselines"] as Record<string, unknown>)["enabled"]).toBe(true);

		// Polling now runs: disk change after Enable fires a diff.
		const filePath = join(dbRoot, "skill-a", "0001-a.json");
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
		const { utimesSync } = await import("node:fs");
		utimesSync(filePath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		const diffs = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "pi-local-issue-watcher",
		);
		expect(diffs.length).toBeGreaterThan(0);
	});

	it("menu 'Disable watcher' → persistEnabled(false) called, stopPolling fires", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// Start enabled.
		await pi.sessionStartHandler!({}, makeFakeCtx([makeEnabledEntry()]));
		pi.appendEntry.mockClear();
		pi.sendMessage.mockClear();

		// Open menu and click Disable.
		const select = vi.fn()
			.mockResolvedValueOnce(ITEM_DISABLE)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		const setStatus = vi.fn();
		const ctx = makeMenuCtx(select, notify, setStatus);
		await pi.commands.get("local-issue-watcher")!.handler("", ctx);

		// persistEnabled(false) appended an ENABLED_ENTRY_TYPE entry.
		const disableCalls = pi.appendEntry.mock.calls.filter(
			([ct]) => ct === ENABLED_ENTRY_TYPE,
		) as Array<[string, Record<string, unknown>]>;
		expect(disableCalls).toHaveLength(1);
		expect((disableCalls[0]![1]["baselines"] as Record<string, unknown>)["enabled"]).toBe(false);

		// Polling stopped: no diffs fire after Disable.
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "done", skill: "skill-a" });
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		const diffs = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { content: string }).content?.includes("update:"),
		);
		expect(diffs).toHaveLength(0);
	});

	// -- hasUI calculation in session_start handler (index.ts lines 503-504) --

	it("session_start: hasUI falls through to anyCtx.ui?.hasUI when hasUI is undefined", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// hasUI is undefined → falls through to ui.hasUI
		// Build ctx using makeFakeCtx base, then override hasUI
		const baseCtx = makeFakeCtx([makeEnabledEntry()]);
		const ctx = { ...baseCtx, hasUI: undefined } as never;
		await pi.sessionStartHandler!({}, ctx);
		// The handler defers pi.sendMessage via setImmediate (#0015); flush it.
		await vi.advanceTimersByTimeAsync(0);
		// rt.ui should have been set (hasUI=true path via ui.hasUI)
		expect(pi.sendMessage).toHaveBeenCalled();
	});

	it("session_start: hasUI falls through to anyCtx.ui !== undefined when both hasUI and ui?.hasUI are absent", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// hasUI is undefined, ui.hasUI is undefined → falls through to ui !== undefined
		const baseCtx = makeFakeCtx([makeEnabledEntry()]);
		const ctx = {
			...baseCtx,
			hasUI: undefined,
			ui: { ...baseCtx.ui, hasUI: undefined } as never,
		} as never;
		await pi.sessionStartHandler!({}, ctx);
		// The handler defers pi.sendMessage via setImmediate (#0015); flush it.
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalled();
	});

	it("session_start: hasUI is false when ctx.hasUI is explicitly false — rt.ui set to null", async () => {
		writeIssue("skill-a", "0001-a.json", { id: "0001", status: "open", skill: "skill-a" });
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		// hasUI is explicitly false → rt.ui = null
		const baseCtx = makeFakeCtx([makeEnabledEntry()]);
		const ctx = { ...baseCtx, hasUI: false } as never;
		await pi.sessionStartHandler!({}, ctx);
		// The handler defers pi.sendMessage via setImmediate (#0015); flush it.
		await vi.advanceTimersByTimeAsync(0);
		// Handler should still proceed (hasUI only affects rt.ui assignment)
		expect(pi.sendMessage).toHaveBeenCalled();
	});
});


// ---------------------------------------------------------------------------

describe("status line — refresh on every poll (#0016 supersedes #0009)", () => {
	let dbRoot: string;
	let _pi_local_issue_watcher_lua_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_lua_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-lua-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_lua_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_lua_)) {
			rmSync(join(_pi_local_issue_watcher_lua_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_lua_;
	});

	afterEach(() => {});

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
					snapshot: Object.entries(baselineSnapshot).map(([p, info]) => [p, { ...info, mtimeNs: info.mtimeNs.toString() }]),
					baselines: {},
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
			const ctx = makeFakeCtx([runningRunstate(), makeEnabledEntry()]);
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
				(c) => (c[0] as { content: string }).content.includes("update:"),
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
	let _pi_local_issue_watcher_start_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_start_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-start-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_start_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_start_)) {
			rmSync(join(_pi_local_issue_watcher_start_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_start_;
	});

	afterEach(() => {});

	function writeIssue(skill: string, fname: string, body: Record<string, unknown>): string {
		const skillDir = join(dbRoot, skill);
		mkdirSync(skillDir, { recursive: true });
		const p = join(skillDir, fname);
		writeFileSync(p, JSON.stringify(body), "utf8");
		return p;
	}

	it("emits compact status block with display:false and triggerTurn:false on fresh session (#0002)", async () => {
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
		// Compact status block format (same as /status)
		expect(payload.content).toContain("status: active");
		expect(payload.content).toContain("poll:");
		expect(payload.content).toContain("db:");
		expect(payload.content).toMatch(/issues:.*open/);
		// Must NOT trigger LLM turn, must NOT be display-visible (#0002)
		expect(payload.display).toBe(false);
		expect(opts.triggerTurn).toBe(false);
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
			makeStateEntry(baselineSnapshot),
		]);

		await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });

		const sent = pi.sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType?: string }).customType === "pi-local-issue-watcher",
		);
		// Exactly one: the diff message. No second startup-summary message on top.
		expect(sent).toHaveLength(1);
		const payload = sent[0]![0] as { content: string };
		expect(payload.content).toMatch(/\] \d+ updates?:/);
		expect(payload.content).not.toContain("active | dbRoot=");
	});
});

// ---------------------------------------------------------------------------
// deferMessages — defer sendMessage so the TUI renders its bubble before
// the first LLM turn absorbs the content (#0015)
// ---------------------------------------------------------------------------

describe("handleSessionStart deferMessages (#0015)", () => {
	let dbRoot: string;
	let _pi_local_issue_watcher_defer_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_defer_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-defer-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_defer_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_defer_)) {
			rmSync(join(_pi_local_issue_watcher_defer_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_defer_;
	});

	afterEach(() => {});

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
		expect(payload.content).toContain("status: active");
		expect(opts.triggerTurn).toBe(false);
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
		const fakePicker: InfoPicker = (args) => {
			received.push(args);
			return Promise.resolve();
		};
		__setInfoPickerForTests(fakePicker);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();
		await browseViaMenu(pi, ctx);

		expect(received).toHaveLength(1);
		expect(received[0]!.rows).toHaveLength(1);
		expect(received[0]!.rows[0]!.info.issueId).toBe("0001");
		expect(received[0]!.summary).toBe("1 open, 2 total");
		// Happy path fires no notify — the TUI owns the UX from here.
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("'browse' emits a warning notify (and does NOT invoke the picker) when dbRoot is not configured", async () => {
		const pickerCalls: number[] = [];
		__setInfoPickerForTests(() => {
			pickerCalls.push(1);
			return Promise.resolve();
		});

		const missing = join(dbRoot, "does-not-exist");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, missing);
		const ctx = makeFakeCtx();
		await browseViaMenu(pi, ctx);

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

	let _pi_local_issue_watcher_renderer_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_renderer_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-renderer-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_renderer_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_renderer_)) {
			rmSync(join(_pi_local_issue_watcher_renderer_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_renderer_;
	});

	afterEach(() => {});

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

	it("renderer output: round-trip via Refresh menu item shows header label and content without bracket label", async () => {
		// Seed a non-trivial snapshot so the Refresh diff produces a message.
		// rt.snapshot starts as {} so any file on disk will diff as 'new issue'.
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(
			join(dbRoot, "skill-a", "0001-a.json"),
			JSON.stringify({ id: "0001", status: "open", title: "t", skill: "skill-a" }),
		);

		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();
		await refreshViaMenu(pi, ctx);

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
		const ctx = makeFakeCtx([runningRunstate(), makeEnabledEntry()]);
		await pi.sessionStartHandler!({}, ctx);
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

	it("renderer handles array content — filters non-text parts and joins text parts", () => {
		// This covers the defensive branch in the renderer where message.content is an
		// array of content blocks instead of a plain string (index.ts lines 553-554).
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);

		const [customType, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(
				message: { customType: string; content: unknown },
				options: { expanded: boolean },
				theme: typeof fakeTheme,
			) => unknown,
		];

		// Array-form content: two text parts and one non-text part
		const arrayContent = [
			{ type: "text", text: "first line" },
			{ type: "image", url: "http://example.com/img.png" }, // non-text — should be filtered
			{ type: "text", text: "second line" },
		];
		const result = renderer(
			{ customType, content: arrayContent },
			{ expanded: false },
			fakeTheme,
		);
		const lines = renderText(result);
		const joined = lines.join("\n");

		// Both text entries must appear; the image entry must be filtered out
		expect(joined).toContain("first line");
		expect(joined).toContain("second line");
		// Extension header still shown
		expect(joined).toContain(customType);
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
	let _pi_local_issue_watcher_0029_!: string;

	beforeAll(() => {
		_pi_local_issue_watcher_0029_ = mkdtempSync(join(tmpdir(), "pi-local-issue-watcher-0029-"));
	});

	afterAll(() => {
		rmSync(_pi_local_issue_watcher_0029_, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(_pi_local_issue_watcher_0029_)) {
			rmSync(join(_pi_local_issue_watcher_0029_, entry), { recursive: true, force: true });
		}
		dbRoot = _pi_local_issue_watcher_0029_;
	});

	afterEach(() => {});

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

	// -- Refresh (replaces the former /status scan site) --

	it("Refresh toasts on the FIRST invocation when bad files exist and no prior toast fired (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad.json");
		writeBadIssue("skill-a", "0002-bad.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();
		await refreshViaMenu(pi, ctx);

		const warnings = warningNotifies(ctx);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/2/);
	});

	it("Refresh called twice in a row toasts only the first time (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();

		await refreshViaMenu(pi, ctx);
		await refreshViaMenu(pi, ctx);
		await refreshViaMenu(pi, ctx);

		expect(warningNotifies(ctx)).toHaveLength(1);
	});

	it("Refresh scan uses singular phrasing for a single failing file (#0029)", async () => {
		writeBadIssue("skill-a", "0001-only.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();
		await refreshViaMenu(pi, ctx);

		const warnings = warningNotifies(ctx);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/\b1 issue file\b/);
		expect(warnings[0]).not.toMatch(/\bissue files\b/);
	});

	// -- message shape, non-negotiable --

	it("toast uses level 'warning' not 'info' or 'error' (#0029)", async () => {
		writeBadIssue("skill-a", "0001-bad.json");
		const pi = makeFakePi();
		extensionWithDbRoot(pi, dbRoot);
		const ctx = makeFakeCtx();
		await refreshViaMenu(pi, ctx);

		const parseFailureCalls = ctx.ui.notify.mock.calls.filter((c) =>
			String(c[0]).includes("failed to parse"),
		);
		expect(parseFailureCalls).toHaveLength(1);
		expect(parseFailureCalls[0]?.[1]).toBe("warning");
	});
});


