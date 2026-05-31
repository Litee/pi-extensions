/**
 * Tests for poller.ts — uses real filesystem via tmp dirs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTimeoutEvent, detectChanges, snapshotPath } from "../src/poller.js";
import type { FsBaseline, FsWatch, TargetCondition } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-system-watcher-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeWatch(filePath: string, target: TargetCondition, baseline?: FsBaseline): FsWatch {
	return {
		watchId: "w1",
		path: filePath,
		target,
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline,
		terminal: false,
		consecutiveErrors: 0,
	};
}

// ---------------------------------------------------------------------------
// snapshotPath
// ---------------------------------------------------------------------------

describe("snapshotPath", () => {
	it("returns {exists:false} when path does not exist", async () => {
		const p = path.join(tmpDir, "nonexistent.txt");
		await expect(snapshotPath(p)).resolves.toEqual({ exists: false });
	});

	it("returns {exists:true, mtimeNs, size} for an existing file", async () => {
		const filePath = path.join(tmpDir, "test.txt");
		fs.writeFileSync(filePath, "hello world");
		const snap = await snapshotPath(filePath);
		expect(snap.exists).toBe(true);
		expect(typeof snap.mtimeNs).toBe("bigint");
		expect(snap.size).toBe(11);
	});

	it("returns {exists:true, mtimeNs, size} for an existing directory", async () => {
		const snap = await snapshotPath(tmpDir);
		expect(snap.exists).toBe(true);
		expect(typeof snap.mtimeNs).toBe("bigint");
		expect(typeof snap.size).toBe("number");
	});

	it("omits mtimeNs/size when path does not exist", async () => {
		const p = path.join(tmpDir, "missing");
		const snap = await snapshotPath(p);
		expect(snap.exists).toBe(false);
		expect(snap.mtimeNs).toBeUndefined();
		expect(snap.size).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// detectChanges — target='exists'
// ---------------------------------------------------------------------------

describe("detectChanges — target='exists' (appear)", () => {
	it("fires exists event when file appears", async () => {
		const filePath = path.join(tmpDir, "new.txt");
		const watch = makeWatch(filePath, "exists", { exists: false });
		// Create file
		fs.writeFileSync(filePath, "hi");
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("exists");
		expect(res.events[0]!.path).toBe(filePath);
		expect(res.observedChange).toBe(true);
		expect(res.newBaseline.exists).toBe(true);
	});

	it("exists event formatted as 'absent → present' [#0001]", async () => {
		const filePath = path.join(tmpDir, "appear.txt");
		const watch = makeWatch(filePath, "exists", { exists: false });
		fs.writeFileSync(filePath, "hi");
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.formatted).toBe(`• ${filePath}: absent → present`);
	});

	it("does not fire while path remains absent", async () => {
		const filePath = path.join(tmpDir, "still-missing.txt");
		const watch = makeWatch(filePath, "exists", { exists: false });
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(0);
		expect(res.observedChange).toBe(false);
	});

	it("does not fire on first poll when baseline is undefined (seed install)", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello");
		const watch = makeWatch(filePath, "exists", undefined);
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(0);
		// newBaseline installed for next poll
		expect(res.newBaseline.exists).toBe(true);
	});

	it("does not re-fire when file already existed at baseline", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "exists", snap); // already exists
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// detectChanges — target='removed'
// ---------------------------------------------------------------------------

describe("detectChanges — target='removed' (disappear)", () => {
	it("fires removed event when file disappears", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "removed", snap);
		// Delete file
		fs.unlinkSync(filePath);
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("removed");
		expect(res.observedChange).toBe(true);
	});

	it("removed event formatted as 'present → absent' [#0001]", async () => {
		const filePath = path.join(tmpDir, "gone.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "removed", snap);
		fs.unlinkSync(filePath);
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.formatted).toBe(`• ${filePath}: present → absent`);
	});

	it("does not fire while file remains present", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "removed", snap);
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(0);
		expect(res.observedChange).toBe(false);
	});

	it("does not fire when file was never there (absent baseline → absent now)", async () => {
		const filePath = path.join(tmpDir, "never.txt");
		const watch = makeWatch(filePath, "removed", { exists: false });
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// detectChanges — target='changed' (modify)
// ---------------------------------------------------------------------------

describe("detectChanges — target='changed' (modify)", () => {
	it("fires changed event when file size increases", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "changed", snap);
		// Write more content → size change
		fs.writeFileSync(filePath, "hello world extended content");
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("changed");
		expect(res.observedChange).toBe(true);
	});

	it("changed event formatted as 'unchanged → changed' [#0001]", async () => {
		const filePath = path.join(tmpDir, "modified.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "changed", snap);
		fs.writeFileSync(filePath, "hello world extended content");
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.formatted).toBe(`• ${filePath}: unchanged → changed`);
	});

	it("fires changed event when file size decreases", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello world extended");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "changed", snap);
		fs.writeFileSync(filePath, "x"); // shrink
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("changed");
	});

	it("does not fire when file is completely unchanged", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "changed", snap);
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(0);
		expect(res.observedChange).toBe(false);
	});

	it("does not fire 'changed' when file disappears (that is 'removed')", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello");
		const snap = await snapshotPath(filePath);
		const watch = makeWatch(filePath, "changed", snap);
		fs.unlinkSync(filePath);
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(0);
		// Observable change still resets the scheduler
		expect(res.observedChange).toBe(true);
	});

	it("fires changed for a directory when its mtime changes (entry added)", async () => {
		const dirPath = path.join(tmpDir, "subdir");
		fs.mkdirSync(dirPath);
		const snap = await snapshotPath(dirPath);
		const watch = makeWatch(dirPath, "changed", snap);
		// Add a file inside → directory mtime changes
		await new Promise<void>((res) => setTimeout(res, 10)); // ensure mtime delta
		fs.writeFileSync(path.join(dirPath, "entry.txt"), "new");
		// Force an mtime update by touching the directory
		const now = new Date();
		fs.utimesSync(dirPath, now, now);
		const res = await detectChanges(watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("changed");
	});
});

// ---------------------------------------------------------------------------
// detectChanges — target='changed' with undefined mtime
// ---------------------------------------------------------------------------

describe("detectChanges — target='changed' with undefined mtimeNs", () => {
	it("fires changed event based on size difference when mtimeNs is undefined in both snapshots", async () => {
		// Cover the second `return true` branch in targetFired (line 80):
		// when mtimeNs is undefined on both sides the mtime check is skipped;
		// the size check then fires because sizes differ.
		const prevBaseline: FsBaseline = { exists: true, size: 100 };
		const watch = makeWatch("/synthetic/file", "changed", prevBaseline);
		const mockSnapshot = (_p: string): Promise<FsBaseline> => Promise.resolve({
			exists: true,
			size: 200,
		});
		const res = await detectChanges(watch, mockSnapshot);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("changed");
		expect(res.observedChange).toBe(true);
	});

	it("does not fire changed when both size and mtime are undefined", async () => {
		// Both undefined → no change can be detected → no event.
		const prevBaseline: FsBaseline = { exists: true };
		const watch = makeWatch("/synthetic/file", "changed", prevBaseline);
		const mockSnapshot = (_p: string): Promise<FsBaseline> => Promise.resolve({
			exists: true,
		});
		const res = await detectChanges(watch, mockSnapshot);
		expect(res.events).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// buildTimeoutEvent
// ---------------------------------------------------------------------------

describe("buildTimeoutEvent", () => {
	it("produces a well-formed timeout event", () => {
		const watch = makeWatch("/some/path/file.txt", "exists");
		const ev = buildTimeoutEvent(watch);
		expect(ev.eventType).toBe("timeout");
		expect(ev.watchId).toBe("w1");
		expect(ev.path).toBe("/some/path/file.txt");
		expect(ev.summary).toMatch(/timed out waiting for 'exists'/);
		expect(ev.formatted).toMatch(/^• /);
		expect(ev.formatted).toMatch(/✗/);
	});

	it("timeout event formatted as '<path>: timed out ✗' [#0001]", () => {
		const watch = makeWatch("/some/path/file.txt", "exists");
		const ev = buildTimeoutEvent(watch);
		expect(ev.formatted).toBe("• /some/path/file.txt: timed out ✗");
	});
});
