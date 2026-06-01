/**
 * Tests for src/daemon/daemon-core.ts
 *
 * DaemonCore is a pure router with injected deps. All deps are stubbed here.
 * No real sockets, no real timers.
 */

import { describe, it, expect, vi } from "vitest";

import { DaemonCore, type DaemonCoreDeps } from "../src/daemon/daemon-core.js";

// ---------------------------------------------------------------------------
// Helper: build minimal deps
// ---------------------------------------------------------------------------

interface ScheduledCall {
	ms: number;
	fn: () => void;
	cancel: () => void;
}

function makeDeps(overrides?: Partial<DaemonCoreDeps>): {
	deps: DaemonCoreDeps;
	addonWritten: unknown[];
	socketWritten: Map<string, unknown[]>;
	scheduled: ScheduledCall[];
	flushScheduled: () => void;
} {
	const addonWritten: unknown[] = [];
	const socketWritten = new Map<string, unknown[]>();
	const scheduled: ScheduledCall[] = [];

	let t = 1_000_000; // start time

	const deps: DaemonCoreDeps = {
		addonWriter: (msg) => {
			addonWritten.push(msg);
		},
		socketWriter: (socketId, msg) => {
			if (!socketWritten.has(socketId)) socketWritten.set(socketId, []);
			socketWritten.get(socketId)!.push(msg);
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		now: () => t,
		schedule: (ms, fn) => {
			let cancelled = false;
			const cancel = () => {
				cancelled = true;
			};
			scheduled.push({
				ms,
				fn: () => {
					if (!cancelled) fn();
				},
				cancel,
			});
			return cancel;
		},
		...overrides,
	};

	function flushScheduled() {
		// Advance time and fire all scheduled callbacks
		t += 100_000;
		const toRun = [...scheduled];
		scheduled.length = 0;
		for (const s of toRun) s.fn();
	}

	return { deps, addonWritten, socketWritten, scheduled, flushScheduled };
}

// ---------------------------------------------------------------------------
// status op — answered locally
// ---------------------------------------------------------------------------

describe("DaemonCore — status op (local answer)", () => {
	it("responds to status without touching the addon writer", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "status" });

		expect(addonWritten).toHaveLength(0);
		const replies = socketWritten.get("s1") ?? [];
		expect(replies).toHaveLength(1);
		const reply = replies[0] as { id: string; ok: boolean; result: { daemon: { pid: number; uptimeSec: number; version: string }; addon: { connected: boolean } } };
		expect(reply.id).toBe("r1");
		expect(reply.ok).toBe(true);
		expect(reply.result.daemon.pid).toBeGreaterThan(0);
		expect(typeof reply.result.daemon.uptimeSec).toBe("number");
		expect(typeof reply.result.daemon.version).toBe("string");
		expect(typeof reply.result.addon.connected).toBe("boolean");
	});

	it("reports addon not connected when addonWriter is null", () => {
		const { deps, socketWritten } = makeDeps({ addonWriter: null });
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "status" });
		const reply = (socketWritten.get("s1") ?? [])[0] as { result: { addon: { connected: boolean } } };
		expect(reply.result.addon.connected).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ADDON_NOT_CONNECTED
// ---------------------------------------------------------------------------

describe("DaemonCore — ADDON_NOT_CONNECTED", () => {
	it("returns ADDON_NOT_CONNECTED for listTabs when addonWriter is null", () => {
		const { deps, socketWritten } = makeDeps({ addonWriter: null });
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });
		const reply = (socketWritten.get("s1") ?? [])[0] as { ok: boolean; error: { code: string } };
		expect(reply.ok).toBe(false);
		expect(reply.error.code).toBe("ADDON_NOT_CONNECTED");
	});

	it("returns ADDON_NOT_CONNECTED for getTabContent when addonWriter is null", () => {
		const { deps, socketWritten } = makeDeps({ addonWriter: null });
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", {
			id: "r2",
			op: "getTabContent",
			params: { tabId: 5, offset: 0 },
		});
		const reply = (socketWritten.get("s1") ?? [])[0] as { ok: boolean; error: { code: string } };
		expect(reply.ok).toBe(false);
		expect(reply.error.code).toBe("ADDON_NOT_CONNECTED");
	});

	it("returns ADDON_NOT_CONNECTED for ping when addonWriter is null", () => {
		const { deps, socketWritten } = makeDeps({ addonWriter: null });
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r3", op: "ping" });
		const reply = (socketWritten.get("s1") ?? [])[0] as { ok: boolean; error: { code: string } };
		expect(reply.ok).toBe(false);
		expect(reply.error.code).toBe("ADDON_NOT_CONNECTED");
	});
});

// ---------------------------------------------------------------------------
// Forward + reply routing
// ---------------------------------------------------------------------------

describe("DaemonCore — forward to addon and reply to socket", () => {
	it("forwards a listTabs request to the addon with a correlationId", () => {
		const { deps, addonWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });
		expect(addonWritten).toHaveLength(1);
		const msg = addonWritten[0] as { correlationId: string; op: string };
		expect(typeof msg.correlationId).toBe("string");
		expect(msg.op).toBe("listTabs");
	});

	it("routes addon reply back to originating socket", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });

		const sentToAddon = addonWritten[0] as { correlationId: string };
		const correlationId = sentToAddon.correlationId;

		core.handleAddonReply({
			correlationId,
			ok: true,
			result: { tabs: [{ id: 1, url: "https://example.com" }] },
		});

		const replies = socketWritten.get("s1") ?? [];
		expect(replies).toHaveLength(1);
		const reply = replies[0] as { id: string; ok: boolean; result: unknown };
		expect(reply.id).toBe("r1");
		expect(reply.ok).toBe(true);
	});

	it("does NOT route to a different socket", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "ping" });
		core.handleSocketRequest("s2", { id: "r2", op: "ping" });

		const msgs = addonWritten as Array<{ correlationId: string }>;
		const msg2 = msgs[1];
		if (!msg2) throw new Error('Expected at least 2 addon messages');

		// Reply for s2's request
		core.handleAddonReply({ correlationId: msg2.correlationId, ok: true, result: { addon: "ready" } });

		// s1 should have NO reply yet
		expect(socketWritten.get("s1") ?? []).toHaveLength(0);
		// s2 should have the reply
		expect(socketWritten.get("s2") ?? []).toHaveLength(1);
	});

	it("forwards getTabContent params to addon", () => {
		const { deps, addonWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", {
			id: "r1",
			op: "getTabContent",
			params: { tabId: 42, offset: 1000 },
		});
		const msg = addonWritten[0] as { op: string; params: { tabId: number; offset: number } };
		expect(msg.op).toBe("getTabContent");
		expect(msg.params.tabId).toBe(42);
		expect(msg.params.offset).toBe(1000);
	});
});

// ---------------------------------------------------------------------------
// Timeout / ADDON_TIMEOUT
// ---------------------------------------------------------------------------

describe("DaemonCore — ADDON_TIMEOUT", () => {
	it("sends ADDON_TIMEOUT when scheduled deadline fires", () => {
		const { deps, socketWritten, flushScheduled } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });

		// No addon reply — fire all scheduled callbacks
		flushScheduled();

		const replies = socketWritten.get("s1") ?? [];
		expect(replies).toHaveLength(1);
		const reply = replies[0] as { ok: boolean; error: { code: string } };
		expect(reply.ok).toBe(false);
		expect(reply.error.code).toBe("ADDON_TIMEOUT");
	});

	it("does NOT fire timeout after addon already replied", () => {
		const { deps, addonWritten, socketWritten, flushScheduled } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "ping" });

		const { correlationId } = addonWritten[0] as { correlationId: string };
		core.handleAddonReply({ correlationId, ok: true, result: { addon: "ready" } });

		// Now fire timeout — should be a no-op (cancel was called)
		flushScheduled();

		const replies = socketWritten.get("s1") ?? [];
		// Only the one real reply, no timeout error
		expect(replies).toHaveLength(1);
		expect((replies[0] as { ok: boolean }).ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// onSocketClosed
// ---------------------------------------------------------------------------

describe("DaemonCore — onSocketClosed", () => {
	it("drops pending requests when socket closes (no reply sent)", () => {
		const { deps, addonWritten, socketWritten, flushScheduled } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });

		// Socket closes before addon replies
		core.onSocketClosed("s1");

		// Addon reply arrives late — should be silently dropped
		const { correlationId } = addonWritten[0] as { correlationId: string };
		core.handleAddonReply({
			correlationId,
			ok: true,
			result: { tabs: [] },
		});

		// Timeout fires too
		flushScheduled();

		// socketWriter should not have been called
		expect(socketWritten.get("s1") ?? []).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Multi-socket concurrency
// ---------------------------------------------------------------------------

describe("DaemonCore — multi-socket concurrency", () => {
	it("handles three concurrent sockets with independent replies", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);

		core.handleSocketRequest("sA", { id: "rA", op: "listTabs" });
		core.handleSocketRequest("sB", { id: "rB", op: "ping" });
		core.handleSocketRequest("sC", { id: "rC", op: "listTabs" });

		expect(addonWritten).toHaveLength(3);

		const msgs = addonWritten as Array<{ correlationId: string }>;

		// Reply out of order: C, A, B
		core.handleAddonReply({ correlationId: msgs[2]!.correlationId, ok: true, result: { tabs: [] } });
		core.handleAddonReply({ correlationId: msgs[0]!.correlationId, ok: true, result: { tabs: [{ id: 1 }] } });
		core.handleAddonReply({ correlationId: msgs[1]!.correlationId, ok: true, result: { addon: "ready" } });

		expect((socketWritten.get("sA") ?? [])).toHaveLength(1);
		expect((socketWritten.get("sB") ?? [])).toHaveLength(1);
		expect((socketWritten.get("sC") ?? [])).toHaveLength(1);

		const replyA = (socketWritten.get("sA") ?? [])[0] as { id: string };
		expect(replyA.id).toBe("rA");
	});

	it("status op on multiple sockets is answered independently", () => {
		const { deps, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);

		core.handleSocketRequest("s1", { id: "r1", op: "status" });
		core.handleSocketRequest("s2", { id: "r2", op: "status" });

		expect((socketWritten.get("s1") ?? [])).toHaveLength(1);
		expect((socketWritten.get("s2") ?? [])).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Error reply propagation
// ---------------------------------------------------------------------------

describe("DaemonCore — error reply propagation", () => {
	it("propagates addon error reply back to socket", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "getTabContent", params: { tabId: 5, offset: 0 } });

		const { correlationId } = addonWritten[0] as { correlationId: string };
		core.handleAddonReply({
			correlationId,
			ok: false,
			error: { code: "TAB_NOT_FOUND", message: "Tab 5 not found" },
		});

		const reply = (socketWritten.get("s1") ?? [])[0] as { ok: boolean; error: { code: string; message: string } };
		expect(reply.ok).toBe(false);
		expect(reply.error.code).toBe("TAB_NOT_FOUND");
		expect(reply.error.message).toBe("Tab 5 not found");
	});
});

// ---------------------------------------------------------------------------
// Invalid socket requests (missing id or op)
// ---------------------------------------------------------------------------

describe("DaemonCore — invalid socket requests", () => {
	it("warns and returns when id is missing", () => {
		const { deps, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { op: "listTabs" }); // no id
		expect(deps.logger.warn).toHaveBeenCalled();
		expect(socketWritten.get("s1") ?? []).toHaveLength(0);
	});

	it("warns and returns when op is missing", () => {
		const { deps, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1" }); // no op
		expect(deps.logger.warn).toHaveBeenCalled();
		expect(socketWritten.get("s1") ?? []).toHaveLength(0);
	});

	it("returns early for non-object raw input", () => {
		const { deps, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", null);
		expect(socketWritten.get("s1") ?? []).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// handleAddonReply — edge cases
// ---------------------------------------------------------------------------

describe("DaemonCore — handleAddonReply edge cases", () => {
	it("returns early for null raw input", () => {
		const { deps, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleAddonReply(null);
		expect(socketWritten.size).toBe(0);
	});

	it("returns early when correlationId is missing", () => {
		const { deps, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleAddonReply({ ok: true, result: {} }); // no correlationId
		expect(socketWritten.size).toBe(0);
	});

	it("handles ok:false reply from addon without error field", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		// Queue a request first
		core.handleSocketRequest("s1", { id: "r1", op: "getTabContent", params: { tabId: 5, offset: 0 } });
		const addonMsg = addonWritten[0] as { correlationId: string };
		// Reply with ok:false but no error field (covers else branch + ?? fallback)
		core.handleAddonReply({ correlationId: addonMsg.correlationId, ok: false });
		const reply = (socketWritten.get("s1") ?? [])[0] as { ok: boolean; error: { code: string } };
		expect(reply.ok).toBe(false);
		expect(reply.error.code).toBe("INTERNAL");
	});
});

// ---------------------------------------------------------------------------
// onSocketClosed — cleans up only matching socket's pending requests
// ---------------------------------------------------------------------------

describe("DaemonCore — onSocketClosed", () => {
	it("cancels pending requests for the closed socket", () => {
		const { deps, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });
		core.onSocketClosed("s1");
		// After closing, no reply should arrive even if addon responds
		expect(socketWritten.get("s1") ?? []).toHaveLength(0);
	});

	it("does not affect pending requests for a different socket", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });
		core.handleSocketRequest("s2", { id: "r2", op: "listTabs" });
		core.onSocketClosed("s1"); // close only s1
		// s2's request should still be pending — reply to s2
		const s2msg = (addonWritten[1] ?? addonWritten[0]) as { correlationId: string };
		core.handleAddonReply({ correlationId: s2msg.correlationId, ok: true, result: { tabs: [] } });
		expect(socketWritten.get("s2") ?? []).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// status lastSeenSec — non-null branch
// ---------------------------------------------------------------------------

describe("DaemonCore — status with addon lastSeenSec", () => {
	it("returns numeric lastSeenSec after addon has replied (non-null branch)", () => {
		const { deps, addonWritten, socketWritten } = makeDeps();
		const core = new DaemonCore(deps);
		// Queue a request and have the addon reply — sets _addonLastSeen
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });
		const addonMsg = addonWritten[0] as { correlationId: string };
		core.handleAddonReply({ correlationId: addonMsg.correlationId, ok: true, result: { tabs: [] } });
		// Now request status — lastSeenSec should be a number
		core.handleSocketRequest("s2", { id: "r2", op: "status" });
		const statusReply = (socketWritten.get("s2") ?? [])[0] as {
			result: { addon: { lastSeenSec: number | null } };
		};
		expect(typeof statusReply.result.addon.lastSeenSec).toBe("number");
	});
});

// ---------------------------------------------------------------------------
// Unknown op uses DEADLINE_MS fallback (20_000)
// ---------------------------------------------------------------------------

describe("DaemonCore — unknown op uses deadline fallback", () => {
	it("forwards unknown op with 20_000ms deadline (DEADLINE_MS ?? branch)", () => {
		const { deps, addonWritten } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "customOp" }); // not in DEADLINE_MS
		// Should have been forwarded to addon
		expect(addonWritten).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Scheduled timeout fires after pending is already gone
// ---------------------------------------------------------------------------

describe("DaemonCore — timeout fires after pending already resolved", () => {
	it("timeout is a no-op when pending already removed by addon reply", () => {
		const { deps, addonWritten, socketWritten, flushScheduled } = makeDeps();
		const core = new DaemonCore(deps);
		core.handleSocketRequest("s1", { id: "r1", op: "listTabs" });
		const addonMsg = addonWritten[0] as { correlationId: string };
		// Addon replies — removes the pending entry
		core.handleAddonReply({ correlationId: addonMsg.correlationId, ok: true, result: { tabs: [] } });
		// Now fire the scheduled timeout — pending is gone, should be a no-op
		flushScheduled();
		// Only 1 reply (from addon reply), timeout fires silently
		expect(socketWritten.get("s1") ?? []).toHaveLength(1);
	});
});
