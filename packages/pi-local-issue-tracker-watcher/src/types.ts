/**
 * Issue info captured from a single on-disk issue JSON file.
 *
 * Field names match the camelCase convention of the rest of this extension;
 * the snake_case keys they map to on disk (`skill_version`) are normalised
 * here so downstream code only sees one shape.
 */
export interface IssueInfo {
	/** `stat.mtimeNs` — used as a cheap "has this file changed" key in diffs. */
	mtimeNs: bigint;
	issueId: string;
	status: string;
	title: string;
	description: string;
	comments: Array<{ text?: string; [key: string]: unknown }>;
	skill: string;
	skillVersion: string;
}

/** Absolute file path → parsed issue info. */
export type Snapshot = Record<string, IssueInfo>;
