import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchWorktrees } from "../src/watcher.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync("/tmp/pi-gwv-watcher-test-");
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("watchWorktrees — edge cases", () => {
	it("empty path list returns a handle with a no-op stop()", async () => {
		const handle = await watchWorktrees([], () => {});
		expect(handle.stop).toBeTypeOf("function");
		expect(() => handle.stop()).not.toThrow();
	});

	it("non-existent directory is skipped gracefully", async () => {
		const handle = await watchWorktrees(["/tmp/__does-not-exist-pi-gwv__"], () => {});
		expect(handle.stop).toBeTypeOf("function");
		expect(() => handle.stop()).not.toThrow();
	});

	it("directory with no .git is skipped gracefully", async () => {
		// tmpDir has no .git subdirectory
		const handle = await watchWorktrees([tmpDir], () => {});
		expect(() => handle.stop()).not.toThrow();
	});

	it("stop() can be called multiple times without throwing", async () => {
		const handle = await watchWorktrees([], () => {});
		handle.stop();
		handle.stop();
	});
});

describe("watchWorktrees — real .git directory", () => {
	it("sets up watchers for a directory whose .git is a real directory", async () => {
		// Create a minimal fake .git directory structure
		const gitDir = join(tmpDir, ".git");
		mkdirSync(gitDir);
		// Create the files watchWorktrees watches: .git/index and .git/HEAD
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(gitDir, "index"), "");

		const handle = await watchWorktrees([tmpDir], () => {});
		// The stop() should cleanly close the watchers
		expect(() => handle.stop()).not.toThrow();
	});

	it("stop() is idempotent after real watchers are set up", async () => {
		const gitDir = join(tmpDir, ".git");
		mkdirSync(gitDir);
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(gitDir, "index"), "");

		const handle = await watchWorktrees([tmpDir], () => {});
		handle.stop();
		// Second stop should not throw (watchers array cleared)
		expect(() => handle.stop()).not.toThrow();
	});
});

describe("watchWorktrees — linked worktree (.git is a file)", () => {
	it("resolves gitdir from a linked-worktree .git file", async () => {
		// Simulate a linked worktree: .git is a file pointing to a real gitdir
		const realGitDir = join(tmpDir, "real.git");
		mkdirSync(realGitDir);
		writeFileSync(join(realGitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(realGitDir, "index"), "");

		const linkedDir = join(tmpDir, "linked");
		mkdirSync(linkedDir);
		// Write the .git file with a gitdir: pointer
		writeFileSync(join(linkedDir, ".git"), `gitdir: ${realGitDir}\n`);

		const handle = await watchWorktrees([linkedDir], () => {});
		expect(() => handle.stop()).not.toThrow();
	});

	it("gracefully skips a .git file with invalid gitdir: content", async () => {
		const badDir = join(tmpDir, "bad");
		mkdirSync(badDir);
		// .git file with malformed content (no 'gitdir:' line)
		writeFileSync(join(badDir, ".git"), "some garbage\n");

		const handle = await watchWorktrees([badDir], () => {});
		expect(() => handle.stop()).not.toThrow();
	});
});
