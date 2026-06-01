/**
 * Minimal config for pi-browser-control.
 *
 * The new native-messaging architecture requires no secret or port config.
 * This file is kept for future extensibility and for the configFilePath()
 * helper used by install scripts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Shape of ~/.pi/agent/pi-browser-control.json (currently empty). */
export type BrowserControlConfig = Record<string, never>

export function configFilePath(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "pi-browser-control.json");
}

export function loadConfig(agentDir?: string): BrowserControlConfig {
	try {
		const raw: unknown = JSON.parse(readFileSync(configFilePath(agentDir), "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return {};
	} catch {
		return {};
	}
}
