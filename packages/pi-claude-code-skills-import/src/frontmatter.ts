import { readFileSync } from "node:fs";

/**
 * Extract the `name:` scalar from a SKILL.md YAML frontmatter block.
 *
 * Intentionally minimal — matches only the top-level `name:` line and strips
 * surrounding quotes/whitespace. Returns `undefined` if the file is unreadable,
 * has no frontmatter fence, has no closing fence, or contains no `name` key.
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
	const match = block.match(/^\s*name\s*:\s*["']?([^"'\n]+?)["']?\s*$/m);
	return match?.[1]?.trim();
}
