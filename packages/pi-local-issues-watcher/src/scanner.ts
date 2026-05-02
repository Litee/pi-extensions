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
 * that fail to parse are skipped with a `console.warn` (not thrown) — the
 * watcher must stay alive across transient writer/reader races.
 */
export function scanIssueFiles(dbRoot: string): Snapshot {
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
				// eslint-disable-next-line no-console
				console.warn(`[issue-watcher] could not read ${filePath}: ${String(exc)}`);
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (exc) {
				// eslint-disable-next-line no-console
				console.warn(`[issue-watcher] could not parse ${filePath}: ${String(exc)}`);
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
