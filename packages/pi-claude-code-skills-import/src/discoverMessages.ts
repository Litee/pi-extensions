import type { DiscoveredSkill } from "./types.js";

/** One toast/log entry to surface during `resources_discover`. */
export interface DiscoverNotification {
	text: string;
	level: "info" | "warning";
}

export interface DiscoverNotificationInput {
	/** Every skill discovered on disk (enabled + disabled). */
	all: DiscoveredSkill[];
	/** Qualified-name set from the persisted state file. */
	disabled: Set<string>;
	/** Collision map keyed by skill name → skills sharing that name. */
	collisions: Map<string, DiscoveredSkill[]>;
	/** Path to the persisted state file, embedded in the stale-id warning so
	 *  the user can open it directly. Kept as a plain string so callers
	 *  don't accidentally leak a different filesystem abstraction. */
	stateFile: string;
}

/**
 * Build the notification stream emitted from the `resources_discover` handler.
 * Pure — no IO, no `ctx` dependency — so the three branches (summary,
 * collisions, stale-id drift) are unit-testable without stubbing the
 * ExtensionAPI.
 *
 * Ordering is deterministic: info summary → collision warning (if any) →
 * stale-id warning (if any). Callers walk the result sequentially and forward
 * each entry to `ctx.ui.notify(text, level)`.
 */
export function buildDiscoverNotifications(
	input: DiscoverNotificationInput,
): DiscoverNotification[] {
	const { all, disabled, collisions, stateFile } = input;
	const notifications: DiscoverNotification[] = [];

	const on = all.filter((s) => !disabled.has(s.qualifiedName)).length;
	const off = all.length - on;
	notifications.push({
		text: `Claude Code skills: ${on} loaded${off ? ` (${off} disabled)` : ""}`,
		level: "info",
	});

	if (collisions.size > 0) {
		const lines: string[] = [
			`${collisions.size} Claude Code skill name collision(s):`,
		];
		for (const [name, list] of collisions) {
			const sources = list.map((s) => s.qualifiedName).join(", ");
			lines.push(`  • "${name}" appears in: ${sources}`);
		}
		notifications.push({ text: lines.join("\n"), level: "warning" });
	}

	// #0005: surface disabled-id drift. The state file is append-only from the
	// user's perspective — entries are never pruned when a plugin is
	// uninstalled / renamed. Walk the disabled set and flag any qualifiedName
	// that no longer matches a discovered skill.
	const presentIds = new Set(all.map((s) => s.qualifiedName));
	const stale = [...disabled].filter((id) => !presentIds.has(id)).sort();
	if (stale.length > 0) {
		const lines: string[] = [
			`Claude Code skills: ${stale.length} disabled id(s) in state file no longer resolve to any installed skill:`,
			...stale.map((id) => `  • ${id}`),
			`Run /cc-skills-info to review, or edit ${stateFile}.`,
		];
		notifications.push({ text: lines.join("\n"), level: "warning" });
	}

	return notifications;
}
