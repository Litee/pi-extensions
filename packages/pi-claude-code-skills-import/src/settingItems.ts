import type { DiscoveredSkill } from "./types.js";

/** Data-only shape for the `/cc-skills` toggle UI — free of TUI-specific types. */
export interface ToggleSettingItem {
	id: string;
	skillName: string;
	qualifiedName: string;
	currentValue: "enabled" | "disabled";
	values: ["enabled", "disabled"];
	isCollision: boolean;
}

/**
 * Build the list of toggle items rendered by `/cc-skills`.
 *
 * Pure: does no IO and produces no styling. Callers (the TUI wiring) decorate
 * labels as needed. Input ordering is preserved so the caller's sort order
 * (typically {@link DiscoveredSkill.qualifiedName}) drives display order.
 */
export function buildSettingItems(
	skills: readonly DiscoveredSkill[],
	disabled: ReadonlySet<string>,
	collisions: ReadonlyMap<string, readonly DiscoveredSkill[]>,
): ToggleSettingItem[] {
	return skills.map((s) => ({
		id: s.qualifiedName,
		skillName: s.skillName,
		qualifiedName: s.qualifiedName,
		currentValue: disabled.has(s.qualifiedName) ? "disabled" : "enabled",
		values: ["enabled", "disabled"],
		isCollision: collisions.has(s.skillName),
	}));
}
