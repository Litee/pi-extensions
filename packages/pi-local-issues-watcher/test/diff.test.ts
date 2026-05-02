import { describe, expect, it } from "vitest";

import { diffSnapshots, changedPaths, formatChange } from "../src/diff.js";
import type { IssueInfo, Snapshot } from "../src/types.js";

/**
 * Build a minimal `IssueInfo`. Only fields a given test cares about need to be
 * passed explicitly; the rest default to stable placeholders so change
 * detection tests don't have to restate unrelated data.
 */
function info(overrides: Partial<IssueInfo> & { mtimeNs: bigint }): IssueInfo {
	return {
		mtimeNs: overrides.mtimeNs,
		issueId: overrides.issueId ?? "0001",
		status: overrides.status ?? "open",
		title: overrides.title ?? "A title",
		description: overrides.description ?? "A description",
		comments: overrides.comments ?? [],
		skill: overrides.skill ?? "my-skill",
		skillVersion: overrides.skillVersion ?? "1.0.0",
	};
}

const P1 = "/db/my-skill/0001-a.json";
const P2 = "/db/my-skill/0002-b.json";

describe("diffSnapshots", () => {
	it("returns no changes when both snapshots are equal", () => {
		const s: Snapshot = { [P1]: info({ mtimeNs: 10n }) };
		expect(diffSnapshots(s, s)).toEqual([]);
	});

	it("emits a 'new' change for paths added in new", () => {
		const old: Snapshot = {};
		const next: Snapshot = {
			[P1]: info({ mtimeNs: 10n, issueId: "0001", title: "Brand new", status: "open", skill: "my-skill" }),
		};
		const changes = diffSnapshots(old, next);
		expect(changes).toEqual([
			{
				kind: "new",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
				title: "Brand new",
				status: "open",
			},
		]);
	});

	it("emits a 'removed' change for paths present only in old", () => {
		const old: Snapshot = { [P1]: info({ mtimeNs: 10n }) };
		const next: Snapshot = {};
		expect(diffSnapshots(old, next)).toEqual([
			{ kind: "removed", path: P1, fileName: "0001-a.json" },
		]);
	});

	it("does not emit changes when mtime is unchanged (even if content differs)", () => {
		// Mirrors watch_issues.py: if mtime_ns is equal, the comparison short-
		// circuits — we trust the filesystem that nothing changed.
		const old: Snapshot = { [P1]: info({ mtimeNs: 10n, title: "Old" }) };
		const next: Snapshot = { [P1]: info({ mtimeNs: 10n, title: "New-but-ignored" }) };
		expect(diffSnapshots(old, next)).toEqual([]);
	});

	it("emits a 'status_changed' change when status differs and mtime differs", () => {
		const old: Snapshot = { [P1]: info({ mtimeNs: 10n, status: "open" }) };
		const next: Snapshot = { [P1]: info({ mtimeNs: 20n, status: "done" }) };
		expect(diffSnapshots(old, next)).toEqual([
			{
				kind: "status_changed",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
				from: "open",
				to: "done",
			},
		]);
	});

	it("emits 'title_changed' and 'description_updated' when those fields differ", () => {
		const old: Snapshot = {
			[P1]: info({ mtimeNs: 10n, title: "Old title", description: "Old desc" }),
		};
		const next: Snapshot = {
			[P1]: info({ mtimeNs: 20n, title: "New title", description: "New desc" }),
		};
		const kinds = diffSnapshots(old, next).map((c) => c.kind);
		expect(kinds).toContain("title_changed");
		expect(kinds).toContain("description_updated");
	});

	it("emits one 'comment_added' per new comment with 80-char preview truncation", () => {
		const longText = "x".repeat(100);
		const old: Snapshot = {
			[P1]: info({ mtimeNs: 10n, comments: [{ text: "first" }] }),
		};
		const next: Snapshot = {
			[P1]: info({
				mtimeNs: 20n,
				comments: [{ text: "first" }, { text: "short one" }, { text: longText }],
			}),
		};
		const changes = diffSnapshots(old, next).filter((c) => c.kind === "comment_added");
		expect(changes).toHaveLength(2);
		expect(changes[0]).toMatchObject({ kind: "comment_added", preview: "short one" });
		expect(changes[1]).toMatchObject({
			kind: "comment_added",
			preview: "x".repeat(80) + "...",
		});
	});

	it("emits a 'comment_removed' change when a comment disappears", () => {
		const old: Snapshot = {
			[P1]: info({ mtimeNs: 10n, comments: [{ text: "a" }, { text: "b" }] }),
		};
		const next: Snapshot = {
			[P1]: info({ mtimeNs: 20n, comments: [{ text: "a" }] }),
		};
		const kinds = diffSnapshots(old, next).map((c) => c.kind);
		expect(kinds).toContain("comment_removed");
	});

	it("can emit multiple change kinds for the same issue in a single diff", () => {
		const old: Snapshot = {
			[P1]: info({
				mtimeNs: 10n,
				status: "open",
				title: "Old",
				description: "Old desc",
				comments: [],
			}),
		};
		const next: Snapshot = {
			[P1]: info({
				mtimeNs: 20n,
				status: "in_progress",
				title: "New",
				description: "New desc",
				comments: [{ text: "just posted" }],
			}),
		};
		const kinds = diffSnapshots(old, next).map((c) => c.kind).sort();
		expect(kinds).toEqual([
			"comment_added",
			"description_updated",
			"status_changed",
			"title_changed",
		]);
	});

	it("handles the new-and-removed combination cleanly (both kinds, no cross-talk)", () => {
		const old: Snapshot = { [P1]: info({ mtimeNs: 10n, issueId: "0001" }) };
		const next: Snapshot = { [P2]: info({ mtimeNs: 10n, issueId: "0002", title: "Fresh" }) };
		const changes = diffSnapshots(old, next);
		expect(changes).toHaveLength(2);
		expect(changes.map((c) => c.kind).sort()).toEqual(["new", "removed"]);
	});
});

describe("changedPaths", () => {
	it("returns the union of added and modified paths, excluding removed", () => {
		const old: Snapshot = {
			[P1]: info({ mtimeNs: 10n }),
			[P2]: info({ mtimeNs: 20n }),
		};
		const next: Snapshot = {
			[P1]: info({ mtimeNs: 10n }), // unchanged
			// P2 removed
			"/db/my-skill/0003-c.json": info({ mtimeNs: 30n }), // added
		};
		// Also demo modified in a separate old/new pair:
		const old2: Snapshot = { [P1]: info({ mtimeNs: 10n }) };
		const new2: Snapshot = { [P1]: info({ mtimeNs: 99n }) };

		expect(changedPaths(old, next)).toEqual(new Set(["/db/my-skill/0003-c.json"]));
		expect(changedPaths(old2, new2)).toEqual(new Set([P1]));
	});
});

describe("formatChange", () => {
	it("produces a stable, human-readable string for each change kind", () => {
		expect(
			formatChange({
				kind: "new",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
				title: "Do the thing",
				status: "open",
			}),
		).toContain("new issue");
		expect(
			formatChange({ kind: "removed", path: P1, fileName: "0001-a.json" }),
		).toContain("removed");
		expect(
			formatChange({
				kind: "status_changed",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
				from: "open",
				to: "done",
			}),
		).toMatch(/open.*->.*done/);
		expect(
			formatChange({
				kind: "comment_added",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
				preview: "hello world",
			}),
		).toContain("hello world");
	});

	it("renders title_changed, description_updated, and comment_removed variants", () => {
		expect(
			formatChange({
				kind: "title_changed",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
				to: "new title",
			}),
		).toMatch(/title changed to "new title"/);
		expect(
			formatChange({
				kind: "description_updated",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
			}),
		).toMatch(/description updated/);
		expect(
			formatChange({
				kind: "comment_removed",
				path: P1,
				issueId: "0001",
				skill: "my-skill",
			}),
		).toMatch(/comment removed/);
	});
});
