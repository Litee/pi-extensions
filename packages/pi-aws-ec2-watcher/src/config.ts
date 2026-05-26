/**
 * User-level config for pi-aws-ec2-watcher.
 *
 * Reads `~/.pi/agent/pi-aws-ec2-watcher.json` (if present).
 * Any failure mode is swallowed and yields `{}`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type DisplayMode = "widget" | "statusline";

const VALID_DISPLAY_MODES: ReadonlySet<string> = new Set<DisplayMode>([
	"widget",
	"statusline",
]);

export interface Ec2WatcherConfig {
	defaultDisplayMode?: DisplayMode;
}

export function configFilePath(): string {
	return join(getAgentDir(), "pi-aws-ec2-watcher.json");
}

export function loadConfig(): Ec2WatcherConfig {
	let raw: unknown;
	try {
		const content = readFileSync(configFilePath(), "utf-8");
		raw = JSON.parse(content);
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

	const r = raw as Record<string, unknown>;
	const out: Ec2WatcherConfig = {};

	const mode = r["defaultDisplayMode"];
	if (typeof mode === "string" && VALID_DISPLAY_MODES.has(mode)) {
		out.defaultDisplayMode = mode as DisplayMode;
	}

	return out;
}

export function saveConfig(change: Partial<Ec2WatcherConfig>): boolean {
	const path = configFilePath();
	try {
		let existing: Record<string, unknown> = {};
		try {
			const content = readFileSync(path, "utf-8");
			const parsed: unknown = JSON.parse(content);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			/* missing/unreadable/invalid JSON → start from {} */
		}
		const merged = { ...existing, ...change };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}
