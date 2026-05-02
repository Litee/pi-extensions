import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PluginEntry } from "./types.js";

interface RawPluginEntry {
	scope?: string;
	installPath?: string;
	lastUpdated?: string;
	installedAt?: string;
}

interface RawManifest {
	plugins?: Record<string, RawPluginEntry[]>;
}

/**
 * Read `<claudeDir>/plugins/installed_plugins.json` and return one active
 * {@link PluginEntry} per installed plugin.
 *
 * Selection rules per plugin:
 *   1. Prefer the entry with `scope === "user"`.
 *   2. Otherwise pick the entry with the newest `lastUpdated` (or `installedAt`).
 *
 * Entries without an `installPath` are skipped. Missing / malformed manifests
 * produce an empty array.
 */
export function readActivePlugins(claudeDir: string): PluginEntry[] {
	const manifestPath = join(claudeDir, "plugins", "installed_plugins.json");
	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch {
		return [];
	}
	let manifest: RawManifest;
	try {
		manifest = JSON.parse(raw) as RawManifest;
	} catch {
		return [];
	}
	const plugins = manifest?.plugins;
	if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];

	const out: PluginEntry[] = [];
	for (const [pluginKey, rawEntries] of Object.entries(plugins)) {
		const entries = Array.isArray(rawEntries) ? rawEntries : [];
		if (entries.length === 0) continue;

		const sorted = [...entries].sort((a, b) => {
			const aT = Date.parse(a?.lastUpdated ?? a?.installedAt ?? "") || 0;
			const bT = Date.parse(b?.lastUpdated ?? b?.installedAt ?? "") || 0;
			return bT - aT;
		});
		const chosen = sorted.find((e) => e?.scope === "user") ?? sorted[0];
		if (!chosen?.installPath) continue;

		const pluginName = pluginKey.split("@")[0] ?? pluginKey;
		out.push({ pluginKey, pluginName, installPath: chosen.installPath });
	}
	return out;
}
