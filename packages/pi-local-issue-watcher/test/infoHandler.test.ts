import { describe, expect, it, vi } from "vitest";

import {
	type InfoRow,
	buildOpenIssueRows,
	formatPreview,
	formatRowLabel,
	handleInfo,
} from "../src/infoHandler.js";
import type { IssueInfo, Snapshot } from "../src/types.js";

function mkIssue(partial: Partial<IssueInfo> & { issueId: string; skill: string }): IssueInfo {
	return {
		mtimeNs: 0n,
		status: "open",
		title: `issue ${partial.issueId}`,
		description: "",
		comments: [],
		skillVersion: "1.0.0",
		...partial,
	};
}

describe("formatRowLabel", () => {
	it("renders the one-line label as `<skill> #<id>  <title>`", () => {
		const info = mkIssue({ skill: "pi-tool-info", issueId: "0007", title: "do a thing" });
		expect(formatRowLabel(info)).toBe("pi-tool-info #0007  do a thing");
	});

	it("preserves titles verbatim — no truncation at this layer", () => {
		const info = mkIssue({
			skill: "s",
			issueId: "0001",
			title: "this is a very long title that the TUI will need to truncate based on available terminal width",
		});
		expect(formatRowLabel(info)).toContain(
			"this is a very long title that the TUI will need to truncate based on available terminal width",
		);
	});
});

describe("buildOpenIssueRows", () => {
	it("filters out non-open issues by default", () => {
		const snapshot: Snapshot = {
			"/db/skill-a/0001-a.json": mkIssue({ skill: "skill-a", issueId: "0001", status: "open" }),
			"/db/skill-a/0002-b.json": mkIssue({ skill: "skill-a", issueId: "0002", status: "done" }),
			"/db/skill-a/0003-c.json": mkIssue({
				skill: "skill-a",
				issueId: "0003",
				status: "in_progress",
			}),
			"/db/skill-a/0004-d.json": mkIssue({
				skill: "skill-a",
				issueId: "0004",
				status: "wont_fix",
			}),
		};
		const { rows } = buildOpenIssueRows(snapshot);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.info.issueId).toBe("0001");
	});

	it("sorts primary by skill, secondary by issueId", () => {
		const snapshot: Snapshot = {
			"/c": mkIssue({ skill: "zeta", issueId: "0001" }),
			"/d": mkIssue({ skill: "alpha", issueId: "0010" }),
			"/b": mkIssue({ skill: "alpha", issueId: "0002" }),
			"/a": mkIssue({ skill: "alpha", issueId: "0001" }),
		};
		const { rows } = buildOpenIssueRows(snapshot);
		expect(rows.map((r) => `${r.info.skill}#${r.info.issueId}`)).toEqual([
			"alpha#0001",
			"alpha#0002",
			"alpha#0010",
			"zeta#0001",
		]);
	});

	it("id sort is lexicographic on the zero-padded string form (preserves natural 0001 < 0009 < 0010)", () => {
		const snapshot: Snapshot = {
			"/a": mkIssue({ skill: "s", issueId: "0010" }),
			"/b": mkIssue({ skill: "s", issueId: "0009" }),
			"/c": mkIssue({ skill: "s", issueId: "0001" }),
		};
		const { rows } = buildOpenIssueRows(snapshot);
		expect(rows.map((r) => r.info.issueId)).toEqual(["0001", "0009", "0010"]);
	});

	it("`value` is the absolute file path (so the picker can look up the row by path)", () => {
		const snapshot: Snapshot = {
			"/abs/db/skill-a/0001-x.json": mkIssue({ skill: "skill-a", issueId: "0001" }),
		};
		const { rows } = buildOpenIssueRows(snapshot);
		expect(rows[0]!.value).toBe("/abs/db/skill-a/0001-x.json");
	});

	it("summary reports both filtered count and grand total (matches #0022 pinned-status convention)", () => {
		const snapshot: Snapshot = {
			"/a": mkIssue({ skill: "s", issueId: "0001", status: "open" }),
			"/b": mkIssue({ skill: "s", issueId: "0002", status: "open" }),
			"/c": mkIssue({ skill: "s", issueId: "0003", status: "done" }),
			"/d": mkIssue({ skill: "s", issueId: "0004", status: "wont_fix" }),
		};
		const { summary } = buildOpenIssueRows(snapshot);
		expect(summary).toBe("2 open, 4 total");
	});

	it("empty tracker → empty rows, summary '0 open, 0 total'", () => {
		const { rows, summary } = buildOpenIssueRows({});
		expect(rows).toEqual([]);
		expect(summary).toBe("0 open, 0 total");
	});

	it("tracker with no open issues → empty rows, summary reports full total", () => {
		const snapshot: Snapshot = {
			"/a": mkIssue({ skill: "s", issueId: "0001", status: "done" }),
			"/b": mkIssue({ skill: "s", issueId: "0002", status: "done" }),
		};
		const { rows, summary } = buildOpenIssueRows(snapshot);
		expect(rows).toEqual([]);
		expect(summary).toBe("0 open, 2 total");
	});
});

describe("formatPreview", () => {
	it("renders header with skill, id, status, title and labeled description", () => {
		const info = mkIssue({
			skill: "my-skill",
			issueId: "0042",
			status: "open",
			title: "something interesting",
			description: "The actual body of the issue.",
		});
		const out = formatPreview(info);
		expect(out).toContain("my-skill #0042");
		expect(out).toContain("status:  open");
		expect(out).toContain("title:   something interesting");
		expect(out).toContain("description:");
		expect(out).toContain("The actual body of the issue.");
		expect(out).toContain("comments (0):");
		expect(out).toContain("(none)");
		// Visual separators present
		expect(out).toContain("─────");
	});

	it("renders each comment as a bullet with the `text` field", () => {
		const info = mkIssue({
			skill: "s",
			issueId: "0001",
			comments: [
				{ text: "first comment body" },
				{ text: "second comment body" },
			],
		});
		const out = formatPreview(info);
		expect(out).toContain("comments (2):");
		expect(out).toContain("• first comment body");
		expect(out).toContain("• second comment body");
	});

	it("renders author and timestamp header above each comment when present (issue #0001)", () => {
		const info = mkIssue({
			skill: "s",
			issueId: "0001",
			comments: [
				{ text: "fixed it", author: "alice", created_at: "2026-05-07T01:44:00Z" },
			],
		});
		const out = formatPreview(info);
		expect(out).toContain("[2026-05-07T01:44:00Z] @alice");
		expect(out).toContain("• fixed it");
		// Header line must appear before the bullet line
		expect(out.indexOf("@alice")).toBeLessThan(out.indexOf("• fixed it"));
	});

	it("falls back to `body` when `text` is missing, and to JSON when both are missing", () => {
		const info = mkIssue({
			skill: "s",
			issueId: "0001",
			comments: [
				{ body: "body-field content" },
				{ author: "someone", stamp: 123 },
			],
		});
		const out = formatPreview(info);
		expect(out).toContain("body-field content");
		// The third fallback is JSON.stringify of the whole comment.
		expect(out).toContain('"author":"someone"');
		expect(out).toContain('"stamp":123');
	});

	it("renders '(none)' for an empty description", () => {
		const info = mkIssue({
			skill: "s",
			issueId: "0001",
			description: "",
		});
		const out = formatPreview(info);
		// Description section should contain the placeholder.
		const descIdx = out.indexOf("description:");
		const commentsIdx = out.indexOf("comments (");
		expect(out.slice(descIdx, commentsIdx)).toContain("(none)");
	});

	it("renders '(none)' for a description that is only whitespace", () => {
		const info = mkIssue({
			skill: "s",
			issueId: "0001",
			description: "   \n\n   ",
		});
		const out = formatPreview(info);
		const descIdx = out.indexOf("description:");
		const commentsIdx = out.indexOf("comments (");
		expect(out.slice(descIdx, commentsIdx)).toContain("(none)");
	});
});

describe("handleInfo", () => {
	it("calls the scanner with the supplied dbRoot and hands the rows to the picker", async () => {
		const snapshot: Snapshot = {
			"/a": mkIssue({ skill: "s", issueId: "0001", status: "open" }),
		};
		const scan = vi.fn(() => snapshot);
		const picker = vi.fn(async (_args: { rows: InfoRow[]; summary: string }) => {
			/* consumed by assertions below */
		});
		await handleInfo({ dbRoot: "/db/root", scan, picker });
		expect(scan).toHaveBeenCalledWith("/db/root");
		expect(picker).toHaveBeenCalledTimes(1);
		const call = picker.mock.calls[0]![0];
		expect(call.rows).toHaveLength(1);
		expect(call.rows[0]!.value).toBe("/a");
		expect(call.summary).toBe("1 open, 1 total");
	});

	it("propagates picker rejections (so the command surfaces TUI errors)", async () => {
		const scan = vi.fn(() => ({}));
		const picker = vi.fn(async () => {
			throw new Error("TUI crashed");
		});
		await expect(
			handleInfo({ dbRoot: "/db/root", scan, picker }),
		).rejects.toThrow("TUI crashed");
	});

	it("awaits the picker — handleInfo does not resolve until the picker resolves", async () => {
		const scan = vi.fn(() => ({}));
		let resolvePicker: (() => void) | undefined;
		const picker = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolvePicker = r;
				}),
		);
		let handleResolved = false;
		const handlePromise = handleInfo({ dbRoot: "/db/root", scan, picker }).then(() => {
			handleResolved = true;
		});
		// Give the microtask queue a tick so any sync resolution would land.
		await Promise.resolve();
		expect(handleResolved).toBe(false);
		resolvePicker!();
		await handlePromise;
		expect(handleResolved).toBe(true);
	});
});
