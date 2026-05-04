/**
 * Orchestration for the `/local-issue-watcher-info` slash command
 * (tracker issue #0023).
 *
 * Keeps the pure logic — scan the tracker → shape rows → delegate to
 * a picker — separate from the pi-tui integration code that lives in
 * `infoTui.ts`. Tests instantiate this module directly and pass a fake
 * picker, so the data-shaping contract is fully covered without needing
 * a live TUI runtime.
 *
 * Why a separate module: `/local-issue-watcher-info` is a NEW slash
 * command (alongside the existing `/local-issue-watcher pause | resume
 * | status`, not replacing any of its subcommands — see #0023's own
 * description and the follow-up clarifying question answered by the
 * user). Mixing the new handler into the existing omnibus command
 * registration would inflate `src/index.ts`; splitting it off keeps
 * each command's wiring small and focused.
 */

import type { IssueInfo, Snapshot } from "./types.js";

/**
 * One row in the info TUI's main list.
 *
 * `value` is the absolute on-disk path of the issue JSON file, used as
 * the SelectList item value so the picker can look up the full
 * {@link IssueInfo} for the preview pane.
 */
export interface InfoRow {
	/** Absolute path of the backing issue JSON file. */
	value: string;
	/** One-line row label: `<skill> #<issueId> — <title>`. */
	label: string;
	/** Backing issue info — carried through so the picker's preview pane can render it without a second scan. */
	info: IssueInfo;
}

/**
 * Shape of the picker function {@link handleInfo} delegates to. The
 * production implementation is `makeInfoTuiPicker` in `infoTui.ts`; tests
 * pass an in-memory fake so the orchestration can be asserted without
 * spinning up pi-tui.
 *
 * The picker is called once per command invocation. It owns the TUI
 * lifecycle — open panel, accept user input, close on Esc/q — and is
 * not expected to return a value: interaction is entirely side-effecting
 * (preview pane text updates, eventual exit). The returned promise
 * resolves when the user closes the picker.
 */
export type InfoPicker = (args: {
	rows: InfoRow[];
	/** Summary shown above the list: `<open> open, <total> total` (matches pinned-status convention from #0022). */
	summary: string;
}) => Promise<void>;

/**
 * Build the sorted `InfoRow[]` the picker should display, plus the
 * one-line summary shown above the list.
 *
 * Default filter: only rows with `status === "open"` are included in the
 * returned list. The summary always reports both the filtered count and
 * the grand total so the user can tell at a glance whether the backlog
 * has aged-out entries they aren't currently seeing. (Filter toggles —
 * include `in_progress`, `done`, `wont_fix` — are called out as optional
 * in the issue and are deferred to a follow-up.)
 *
 * Sort order: primary by `skill` ascending, secondary by `issueId`
 * ascending (lexicographic on the zero-padded string form, e.g. `"0009"
 * < "0010"`). Keeps the list stable across session restarts and lets
 * the user scan for a known skill without scrolling.
 *
 * Pure — returns a plain value, performs no IO. Callers are responsible
 * for having scanned the snapshot first.
 */
export function buildOpenIssueRows(snapshot: Snapshot): {
	rows: InfoRow[];
	summary: string;
} {
	const entries = Object.entries(snapshot);
	const openEntries = entries.filter(([, info]) => info.status === "open");
	const rows: InfoRow[] = openEntries
		.map(([path, info]) => ({
			value: path,
			label: formatRowLabel(info),
			info,
		}))
		.sort((a, b) => {
			const s = a.info.skill.localeCompare(b.info.skill);
			return s !== 0 ? s : a.info.issueId.localeCompare(b.info.issueId);
		});
	const summary = `${openEntries.length} open, ${entries.length} total`;
	return { rows, summary };
}

/**
 * Render a single row's one-line label. Format:
 *
 *   `<skill> #<issueId>  <title>`
 *
 * Two-space gap between the id and the title so the id column reads as
 * its own segment. Title is rendered verbatim — no truncation here,
 * the TUI layer does that based on available width.
 */
export function formatRowLabel(info: IssueInfo): string {
	return `${info.skill} #${info.issueId}  ${info.title}`;
}

/**
 * Render the content shown in the preview pane when a row is selected.
 *
 * Includes the issue's description and a compact rendering of each
 * comment (timestamp + body). Returned as a plain string with `\n`
 * separators so the TUI layer can slice it into lines without caring
 * about the rendering rules.
 *
 * Empty description and empty comments are both tolerated — the
 * corresponding sections are rendered as a single "(none)" placeholder
 * so the preview pane is never empty.
 */
export function formatPreview(info: IssueInfo): string {
	const lines: string[] = [];
	lines.push(`${info.skill} #${info.issueId}`);
	lines.push(`status: ${info.status}`);
	lines.push(`title:  ${info.title}`);
	lines.push("");
	lines.push("description:");
	lines.push(info.description.trim().length > 0 ? info.description : "(none)");
	lines.push("");
	lines.push(`comments (${info.comments.length}):`);
	if (info.comments.length === 0) {
		lines.push("(none)");
	} else {
		for (const c of info.comments) {
			// Comments have heterogeneous keys (text, timestamp, author,
			// …). Render whatever `text`/`body` the tracker stored; fall
			// back to JSON for anything we don't recognise so nothing is
			// silently lost.
			const body =
				typeof c.text === "string"
					? c.text
					: typeof c["body"] === "string"
						? (c["body"] as string)
						: JSON.stringify(c);
			lines.push(`  • ${body}`);
		}
	}
	return lines.join("\n");
}

/**
 * Top-level handler invoked by the registered slash command. Scans the
 * tracker via the caller-supplied `scan` function, builds the row list
 * + summary, and hands off to the picker. The picker is responsible
 * for showing the TUI and resolving when the user closes it.
 *
 * `scan` is injected (not hard-coded to `scanIssueFiles`) so tests can
 * drive `handleInfo` with a fixture snapshot without touching the
 * filesystem.
 */
export async function handleInfo(opts: {
	dbRoot: string;
	scan: (dbRoot: string) => Snapshot;
	picker: InfoPicker;
}): Promise<void> {
	const snapshot = opts.scan(opts.dbRoot);
	const { rows, summary } = buildOpenIssueRows(snapshot);
	await opts.picker({ rows, summary });
}
