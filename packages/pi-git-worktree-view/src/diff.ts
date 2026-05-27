/**
 * Unified-diff parser.
 *
 * Converts the raw text output of `git diff` into a list of {@link DiffLine}
 * records ready for side-by-side rendering.
 */

export interface DiffLine {
	/** "context" | "added" | "removed" | "hunk" */
	type: "context" | "added" | "removed" | "hunk";
	/** Text on the left (original) side, or null when there is no left content */
	left: string | null;
	/** Text on the right (new) side, or null when there is no right content */
	right: string | null;
	/** 1-based line number on the left side, or null */
	leftNum: number | null;
	/** 1-based line number on the right side, or null */
	rightNum: number | null;
	/** Only for type === "hunk": the raw @@ header */
	header?: string | undefined;
}

/**
 * Parse a unified diff string into {@link DiffLine} records.
 *
 * The parser handles the standard `@@ -l,s +l,s @@` hunk headers and the
 * `+`, `-`, and ` ` prefix lines inside them.  Header lines (`diff --git`,
 * `index`, `---`, `+++`) are skipped.
 */
export function parseUnifiedDiff(raw: string): DiffLine[] {
	if (!raw.trim()) return [];

	const lines = raw.split("\n");
	const result: DiffLine[] = [];

	let leftLine = 0;
	let rightLine = 0;

	for (const line of lines) {

		// Hunk header: @@ -l[,s] +l[,s] @@ [optional context]
		if (line.startsWith("@@")) {
			const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
			if (m && m[1] !== undefined && m[2] !== undefined) {
				leftLine = parseInt(m[1], 10);
				rightLine = parseInt(m[2], 10);
				result.push({
					type: "hunk",
					left: null,
					right: null,
					leftNum: null,
					rightNum: null,
					header: line,
				});
			}
			continue;
		}

		// Skip diff metadata headers
		if (
			line.startsWith("diff ") ||
			line.startsWith("index ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("Binary ") ||
			line.startsWith("new file ") ||
			line.startsWith("deleted file ") ||
			line.startsWith("old mode ") ||
			line.startsWith("new mode ") ||
			line.startsWith("rename from ") ||
			line.startsWith("rename to ") ||
			line.startsWith("similarity ") ||
			line.startsWith("copy from ") ||
			line.startsWith("copy to ")
		) {
			continue;
		}

		if (line.startsWith("+")) {
			result.push({
				type: "added",
				left: null,
				right: line.slice(1),
				leftNum: null,
				rightNum: rightLine,
			});
			rightLine++;
		} else if (line.startsWith("-")) {
			result.push({
				type: "removed",
				left: line.slice(1),
				right: null,
				leftNum: leftLine,
				rightNum: null,
			});
			leftLine++;
		} else if (line.startsWith(" ") || line === "") {
			// Context line (space prefix, or empty line which git sometimes emits)
			const text = line.startsWith(" ") ? line.slice(1) : "";
			result.push({
				type: "context",
				left: text,
				right: text,
				leftNum: leftLine,
				rightNum: rightLine,
			});
			leftLine++;
			rightLine++;
		}
		// else: unknown prefix, skip
	}

	return result;
}

/**
 * For untracked files we have no diff output — produce a pseudo-diff that
 * shows the file contents on the right side with empty left.
 */
export function buildUntrackedDiff(content: string): DiffLine[] {
	const lines = content.split("\n");
	// Drop trailing empty line that split produces
	if (lines[lines.length - 1] === "") lines.pop();

	return lines.map(
		(text, i): DiffLine => ({
			type: "added",
			left: null,
			right: text,
			leftNum: null,
			rightNum: i + 1,
		}),
	);
}
