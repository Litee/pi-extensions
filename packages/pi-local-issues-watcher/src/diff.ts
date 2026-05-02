import { basename } from "node:path";

import type { Snapshot } from "./types.js";

/** Max length of a comment preview before it is truncated with "...". */
export const COMMENT_PREVIEW_LEN = 80;

/**
 * A single observed difference between two snapshots. `path` is always the
 * absolute filesystem path of the issue file so callers can load the full
 * JSON on demand when they want to embed it in a chat message.
 */
export type Change =
	| {
			kind: "new";
			path: string;
			issueId: string;
			skill: string;
			title: string;
			status: string;
	  }
	| { kind: "removed"; path: string; fileName: string }
	| {
			kind: "status_changed";
			path: string;
			issueId: string;
			skill: string;
			from: string;
			to: string;
	  }
	| {
			kind: "title_changed";
			path: string;
			issueId: string;
			skill: string;
			to: string;
	  }
	| {
			kind: "description_updated";
			path: string;
			issueId: string;
			skill: string;
	  }
	| {
			kind: "comment_added";
			path: string;
			issueId: string;
			skill: string;
			preview: string;
	  }
	| {
			kind: "comment_removed";
			path: string;
			issueId: string;
			skill: string;
	  };

/**
 * Compare two snapshots and return every observed change.
 *
 * Mirrors `watch_issues.py::_diff_snapshots`:
 *  - Paths in `next` but not `old` → "new"
 *  - Paths in `old` but not `next` → "removed"
 *  - Paths in both: short-circuit on equal mtime; otherwise compare status,
 *    title, description, and comment list length for individual change kinds.
 */
export function diffSnapshots(old: Snapshot, next: Snapshot): Change[] {
	const changes: Change[] = [];
	const oldPaths = new Set(Object.keys(old));
	const nextPaths = new Set(Object.keys(next));

	// New — sorted for deterministic test ordering.
	const added = [...nextPaths].filter((p) => !oldPaths.has(p)).sort();
	for (const path of added) {
		const n = next[path]!;
		changes.push({
			kind: "new",
			path,
			issueId: n.issueId,
			skill: n.skill,
			title: n.title,
			status: n.status,
		});
	}

	// Removed — sorted too.
	const removed = [...oldPaths].filter((p) => !nextPaths.has(p)).sort();
	for (const path of removed) {
		changes.push({ kind: "removed", path, fileName: basename(path) });
	}

	// Modified.
	const intersecting = [...oldPaths].filter((p) => nextPaths.has(p)).sort();
	for (const path of intersecting) {
		const o = old[path]!;
		const n = next[path]!;
		// Fast path: identical mtime means "we trust the filesystem, nothing
		// changed". This matches the Python watcher exactly.
		if (o.mtimeNs === n.mtimeNs) continue;

		if (o.status !== n.status) {
			changes.push({
				kind: "status_changed",
				path,
				issueId: n.issueId,
				skill: n.skill,
				from: o.status,
				to: n.status,
			});
		}

		const oldCount = o.comments.length;
		const newCount = n.comments.length;
		if (newCount > oldCount) {
			for (const c of n.comments.slice(oldCount)) {
				const text = typeof c.text === "string" ? c.text : "";
				const preview =
					text.length > COMMENT_PREVIEW_LEN
						? `${text.slice(0, COMMENT_PREVIEW_LEN)}...`
						: text;
				changes.push({
					kind: "comment_added",
					path,
					issueId: n.issueId,
					skill: n.skill,
					preview,
				});
			}
		} else if (newCount < oldCount) {
			changes.push({
				kind: "comment_removed",
				path,
				issueId: n.issueId,
				skill: n.skill,
			});
		}

		if (o.description !== n.description) {
			changes.push({
				kind: "description_updated",
				path,
				issueId: n.issueId,
				skill: n.skill,
			});
		}
		if (o.title !== n.title) {
			changes.push({
				kind: "title_changed",
				path,
				issueId: n.issueId,
				skill: n.skill,
				to: n.title,
			});
		}
	}

	return changes;
}

/**
 * Paths that were added or had their mtime change between snapshots. Useful
 * for deciding which full issue JSON blobs to embed in chat-message details.
 * Removed paths are intentionally excluded — there is nothing left on disk
 * to attach.
 */
export function changedPaths(old: Snapshot, next: Snapshot): Set<string> {
	const out = new Set<string>();
	for (const p of Object.keys(next)) {
		if (!(p in old)) out.add(p);
		else if (old[p]!.mtimeNs !== next[p]!.mtimeNs) out.add(p);
	}
	return out;
}

/** Stable human-readable rendering of a single change — for chat bullets. */
export function formatChange(c: Change): string {
	switch (c.kind) {
		case "new":
			return `new issue #${c.issueId} (${c.skill}): "${c.title}" [${c.status}]`;
		case "removed":
			return `removed issue file ${c.fileName}`;
		case "status_changed":
			return `issue #${c.issueId} (${c.skill}) status changed: ${c.from} -> ${c.to}`;
		case "title_changed":
			return `issue #${c.issueId} (${c.skill}) title changed to "${c.to}"`;
		case "description_updated":
			return `issue #${c.issueId} (${c.skill}) description updated`;
		case "comment_added":
			return `new comment on issue #${c.issueId} (${c.skill}): "${c.preview}"`;
		case "comment_removed":
			return `issue #${c.issueId} (${c.skill}) — comment removed`;
	}
}
