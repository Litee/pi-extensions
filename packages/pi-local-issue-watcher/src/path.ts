/**
 * Abbreviate a filesystem path for display in a narrow status row.
 *
 * Keeps the leading prefix (`/`, `~/`, `./`, or none for bare relatives)
 * verbatim, replaces every intermediate segment with its first grapheme
 * (or `.` + first grapheme for dotfile segments), and keeps the last
 * segment verbatim. Intended for the pinned status pill — never for
 * user-visible notifications the user might want to copy-paste.
 *
 * Examples:
 * ```
 *   /home/user/projects/tracker → /h/u/p/tracker
 *   /Users/alice/.pi/skills             → /U/a/.p/skills
 *   ~/tracker                               → ~/tracker   (single segment)
 *   ./foo/bar/baz                           → ./f/b/baz
 *   /foo//bar/baz                           → /f/b/baz   (// collapses)
 * ```
 *
 * Unicode: uses `Intl.Segmenter` when available so combining marks count
 * as a single grapheme. Falls back to code-point iteration if the runtime
 * does not expose `Intl.Segmenter`.
 */
export function abbreviatePath(path: string): string {
	if (path === "") return "";

	let prefix: string;
	let rest: string;
	if (path.startsWith("~/")) {
		prefix = "~/";
		rest = path.slice(2);
	} else if (path.startsWith("./")) {
		prefix = "./";
		rest = path.slice(2);
	} else if (path.startsWith("/")) {
		prefix = "/";
		rest = path.slice(1);
	} else {
		prefix = "";
		rest = path;
	}

	// Strip trailing slash(es) so "/foo/bar/" behaves like "/foo/bar".
	while (rest.endsWith("/")) rest = rest.slice(0, -1);

	// Collapse empty segments from "//".
	const segments = rest.split("/").filter((s) => s !== "");

	if (segments.length <= 1) {
		return prefix + segments.join("/");
	}

	const abbreviated = segments.slice(0, -1).map(abbreviateSegment);
	const last = segments[segments.length - 1]!;
	return prefix + [...abbreviated, last].join("/");
}

function abbreviateSegment(seg: string): string {
	if (seg === "") return "";
	const graphemes = splitGraphemes(seg);
	if (graphemes[0] === "." && graphemes.length >= 2) {
		// Dotfile: preserve the leading dot and take the first real grapheme.
		return "." + graphemes[1];
	}
	return graphemes[0] ?? "";
}

// Reuse a single Segmenter for performance when the runtime exposes one.
const SEGMENTER: Intl.Segmenter | null =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

function splitGraphemes(s: string): string[] {
	if (SEGMENTER) {
		const out: string[] = [];
		for (const seg of SEGMENTER.segment(s)) out.push(seg.segment);
		return out;
	}
	// Fallback: split by code point. Handles surrogate pairs (single emoji,
	// mathematical symbols, CJK supplementary characters) but not combining
	// marks. Node 24 always ships Intl.Segmenter, so this path is dormant.
	return Array.from(s);
}
