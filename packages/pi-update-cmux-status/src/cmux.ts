/**
 * Thin wrappers around the `cmux` CLI.
 *
 * The live `spawn("cmux", …)` call and the `cmuxAvailable` env-var gate
 * live in separate files (`cmuxSpawner.ts`, `cmuxEnv.ts`); everything
 * here is pure argv building or fire-and-forget dispatch through
 * `runCmux`, so every helper is unit-testable without shelling out.
 */

import { runCmux } from "./cmuxSpawner.js";

// Re-export so callers can keep importing from `./cmux.js`.
export { cmuxAvailable } from "./cmuxEnv.js";
export {
	__setCmuxSpawnerForTests,
	defaultCmuxSpawner,
	runCmux,
	type CmuxSpawner,
} from "./cmuxSpawner.js";

// ---------------------------------------------------------------------------
// Argv builders — pure, exported for testability
// ---------------------------------------------------------------------------

/** Build argv for `cmux set-status`. */
export function buildSetStatusArgs(
	statusKey: string,
	value: string,
	icon?: string,
	color?: string,
): string[] {
	const args = ["set-status", statusKey, value];
	if (icon) args.push("--icon", icon);
	if (color) args.push("--color", color);
	return args;
}

/** Build argv for `cmux log`. */
export function buildLogArgs(
	statusKey: string,
	level: "info" | "progress" | "success" | "warning" | "error",
	message: string,
): string[] {
	return ["log", "--level", level, "--source", statusKey, "--", message];
}

/** Build argv for `cmux notify`. */
export function buildNotifyArgs(title: string, subtitle: string, body: string): string[] {
	return ["notify", "--title", title, "--subtitle", subtitle, "--body", body];
}

/** Build argv for `cmux rename-tab`. Returns `null` when the title is blank. */
export function buildRenameTabArgs(title: string): string[] | null {
	if (!title.trim()) return null;
	return ["rename-tab", "--", title];
}

/** Build argv for `cmux workspace-action --action rename`. */
export function buildRenameWorkspaceArgs(title: string): string[] | null {
	if (!title.trim()) return null;
	return ["workspace-action", "--action", "rename", "--title", title];
}

// ---------------------------------------------------------------------------
// Dispatch helpers — fire-and-forget, used by the event handlers
// ---------------------------------------------------------------------------

export function setStatus(
	statusKey: string,
	value: string,
	icon?: string,
	color?: string,
): void {
	void runCmux(buildSetStatusArgs(statusKey, value, icon, color));
}

export function logLine(
	statusKey: string,
	level: "info" | "progress" | "success" | "warning" | "error",
	message: string,
): void {
	void runCmux(buildLogArgs(statusKey, level, message));
}

export function notifyCmux(title: string, subtitle: string, body: string): void {
	void runCmux(buildNotifyArgs(title, subtitle, body));
}

export function clearProgress(): void {
	void runCmux(["clear-progress"]);
}

export function renameTab(title: string): void {
	const args = buildRenameTabArgs(title);
	if (args) void runCmux(args);
}

export function renameWorkspace(title: string): void {
	const args = buildRenameWorkspaceArgs(title);
	if (args) void runCmux(args);
}

/**
 * Clear the sidebar status pill. cmux has no explicit "clear", but setting
 * the value to an empty string hides the pill on current versions.
 */
export function clearStatus(statusKey: string): void {
	void runCmux(["set-status", statusKey, ""]);
}

/** `HH:MM` wallclock string, local time, zero-padded. */
export function hhmm(now: Date = new Date()): string {
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
