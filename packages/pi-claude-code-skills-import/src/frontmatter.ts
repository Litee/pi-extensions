import { readFileSync } from "node:fs";

/**
 * Extract the `name:` scalar from a SKILL.md YAML frontmatter block.
 *
 * Intentionally minimal — matches only the top-level `name:` line and strips
 * surrounding quotes/whitespace. Returns `undefined` if the file is unreadable,
 * has no frontmatter fence, has no closing fence, or contains no `name` key.
 *
 * CRLF note (#0003): the value-capture class explicitly excludes `\r` in
 * addition to `\n` and quotes. In practice the trailing `\s*` absorbs the
 * `\r` on CRLF inputs anyway, but making the exclusion explicit keeps the
 * regex robust against future edits that narrow the trailing whitespace
 * class.
 */
export function extractSkillName(skillFile: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(skillFile, "utf8");
	} catch {
		return undefined;
	}
	if (!text.startsWith("---")) return undefined;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return undefined;
	const block = text.slice(3, end);
	const match = block.match(/^\s*name\s*:\s*["']?([^"'\n\r]+?)["']?\s*$/m);
	return match?.[1]?.trim();
}
