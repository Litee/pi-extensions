import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	__setCmuxSpawnerForTests,
	buildLogArgs,
	buildNotifyArgs,
	buildRenameWorkspaceArgs,
	buildSetStatusArgs,
	clearProgress,
	clearStatus,
	cmuxAvailable,
	hhmm,
	logLine,
	notifyCmux,
	renameWorkspace,
	runCmux,
	setStatus,
} from "../src/cmux.js";

// ---------------------------------------------------------------------------
// Pure helpers — no spawn, no env
// ---------------------------------------------------------------------------

describe("argv builders", () => {
	it("buildSetStatusArgs includes --icon / --color only when supplied", () => {
		expect(buildSetStatusArgs("pi", "idle")).toEqual(["set-status", "pi", "idle"]);
		expect(buildSetStatusArgs("pi", "idle", "checkmark")).toEqual([
			"set-status",
			"pi",
			"idle",
			"--icon",
			"checkmark",
		]);
		expect(buildSetStatusArgs("pi", "idle", "checkmark", "#30d158")).toEqual([
			"set-status",
			"pi",
			"idle",
			"--icon",
			"checkmark",
			"--color",
			"#30d158",
		]);
	});

	it("buildLogArgs interleaves --level, --source, and terminates options with --", () => {
		expect(buildLogArgs("pi", "progress", "Running read")).toEqual([
			"log",
			"--level",
			"progress",
			"--source",
			"pi",
			"--",
			"Running read",
		]);
	});

	it("buildNotifyArgs lays out --title/--subtitle/--body", () => {
		expect(buildNotifyArgs("pi", "cwd", "msg")).toEqual([
			"notify",
			"--title",
			"pi",
			"--subtitle",
			"cwd",
			"--body",
			"msg",
		]);
	});

	it("buildRenameWorkspaceArgs rejects blank titles", () => {
		expect(buildRenameWorkspaceArgs("")).toBeNull();
		expect(buildRenameWorkspaceArgs("  ")).toBeNull();
		expect(buildRenameWorkspaceArgs("Pi Extensions")).toEqual([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Pi Extensions",
		]);
	});
});

describe("hhmm", () => {
	it("zero-pads hours and minutes", () => {
		const d = new Date();
		d.setHours(3, 7, 0, 0);
		expect(hhmm(d)).toBe("03:07");
	});

	it("handles midnight and noon edges", () => {
		const m = new Date();
		m.setHours(0, 0, 0, 0);
		expect(hhmm(m)).toBe("00:00");
		const n = new Date();
		n.setHours(12, 0, 0, 0);
		expect(hhmm(n)).toBe("12:00");
	});
});

// ---------------------------------------------------------------------------
// cmuxAvailable — env var gating
// ---------------------------------------------------------------------------

describe("cmuxAvailable", () => {
	it("returns false when CMUX_WORKSPACE_ID is missing", () => {
		expect(cmuxAvailable({})).toBe(false);
	});

	it("returns false when both CMUX_TAB_ID and CMUX_SURFACE_ID are missing", () => {
		expect(cmuxAvailable({ CMUX_WORKSPACE_ID: "ws-1" })).toBe(false);
	});

	it("returns true when CMUX_TAB_ID is present", () => {
		expect(
			cmuxAvailable({ CMUX_WORKSPACE_ID: "ws-1", CMUX_TAB_ID: "tab-1" }),
		).toBe(true);
	});

	it("returns true when CMUX_SURFACE_ID is present instead of CMUX_TAB_ID", () => {
		expect(
			cmuxAvailable({ CMUX_WORKSPACE_ID: "ws-1", CMUX_SURFACE_ID: "surface:3" }),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Dispatch layer — verify the argv each high-level helper forwards through
// the injected spawner.
// ---------------------------------------------------------------------------

describe("dispatch layer (with injected spawner)", () => {
	let spawner: ReturnType<typeof vi.fn>;
	const origWs = process.env["CMUX_WORKSPACE_ID"];
	const origTab = process.env["CMUX_TAB_ID"];

	beforeEach(() => {
		process.env["CMUX_WORKSPACE_ID"] = "ws-test";
		process.env["CMUX_TAB_ID"] = "tab-test";
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(spawner as unknown as (args: string[]) => Promise<void>);
	});

	afterEach(() => {
		if (origWs === undefined) delete process.env["CMUX_WORKSPACE_ID"];
		else process.env["CMUX_WORKSPACE_ID"] = origWs;
		if (origTab === undefined) delete process.env["CMUX_TAB_ID"];
		else process.env["CMUX_TAB_ID"] = origTab;
		__setCmuxSpawnerForTests(null);
	});

	it("runCmux short-circuits to a resolved no-op when not in cmux", async () => {
		delete process.env["CMUX_WORKSPACE_ID"];
		await runCmux(["set-status", "pi", "idle"]);
		expect(spawner).not.toHaveBeenCalled();
	});

	it("setStatus forwards buildSetStatusArgs output", () => {
		setStatus("pi", "idle", "checkmark", "#30d158");
		expect(spawner).toHaveBeenCalledWith([
			"set-status",
			"pi",
			"idle",
			"--icon",
			"checkmark",
			"--color",
			"#30d158",
		]);
	});

	it("logLine forwards buildLogArgs output", () => {
		logLine("pi", "success", "done");
		expect(spawner).toHaveBeenCalledWith([
			"log",
			"--level",
			"success",
			"--source",
			"pi",
			"--",
			"done",
		]);
	});

	it("notifyCmux forwards buildNotifyArgs output", () => {
		notifyCmux("pi", "cwd", "hello");
		expect(spawner).toHaveBeenCalledWith([
			"notify",
			"--title",
			"pi",
			"--subtitle",
			"cwd",
			"--body",
			"hello",
		]);
	});

	it("clearProgress emits `cmux clear-progress`", () => {
		clearProgress();
		expect(spawner).toHaveBeenCalledWith(["clear-progress"]);
	});

	it("renameWorkspace dispatches non-blank titles", () => {
		renameWorkspace("Pi Extensions");
		expect(spawner).toHaveBeenCalledWith([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Pi Extensions",
		]);
	});

	it("renameWorkspace is a no-op for blank titles", () => {
		renameWorkspace("");
		expect(spawner).not.toHaveBeenCalled();
	});

	it("clearStatus emits `set-status <key> ''`", () => {
		clearStatus("pi");
		expect(spawner).toHaveBeenCalledWith(["set-status", "pi", ""]);
	});
});
