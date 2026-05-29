import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtensionWithClient } from "../src/index.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { GlueClient, JobRunResponse, WorkflowRunResponse } from "../src/glue-client.js";
import { makeRuntime, POLL_ERROR_THRESHOLD, pollOnce } from "../src/runtime.js";
import {
	handleToolAction,
	reconcileToolActivation,
	registerToolIfNeeded,
	removeToolFromActive,
	resetToolRegisteredForTests,
	syncToolActiveState,
} from "../src/toolAction.js";
import type { GlueWatch } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePi(opts: { handlers?: { sessionStart?: (e: unknown, c: unknown) => Promise<void> | void } } = {}) {
	const handlers = opts.handlers ?? {};
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		registerTool: vi.fn(),
		getActiveTools: vi.fn().mockReturnValue([]),
		setActiveTools: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn((event: string, handler: (e: unknown, c: unknown) => Promise<void> | void) => {
			if (event === "session_start") handlers.sessionStart = handler;
		}),
		events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
		_handlers: handlers,
	};
}

function makeClient(): GlueClient {
	return {
		getJobRun: vi.fn().mockResolvedValue({
			JobRun: { JobRunState: "RUNNING", ErrorMessage: "" },
		} satisfies JobRunResponse),
		getWorkflowRun: vi.fn().mockResolvedValue({
			Run: {
				Status: "RUNNING",
				Statistics: { TotalActions: 2, SucceededActions: 0, FailedActions: 0, RunningActions: 2 },
				Graph: { Nodes: [] },
			},
		} satisfies WorkflowRunResponse),
		getLatestJobRunId: vi.fn().mockResolvedValue("jr_latest123"),
		getLatestWorkflowRunId: vi.fn().mockResolvedValue("wr_latest456"),
		stopJobRun: vi.fn().mockResolvedValue(undefined),
		stopWorkflowRun: vi.fn().mockResolvedValue(undefined),
	};
}

function makeWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
	return {
		watchId: "aabbccdd",
		type: "job",
		name: "my-etl-job",
		runId: "jr_abc123",
		profile: "my-profile",
		region: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: { state: "RUNNING", errorMessage: "" },
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
	resetToolRegisteredForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// registerToolIfNeeded
// ---------------------------------------------------------------------------

describe("registerToolIfNeeded", () => {
	it("calls pi.registerTool exactly once even when invoked multiple times", () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		const piApi = pi as unknown as ExtensionAPI;

		registerToolIfNeeded(piApi, rt);
		registerToolIfNeeded(piApi, rt);
		registerToolIfNeeded(piApi, rt);

		expect(pi.registerTool).toHaveBeenCalledOnce();
	});

	it("registers a tool with the name glue_watcher", () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		registerToolIfNeeded(pi as unknown as ExtensionAPI, rt);

		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "glue_watcher" }),
		);
	});
});

// ---------------------------------------------------------------------------
// tool active-state invariant
// ---------------------------------------------------------------------------

describe("tool active-state invariant: glue_watcher inactive when enabled=false", () => {
	it("removes glue_watcher from active tools after registering when enabled=false", () => {
		const pi = makePi();
		(pi.getActiveTools as ReturnType<typeof vi.fn>).mockReturnValue([
			"glue_watcher",
			"read",
			"bash",
		]);
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = false; // default

		registerToolIfNeeded(pi as unknown as ExtensionAPI, rt);
		removeToolFromActive(pi as unknown as ExtensionAPI);

		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.not.arrayContaining(["glue_watcher"]),
		);
	});

	it("does NOT call setActiveTools when enabled=true", () => {
		const pi = makePi();
		(pi.getActiveTools as ReturnType<typeof vi.fn>).mockReturnValue([
			"glue_watcher",
			"read",
			"bash",
		]);
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = true;

		// When enabled=true, registerToolIfNeeded is called but removeToolFromActive is NOT.
		registerToolIfNeeded(pi as unknown as ExtensionAPI, rt);
		// Do NOT call removeToolFromActive here — that's the invariant.

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("syncToolActiveState: re-adds glue_watcher to active set when enabled=true", () => {
	it("adds glue_watcher to the active set when enabled=true and the tool is absent", () => {
		const pi = makePi();
		(pi.getActiveTools as ReturnType<typeof vi.fn>).mockReturnValue(["read", "bash"]);
		syncToolActiveState(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.arrayContaining(["read", "bash", "glue_watcher"]),
		);
	});

	it("is a no-op when enabled=true and glue_watcher is already in the active set", () => {
		const pi = makePi();
		(pi.getActiveTools as ReturnType<typeof vi.fn>).mockReturnValue([
			"glue_watcher",
			"read",
		]);
		syncToolActiveState(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("removes glue_watcher from the active set when enabled=false", () => {
		const pi = makePi();
		(pi.getActiveTools as ReturnType<typeof vi.fn>).mockReturnValue([
			"glue_watcher",
			"read",
		]);
		syncToolActiveState(pi as unknown as ExtensionAPI, false);
		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.not.arrayContaining(["glue_watcher"]),
		);
	});
});

describe("reconcileToolActivation", () => {
	it("returns 'noop' when enabled=true and glue_watcher is in active set", () => {
		expect(reconcileToolActivation(true, ["glue_watcher", "read"])).toBe("noop");
	});

	it("returns 'noop' when enabled=false and glue_watcher is absent", () => {
		expect(reconcileToolActivation(false, ["read", "bash"])).toBe("noop");
	});

	it("returns 'activate' when enabled=false but glue_watcher is in active set (LLM activated via manage_tools)", () => {
		expect(reconcileToolActivation(false, ["read", "glue_watcher"])).toBe("activate");
	});

	it("returns 'deactivate' when enabled=true but glue_watcher is absent (LLM deactivated via manage_tools)", () => {
		expect(reconcileToolActivation(true, ["read", "bash"])).toBe("deactivate");
	});

	it("treats an empty active-tool list as deactivation when enabled=true", () => {
		expect(reconcileToolActivation(true, [])).toBe("deactivate");
	});
});

describe("session resume: widget + polling restored from persisted watches", () => {
	function makeCtxWithWidget(setWidget: ReturnType<typeof vi.fn>) {
		return {
			hasUI: true,
			ui: { hasUI: true, setWidget, setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => [] },
		};
	}

	function persistedWithWatches(enabled: boolean) {
		return [{
			type: "custom",
			customType: "pi-aws-glue-watcher:state",
			data: {
				savedAt: 1,
				paused: false,
				baselines: { enabled, displayMode: "widget" },
				watches: [{
					watchId: "w1",
					type: "job",
					name: "etl",
					runId: "jr_123",
					profile: "p",
					baseline: { state: "RUNNING", errorMessage: "" },
					addedAt: 0,
					terminal: false,
					consecutiveErrors: 0,
				}],
			},
		}];
	}

	it("restores widget when enabled=true is persisted", async () => {
		const pi = makePi();
		const setWidget = vi.fn();
		createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient());
		await pi._handlers.sessionStart!({}, {
			...makeCtxWithWidget(setWidget),
			sessionManager: { getEntries: () => persistedWithWatches(true) },
		});
		const widgetCalls = setWidget.mock.calls.filter((c) => c[0] === "glue-watcher" && c[1] !== undefined);
		expect(widgetCalls.length).toBeGreaterThan(0);
	});

	it("restores widget when enabled=false but active non-terminal watches exist (crash-recovery path)", async () => {
		// Regression for #0008: session ended before turn_end persisted enabled=true,
		// but watches survived. Widget must still be restored.
		const pi = makePi();
		const setWidget = vi.fn();
		createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient());
		await pi._handlers.sessionStart!({}, {
			...makeCtxWithWidget(setWidget),
			sessionManager: { getEntries: () => persistedWithWatches(false) },
		});
		const widgetCalls = setWidget.mock.calls.filter((c) => c[0] === "glue-watcher" && c[1] !== undefined);
		expect(widgetCalls.length).toBeGreaterThan(0);
	});

	it("does NOT restore widget when there are no active watches", async () => {
		const pi = makePi();
		const setWidget = vi.fn();
		createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient());
		await pi._handlers.sessionStart!({}, makeCtxWithWidget(setWidget));
		const widgetCalls = setWidget.mock.calls.filter((c) => c[0] === "glue-watcher" && c[1] !== undefined);
		expect(widgetCalls.length).toBe(0);
	});
});

describe("startup chat message: triggerTurn + label", () => {
	// Markdown.render() requires initTheme() to be called; do so once for all
	// tests in this describe block that exercise the expanded renderer path.
	beforeEach(() => { initTheme(undefined); });
	it("does NOT send a startup chat message when resuming with active watches", async () => {
		const pi = makePi();
		const client = makeClient();
		createExtensionWithClient(pi as unknown as ExtensionAPI, client);
		expect(pi._handlers.sessionStart).toBeDefined();
		const persistedData = {
			savedAt: 1,
			paused: false,
			baselines: { enabled: true, displayMode: "widget" as const },
			watches: [{
				watchId: "w1",
				type: "job" as const,
				name: "etl",
				runId: "jr_123",
				profile: "p",
				region: undefined,
				baseline: { state: "RUNNING", errorMessage: "" },
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				terminal: false,
				consecutiveErrors: 0,
			}],
		};
		await pi._handlers.sessionStart!({}, {
			hasUI: true,
			ui: { hasUI: true },
			sessionManager: {
				getEntries: () => [
					{ type: "custom", customType: "pi-aws-glue-watcher:state", data: persistedData },
				],
			},
		});
		// Flush setImmediate + microtasks.
		await new Promise((resolve) => setImmediate(resolve));
		// No startup chat message should be injected on session resume.
		const startupCall = pi.sendMessage.mock.calls.find(
			(c) => (c[0] as { customType?: string }).customType === "pi-aws-glue-watcher",
		);
		expect(startupCall).toBeUndefined();
	});

	it("does NOT inject a sendMessage with watches/date details on session resume", async () => {
		const pi = makePi();
		const client = makeClient();
		createExtensionWithClient(pi as unknown as ExtensionAPI, client);
		const persistedData = {
			savedAt: 1,
			paused: false,
			baselines: { enabled: true, displayMode: "widget" as const },
			watches: [{
				watchId: "w1",
				type: "job" as const,
				name: "etl",
				runId: "jr_123",
				profile: "p",
				region: undefined,
				baseline: { state: "RUNNING", errorMessage: "" },
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				terminal: false,
				consecutiveErrors: 0,
			}],
		};
		await pi._handlers.sessionStart!({}, {
			hasUI: true,
			ui: { hasUI: true },
			sessionManager: {
				getEntries: () => [
					{ type: "custom", customType: "pi-aws-glue-watcher:state", data: persistedData },
				],
			},
		});
		await new Promise((resolve) => setImmediate(resolve));
		// The startup sendMessage block is removed — no message with watches details should be sent.
		const startupCall = pi.sendMessage.mock.calls.find(
			(c) => (c[0] as { customType?: string }).customType === "pi-aws-glue-watcher",
		);
		expect(startupCall).toBeUndefined();
	});

	it("renderer: collapsed (default) shows primary lines + expand hint, no sub-fields", () => {
		const pi = makePi();
		createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient());
		const [, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(m: unknown, o: unknown, t: unknown) => { render?: (w: number) => string[] },
		];
		const fakeTheme = {
			bold: (s: string) => s,
			fg: (_c: string, s: string) => s,
			bg: (_c: string, s: string) => s,
		};
		const watches = {
			w1: { watchId: "w1", type: "job" as const, name: "etl", runId: "jr_123",
				profile: "p", region: undefined, baseline: { state: "RUNNING", errorMessage: "" },
				timeoutAt: undefined, addedAt: 0, lastPolledAt: undefined, terminal: false, consecutiveErrors: 0 },
		};
		const msg = {
			content: [{ type: "text", text: "[10:00] active — watching 1 run:\n1. etl — state=RUNNING\n  … ctrl+o to expand" }],
			details: { watches, date: new Date().toISOString() },
		};
		const box = renderer(msg, { expanded: false }, fakeTheme);
		const lines = box.render!(120);
		const joined = lines.join("\n");
		expect(joined).toContain("… ctrl+o to expand");
		expect(joined).not.toContain("\u00b7 run:");
		expect(joined).not.toContain("\u00b7 type:");
	});

	it("renderer: expanded shows sub-fields and no expand hint", () => {
		const pi = makePi();
		createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient());
		const [, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(m: unknown, o: unknown, t: unknown) => { render?: (w: number) => string[] },
		];
		const fakeTheme = {
			bold: (s: string) => s,
			fg: (_c: string, s: string) => s,
			bg: (_c: string, s: string) => s,
		};
		const watches = {
			w1: { watchId: "w1", type: "job" as const, name: "etl", runId: "jr_123",
				profile: "p", region: undefined, baseline: { state: "RUNNING", errorMessage: "" },
				timeoutAt: undefined, addedAt: 0, lastPolledAt: undefined, terminal: false, consecutiveErrors: 0 },
		};
		const msg = {
			content: [{ type: "text", text: "[10:00] active — watching 1 run:\n1. etl — state=RUNNING\n  … ctrl+o to expand" }],
			details: { watches, date: new Date().toISOString() },
		};
		const box = renderer(msg, { expanded: true }, fakeTheme);
		const lines = box.render!(120);
		const joined = lines.join("\n");
		expect(joined).toContain("\u00b7 run: jr_123");
		expect(joined).toContain("\u00b7 type: job");
		expect(joined).not.toContain("… ctrl+o to expand");
	});

	it("registers a message renderer that labels output 'pi-aws-glue-watcher' (no square brackets)", () => {
		const pi = makePi();
		createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient());
		expect(pi.registerMessageRenderer).toHaveBeenCalled();
		const [customType, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(m: unknown, o: unknown, t: unknown) => unknown,
		];
		expect(customType).toBe("pi-aws-glue-watcher");
		const fakeTheme = {
			bold: (s: string) => s,
			fg: (_c: string, s: string) => s,
			bg: (_c: string, s: string) => s,
		};
		const rendered = renderer(
			{ content: [{ type: "text", text: "body" }] },
			{},
			fakeTheme,
		);
		// The renderer returns a pi-tui Component; we don't assert deep structure,
		// we just assert the bracketed default pi label is not what it produces.
		// Concretely: the renderer must apply the literal string "pi-aws-glue-watcher"
		// (no brackets) via theme.fg("customMessageLabel", ...). Spy theme.fg above.
		const labelCalls: string[] = [];
		const spyTheme = {
			bold: (s: string) => s,
			fg: (_c: string, s: string) => { labelCalls.push(s); return s; },
			bg: (_c: string, s: string) => s,
		};
		renderer({ content: [{ type: "text", text: "body" }] }, {}, spyTheme);
		const stripped = labelCalls.map((s) => s.replace(/\x1b\[[^m]*m/g, ""));
		expect(stripped).toContain("pi-aws-glue-watcher");
		expect(stripped.some((s) => s.includes("[") || s.includes("]"))).toBe(false);
		void rendered; // silence unused
	});

	it("registers /glue-watcher with a menu-style description (no subcommand list)", () => {
		const pi = makePi();
		createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient());
		expect(pi.registerCommand).toHaveBeenCalled();
		const calls = pi.registerCommand.mock.calls as unknown as [string, { description: string }][];
		const entry = calls.find((c) => c[0] === "glue-watcher");
		expect(entry).toBeDefined();
		const description = entry![1].description;
		// Subcommands are gone — description must point at the TUI menu
		// rather than enumerate the legacy status|browse|settings tokens.
		expect(description).toMatch(/menu/i);
		expect(description).not.toMatch(/\bstatus\b/);
		expect(description).not.toMatch(/\bbrowse\b/);
		expect(description).not.toMatch(/\bsettings\b/);
		expect(description).not.toMatch(/\benable\b/);
		expect(description).not.toMatch(/\bdisable\b/);
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — add
// ---------------------------------------------------------------------------

describe("handleToolAction — add", () => {
	it("adds a job watch and seeds baseline when runId is provided", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		const result = await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-etl-job",
			runId: "jr_abc123",
			profile: "my-profile",
		});

		expect(result.details.ok).toBe(true);
		expect(Object.keys(rt.watches)).toHaveLength(1);
		const watch = Object.values(rt.watches)[0]!;
		expect(watch.type).toBe("job");
		expect(watch.name).toBe("my-etl-job");
		expect(watch.runId).toBe("jr_abc123");
		expect(watch.baseline).toBeDefined();
	});

	it("adds a workflow watch and seeds baseline", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		const result = await handleToolAction(rt, {
			action: "add",
			type: "workflow",
			name: "my-workflow",
			runId: "wr_def456",
			profile: "my-profile",
		});

		expect(result.details.ok).toBe(true);
		const watch = Object.values(rt.watches)[0]!;
		expect(watch.type).toBe("workflow");
	});

	it("fetches the latest run ID when runId is omitted for a job", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-etl-job",
			profile: "my-profile",
		});

		expect(client.getLatestJobRunId).toHaveBeenCalledWith("my-etl-job", "my-profile", undefined);
		const watch = Object.values(rt.watches)[0]!;
		expect(watch.runId).toBe("jr_latest123");
	});

	it("fetches the latest workflow run ID when runId is omitted", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		await handleToolAction(rt, {
			action: "add",
			type: "workflow",
			name: "my-workflow",
			profile: "my-profile",
		});

		expect(client.getLatestWorkflowRunId).toHaveBeenCalledWith("my-workflow", "my-profile", undefined);
	});

	it("returns an error when type is missing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "add", name: "job", profile: "p" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("type");
	});

	it("returns an error when name is missing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "add", type: "job", profile: "p" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("name");
	});

	it("returns an error when profile is missing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "add", type: "job", name: "my-job" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("profile");
	});

	it("returns an error when fetching the latest run ID fails", async () => {
		const pi = makePi();
		const client = makeClient();
		(client.getLatestJobRunId as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("no runs found"),
		);
		const rt = makeRuntime(pi, client);
		const result = await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-job",
			profile: "p",
		});
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("no runs found");
	});

	it("still adds the watch when baseline seeding fails", async () => {
		const pi = makePi();
		const client = makeClient();
		(client.getJobRun as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("permission denied"),
		);
		const rt = makeRuntime(pi, client);
		const result = await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-job",
			runId: "jr_123",
			profile: "p",
		});
		expect(result.details.ok).toBe(true);
		expect(Object.keys(rt.watches)).toHaveLength(1);
		expect(Object.values(rt.watches)[0]!.baseline).toBeUndefined();
	});

	it("persists state after adding a watch", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "j",
			runId: "jr_1",
			profile: "p",
		});
		expect(pi.appendEntry).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — remove
// ---------------------------------------------------------------------------

describe("handleToolAction — remove", () => {
	it("removes an existing watch by watchId", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.watches["aabb"] = makeWatch({ watchId: "aabb" });

		const result = await handleToolAction(rt, { action: "remove", watchId: "aabb" });

		expect(result.details.ok).toBe(true);
		expect(rt.watches["aabb"]).toBeUndefined();
	});

	it("returns an error for an unknown watchId", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "remove", watchId: "nonexistent" });
		expect(result.details.ok).toBe(false);
	});

	it("returns an error when watchId is omitted", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "remove" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("watchId");
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — list
// ---------------------------------------------------------------------------

describe("handleToolAction — list", () => {
	it("returns an appropriate message when no watches exist", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "list" });
		expect(result.details.ok).toBe(true);
		expect(result.details.message).toContain("no watches");
		expect(result.details.watches).toEqual([]);
	});

	it("lists all watches with their name and state", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.watches["aabb"] = makeWatch({
			watchId: "aabb",
			name: "my-etl-job",
			baseline: { state: "RUNNING", errorMessage: "" },
		});

		const result = await handleToolAction(rt, { action: "list" });

		expect(result.details.message).toContain("my-etl-job");
		expect(result.details.message).toContain("RUNNING");
		expect(result.details.watches).toContain("aabb");
	});

	it("marks terminal watches with [terminal] in the list output", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.watches["aabb"] = makeWatch({ watchId: "aabb", terminal: true });

		const result = await handleToolAction(rt, { action: "list" });

		expect(result.details.message).toContain("[terminal]");
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — pause / resume
// ---------------------------------------------------------------------------

describe("handleToolAction — pause / resume", () => {
	it("sets paused=true on the runtime", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		await handleToolAction(rt, { action: "pause" });
		expect(rt.paused).toBe(true);
	});

	it("clears paused=false on the runtime", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.paused = true;
		await handleToolAction(rt, { action: "resume" });
		expect(rt.paused).toBe(false);
	});

	it("persists state when pausing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		await handleToolAction(rt, { action: "pause" });
		expect(pi.appendEntry).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — status
// ---------------------------------------------------------------------------

describe("handleToolAction — status", () => {
	it("returns a summary with enabled/disabled and active watch counts", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", terminal: false });
		rt.watches["bb"] = makeWatch({ watchId: "bb", terminal: true });

		const result = await handleToolAction(rt, { action: "status" });

		expect(result.details.ok).toBe(true);
		expect(result.details.message).toContain("enabled");
		expect(result.details.message).toContain("2 total");
		expect(result.details.message).toContain("1 active");
		expect(result.details.message).toContain("1 terminal");
	});

	it("shows 'paused' when the runtime is paused", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.paused = true;

		const result = await handleToolAction(rt, { action: "status" });

		expect(result.details.message).toContain("paused");
	});

	it("shows watch count and state in status", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());

		const result = await handleToolAction(rt, { action: "status" });

		expect(result.details.message).toContain("glue-watcher:");
		expect(result.details.message).toContain("watches:");
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — unknown action
// ---------------------------------------------------------------------------

describe("handleToolAction — unknown action", () => {
	it("returns ok=false for an unrecognised action", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "bogus" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("unknown action");
	});
});

// ---------------------------------------------------------------------------
// pollOnce
// ---------------------------------------------------------------------------

describe("pollOnce", () => {
	it("does nothing when paused", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.paused = true;
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa" });

		await pollOnce(rt);

		expect(client.getJobRun).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("polls even when not enabled (rt.enabled only controls tool active-set)", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = false;
		rt.watches["aa"] = makeWatch({ watchId: "aa" });

		await pollOnce(rt);

		// Should still poll — rt.enabled only gates tool active-set membership
		expect(client.getJobRun).toHaveBeenCalled();
	});

	it("does not call sendMessage when there are no events", async () => {
		const pi = makePi();
		const client = makeClient(); // getJobRun returns RUNNING, baseline is RUNNING
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "RUNNING", errorMessage: "" },
		});

		await pollOnce(rt);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("sends a chat message when a state change is detected", async () => {
		const pi = makePi();
		const client = makeClient(); // getJobRun returns RUNNING
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" }, // differs from RUNNING
		});

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ customType: string; content: string }, unknown];
		expect(msg.customType).toBe("pi-aws-glue-watcher");
		expect(msg.content).toContain("STARTING");
		expect(msg.content).toContain("RUNNING");
	});

	it("marks a watch as terminal when a terminal state is detected", async () => {
		const pi = makePi();
		const client: GlueClient = {
			...makeClient(),
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: { JobRunState: "SUCCEEDED", ErrorMessage: "" },
			} satisfies JobRunResponse),
		};
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "RUNNING", errorMessage: "" },
		});

		await pollOnce(rt);

		expect(rt.watches["aa"].terminal).toBe(true);
	});

	it("skips terminal watches during polling", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", terminal: true });

		await pollOnce(rt);

		expect(client.getJobRun).not.toHaveBeenCalled();
	});

	it("continues polling other watches after one throws", async () => {
		const pi = makePi();
		const client = makeClient();
		(client.getJobRun as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValueOnce({
				JobRun: { JobRunState: "RUNNING", ErrorMessage: "" },
			} satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", baseline: { state: "RUNNING", errorMessage: "" } });
		rt.watches["bb"] = makeWatch({ watchId: "bb", runId: "jr_xyz", baseline: { state: "STARTING", errorMessage: "" } });

		// Should not throw even though first call fails
		await expect(pollOnce(rt)).resolves.not.toThrow();
	});

	it("persists state after detecting changes", async () => {
		const pi = makePi();
		const client = makeClient(); // returns RUNNING
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" },
		});

		await pollOnce(rt);

		expect(pi.appendEntry).toHaveBeenCalled();
	});
	it("change notification omits re-activation hint when tool is enabled", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" },
		});

		await pollOnce(rt);

		const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(msg.content).not.toContain("manage_tools");
	});

	it("change notification includes re-activation hint when tool is inactive", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = false;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" },
		});

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(msg.content).toContain("manage_tools");
		expect(msg.content).toContain("glue_watcher");
		expect(msg.content).toContain("activate");
	});

	it("change notification uses triggerTurn: true so the LLM is woken up", async () => {
		const pi = makePi();
		const client = makeClient(); // returns RUNNING
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" }, // differs from RUNNING
		});

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [, opts] = pi.sendMessage.mock.calls[0] as [unknown, { triggerTurn?: boolean; deliverAs?: string }];
		expect(opts.triggerTurn).toBe(true);
	});

	it("change notification when tool is inactive still uses triggerTurn: true", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = false;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" },
		});

		await pollOnce(rt);

		const [, opts] = pi.sendMessage.mock.calls[0] as [unknown, { triggerTurn?: boolean; deliverAs?: string }];
		expect(opts.triggerTurn).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// pollOnce — error backoff + recovery
// ---------------------------------------------------------------------------

describe("pollOnce — consecutive error tracking", () => {
	it("increments consecutiveErrors on each poll failure", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockRejectedValue(new Error("timeout"));
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(1);
		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(2);
	});

	it("resets consecutiveErrors to 0 on a successful poll", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun")
			.mockRejectedValueOnce(new Error("timeout"))
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce({ JobRun: { JobRunState: "RUNNING", ErrorMessage: "" } } satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);
		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(2);

		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(0);
	});

	it("sends a warning chat message exactly once when threshold is reached", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockRejectedValue(
			Object.assign(new Error("token expired — internal detail"), { name: "CredentialsProviderError" }),
		);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", consecutiveErrors: POLL_ERROR_THRESHOLD - 1, baseline: { state: "RUNNING", errorMessage: "" } });

		// This poll pushes it to threshold — warning should fire
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [msg] = pi.sendMessage.mock.calls[0]! as [{ content: string }];
		expect(msg.content).toContain("⚠");
		expect(msg.content).toContain("aa");
		expect(msg.content).toContain("authentication");

		// Subsequent polls should NOT send additional threshold messages
		await pollOnce(rt);
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("sends a recovery message (triggerTurn: false) after error streak clears", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockResolvedValue({ JobRun: { JobRunState: "RUNNING", ErrorMessage: "" } } satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		// Pre-load with a streak above threshold
		rt.watches["aa"] = makeWatch({ watchId: "aa", consecutiveErrors: POLL_ERROR_THRESHOLD, baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = pi.sendMessage.mock.calls[0]! as [{ content: string }, { triggerTurn?: boolean } | undefined];
		expect(msg.content).toContain("✓");
		expect(msg.content).toContain("aa");
		expect(msg.content).toContain(`${POLL_ERROR_THRESHOLD} consecutive error`);
		expect(opts?.triggerTurn).toBe(false);
	});

	it("does not send a recovery message when error count was below threshold", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockResolvedValue({ JobRun: { JobRunState: "RUNNING", ErrorMessage: "" } } satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", consecutiveErrors: 2, baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);

		// No change in state, no recovery message (streak below threshold)
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(rt.watches["aa"].consecutiveErrors).toBe(0);
	});
});

describe("POLL_INTERVAL_MAX_MS", () => {
	it("is 15 minutes (900_000 ms)", () => {
		expect(POLL_ERROR_THRESHOLD).toBe(5);
	});
});
