import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

import type { PresetsConfig } from "./types.js";

/**
 * Load and merge presets from the two config file locations.
 * Project-local values override global values for the same preset name.
 *
 * Config file locations:
 * - `~/.pi/agent/presets.json`  — global
 * - `<cwd>/.pi/presets.json`    — project-local
 */
export function loadPresets(cwd: string): PresetsConfig {
	const globalPath = join(getAgentDir(), "presets.json");
	const projectPath = join(cwd, ".pi", "presets.json");

	let globalPresets: PresetsConfig = {};
	let projectPresets: PresetsConfig = {};

	if (existsSync(globalPath)) {
		try {
			globalPresets = JSON.parse(readFileSync(globalPath, "utf-8")) as PresetsConfig;
		} catch (err) {
			console.error(`pi-preset: failed to load global presets from ${globalPath}: ${err}`);
		}
	}

	if (existsSync(projectPath)) {
		try {
			projectPresets = JSON.parse(readFileSync(projectPath, "utf-8")) as PresetsConfig;
		} catch (err) {
			console.error(`pi-preset: failed to load project presets from ${projectPath}: ${err}`);
		}
	}

	return { ...globalPresets, ...projectPresets };
}
