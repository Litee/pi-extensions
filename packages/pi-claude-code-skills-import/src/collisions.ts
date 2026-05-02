import type { DiscoveredSkill } from "./types.js";

/**
 * Group skills by bare {@link DiscoveredSkill.skillName} and return only the
 * groups that contain more than one skill (i.e. actual name collisions).
 *
 * Keys are bare skill names; values are the skills sharing that name in the
 * order they appeared in the input.
 */
export function computeCollisions(
	skills: readonly DiscoveredSkill[],
): Map<string, DiscoveredSkill[]> {
	const byName = new Map<string, DiscoveredSkill[]>();
	for (const s of skills) {
		const list = byName.get(s.skillName) ?? [];
		list.push(s);
		byName.set(s.skillName, list);
	}
	const collisions = new Map<string, DiscoveredSkill[]>();
	for (const [name, list] of byName) {
		if (list.length > 1) collisions.set(name, list);
	}
	return collisions;
}
