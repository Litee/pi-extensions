import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { IssueInfo, Snapshot } from "./types.js";

/**
 * Filename gate: exactly `NNNN-<lowercase-slug>.json`, matching the upstream
 * `skill_issues_cli.py` storage convention (zero-padded id + hyphenated slug,
 * lowercase). Anything else is ignored so we don't pick up README.md, edit
 * backups, or malformed entries.
 */
const ISSUE_FNAME_RE = /^\d{4}-[a-z0-9-]+\.json$/;

/**
 * Scan all issue JSON files under a local-skill-issues-tracker database root.
 *
 * Layout expected on disk:
 *   <dbRoot>/<skill-name>/<NNNN>-<slug>.json
 *
 * Returns an empty snapshot if `dbRoot` is missing or not a directory. Files
 * that fail to parse are skipped (never throw) — the watcher must stay alive
 * across transient writer/reader races.
 *
 * When `previous` is provided, transient per-file read / stat / parse failures
 * fall back to the entry in `previous[filePath]` (if any), instead of
 * dropping the file. This prevents the spurious `removed -> new` churn that
 * otherwise fires when a poll catches the upstream `skill_issues_cli.py`
 * mid-write (see issue #0003).
 *
 * When `onError(filePath, err)` is provided, it is invoked for every skipped
 * file (read failure or parse failure). The callback must not throw. When
 * absent, failures are dropped silently — the scanner never calls
 * `console.warn` / `console.error`, because pi's TUI intercepts stdout/stderr
 * and leaks those lines into the visible transcript (see issue #0029).
 */
export function scanIssueFiles(
	dbRoot: string,
	previous?: Snapshot,
	onError?: (filePath: string, err: unknown) => void,
): Snapshot {
	const snapshot: Snapshot = {};

	let topEntries;
	try {
		topEntries = readdirSync(dbRoot, { withFileTypes: true });
	} catch {
		return snapshot;
	}

	// Sort for deterministic iteration order (helps test assertions).
	topEntries.sort((a, b) => a.name.localeCompare(b.name));

	for (const skillEntry of topEntries) {
		if (!skillEntry.isDirectory()) continue;
		const skillDir = join(dbRoot, skillEntry.name);

		let children;
		try {
			children = readdirSync(skillDir, { withFileTypes: true });
		} catch {
			continue;
		}
		children.sort((a, b) => a.name.localeCompare(b.name));

		for (const file of children) {
			if (!file.isFile()) continue;
			if (!ISSUE_FNAME_RE.test(file.name)) continue;
			const filePath = join(skillDir, file.name);

			let stat;
			let raw: string;
			try {
				stat = statSync(filePath, { bigint: true });
				raw = readFileSync(filePath, "utf8");
			} catch (exc) {
				// #0029: swallow any throw from the caller's `onError` so one
				// buggy callback cannot wedge the poll loop on the first bad
				// file of the session. The scanner's job is to report, not to
				// be the place where errors in error handlers bubble up.
				try {
					onError?.(filePath, exc);
				} catch {
					/* noop — see comment */
				}
				const carried = previous?.[filePath];
				if (carried !== undefined) snapshot[filePath] = carried;
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (exc) {
				// #0029: same rationale as the read-failure branch above —
				// guard onError against throwing.
				try {
					onError?.(filePath, exc);
				} catch {
					/* noop — see comment */
				}
				const carried = previous?.[filePath];
				if (carried !== undefined) snapshot[filePath] = carried;
				continue;
			}

			const info = parsed as Record<string, unknown>;
			const entry: IssueInfo = {
				mtimeNs: stat.mtimeNs,
				issueId: typeof info["id"] === "string" ? info["id"] : "",
				status: typeof info["status"] === "string" ? info["status"] : "",
				title: typeof info["title"] === "string" ? info["title"] : "",
				description: typeof info["description"] === "string" ? info["description"] : "",
				comments: Array.isArray(info["comments"])
					? (info["comments"] as IssueInfo["comments"])
					: [],
				skill: typeof info["skill"] === "string" ? info["skill"] : "",
				skillVersion: typeof info["skill_version"] === "string" ? info["skill_version"] : "",
			};
			snapshot[filePath] = entry;
		}
	}

	return snapshot;
}
