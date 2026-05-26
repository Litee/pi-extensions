/**
 * Tests for toolAction.ts
 */

import { describe, expect, it, vi } from "vitest";

import {
	handleToolAction,
	MAX_TIMEOUT_SECONDS,
	registerToolIfNeeded,
	resetToolRegisteredForTests,
} from "../src/toolAction.js";
import { makeRuntime } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => [] as string[],
		setActiveTools: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
		registerTool: vi.fn(),
	};
}

function makeRuntime_(snap = vi.fn().mockResolvedValue({ exists: false })) {
	const pi = makePi();
	const rt = makeRuntime(pi, snap);
	rt.now = () => 1_000;
	return { rt, pi };
}

// ---------------------------------------------------------------------------
// registerToolIfNeeded
// ---------------------------------------------------------------------------

describe("registerToolIfNeeded", () => {
	it("registers the tool exactly once", () => {
		resetToolRegisteredForTests();
		const pi = makePi();
		const rt = makeRuntime(pi, vi.fn());
		registerToolIfNeeded(pi as never, rt);
		registerToolIfNeeded(pi as never, rt);
		expect(pi.registerTool).toHaveBeenCalledOnce();
		expect(pi.registerTool.mock.calls[0]![0]).toMatchObject({ name: "file_system_watcher" });
	});
});

// ---------------------------------------------------------------------------
// action: add
// ---------------------------------------------------------------------------

describe("handleToolAction — add", () => {
	it("requires a path", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, { action: "add", target: "exists" });
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/path/i);
	});

	it("requires a target", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, { action: "add", path: "/tmp/test.txt" });
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/target/i);
	});

	it("rejects invalid target", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, { action: "add", path: "/tmp/test.txt", target: "foobar" });
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/target/i);
	});

	it("adds a watch and returns watchId", async () => {
		const { rt } = makeRuntime_(vi.fn().mockResolvedValue({ exists: false }));
		const res = await handleToolAction(rt, { action: "add", path: "/tmp/test.txt", target: "exists" });
		expect(res.details.ok).toBe(true);
		expect(res.details.watchId).toBeDefined();
		expect(Object.keys(rt.watches)).toHaveLength(1);
	});

	it("uses MAX_TIMEOUT_SECONDS when timeoutSeconds not supplied", async () => {
		const { rt } = makeRuntime_();
		await handleToolAction(rt, { action: "add", path: "/tmp/x.txt", target: "exists" });
		const w = Object.values(rt.watches)[0]!;
		expect(w.timeoutAt).toBe(rt.now() + MAX_TIMEOUT_SECONDS * 1000);
	});

	it("caps timeoutSeconds at MAX_TIMEOUT_SECONDS", async () => {
		const { rt } = makeRuntime_();
		await handleToolAction(rt, {
			action: "add",
			path: "/tmp/x.txt",
			target: "exists",
			timeoutSeconds: MAX_TIMEOUT_SECONDS * 10,
		});
		const w = Object.values(rt.watches)[0]!;
		expect(w.timeoutAt).toBe(rt.now() + MAX_TIMEOUT_SECONDS * 1000);
	});

	it("rejects invalid timeoutSeconds (zero)", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, {
			action: "add",
			path: "/tmp/x.txt",
			target: "exists",
			timeoutSeconds: 0,
		});
		expect(res.details.ok).toBe(false);
	});

	it("rejects negative timeoutSeconds", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, {
			action: "add",
			path: "/tmp/x.txt",
			target: "exists",
			timeoutSeconds: -100,
		});
		expect(res.details.ok).toBe(false);
	});

	it("rejects target='changed' when path does not exist at add time", async () => {
		const { rt } = makeRuntime_(vi.fn().mockResolvedValue({ exists: false }));
		const res = await handleToolAction(rt, {
			action: "add",
			path: "/tmp/nonexistent.txt",
			target: "changed",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/absent/i);
	});

	it("accepts target='changed' when path exists at add time", async () => {
		const { rt } = makeRuntime_(
			vi.fn().mockResolvedValue({ exists: true, mtimeNs: 1000n, size: 10 }),
		);
		const res = await handleToolAction(rt, {
			action: "add",
			path: "/tmp/existing.txt",
			target: "changed",
		});
		expect(res.details.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// action: remove
// ---------------------------------------------------------------------------

describe("handleToolAction — remove", () => {
	it("requires watchId", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, { action: "remove" });
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/watchId/i);
	});

	it("returns error for unknown watchId", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, { action: "remove", watchId: "no-such" });
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/not found/i);
	});

	it("removes an existing watch", async () => {
		const { rt } = makeRuntime_();
		await handleToolAction(rt, { action: "add", path: "/tmp/x.txt", target: "exists" });
		const watchId = Object.keys(rt.watches)[0]!;
		const res = await handleToolAction(rt, { action: "remove", watchId });
		expect(res.details.ok).toBe(true);
		expect(rt.watches[watchId]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// action: list
// ---------------------------------------------------------------------------

describe("handleToolAction — list", () => {
	it("returns no-watches message when empty", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, { action: "list" });
		expect(res.details.ok).toBe(true);
		expect(res.details.message).toMatch(/no watches/i);
	});

	it("lists existing watches", async () => {
		const { rt } = makeRuntime_();
		await handleToolAction(rt, { action: "add", path: "/tmp/x.txt", target: "exists" });
		const res = await handleToolAction(rt, { action: "list" });
		expect(res.details.ok).toBe(true);
		expect(res.details.message).toMatch(/\/tmp\/x\.txt/);
	});
});

// ---------------------------------------------------------------------------
// action: pause / resume
// ---------------------------------------------------------------------------

describe("handleToolAction — pause / resume", () => {
	it("pause sets rt.paused=true", async () => {
		const { rt } = makeRuntime_();
		await handleToolAction(rt, { action: "pause" });
		expect(rt.paused).toBe(true);
	});

	it("resume sets rt.paused=false", async () => {
		const { rt } = makeRuntime_();
		rt.paused = true;
		await handleToolAction(rt, { action: "resume" });
		expect(rt.paused).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// action: status
// ---------------------------------------------------------------------------

describe("handleToolAction — status", () => {
	it("returns paused/active state", async () => {
		const { rt } = makeRuntime_();
		rt.paused = true;
		const res = await handleToolAction(rt, { action: "status" });
		expect(res.details.ok).toBe(true);
		expect(res.details.message).toMatch(/paused/i);
	});
});

// ---------------------------------------------------------------------------
// unknown action
// ---------------------------------------------------------------------------

describe("handleToolAction — unknown action", () => {
	it("returns ok=false for unknown action", async () => {
		const { rt } = makeRuntime_();
		const res = await handleToolAction(rt, { action: "foobar" });
		expect(res.details.ok).toBe(false);
	});
});
