import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SpeakConfig {
	assetsDir?: string;
	defaultVoice?: string;
	defaultLang?: string;
	defaultSpeed?: number;
	defaultSteps?: number;
}

export function configFilePath(): string {
	return join(getAgentDir(), "pi-speak.json");
}

/**
 * Read `~/.pi/agent/pi-speak.json`; returns `{}` on any read/parse/validation
 * failure. Fail-soft: missing file / bad JSON / wrong root type all yield `{}`.
 * Mirrors the pattern in packages/pi-aws-glue-watcher/src/config.ts.
 */
export function loadConfig(): SpeakConfig {
	let raw: unknown;
	try {
		const content = readFileSync(configFilePath(), "utf-8");
		raw = JSON.parse(content);
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

	const r = raw as Record<string, unknown>;
	const out: SpeakConfig = {};

	if (typeof r["assetsDir"] === "string") out.assetsDir = r["assetsDir"];
	if (typeof r["defaultVoice"] === "string") out.defaultVoice = r["defaultVoice"];
	if (typeof r["defaultLang"] === "string") out.defaultLang = r["defaultLang"];
	if (typeof r["defaultSpeed"] === "number") out.defaultSpeed = r["defaultSpeed"];
	if (typeof r["defaultSteps"] === "number") out.defaultSteps = r["defaultSteps"];

	return out;
}

/**
 * Merge `partial` into the existing config file and write it back.
 * Returns true on success, false on any I/O or serialisation error.
 */
export function saveConfig(partial: Partial<SpeakConfig>): boolean {
	try {
		const current = loadConfig();
		const merged = { ...current, ...partial };
		const dir = getAgentDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(configFilePath(), JSON.stringify(merged, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}

export function resolveExplicitAssetsDir(cfg?: SpeakConfig): string | undefined {
	return process.env["PI_SPEAK_ASSETS_DIR"]?.trim() || cfg?.assetsDir || undefined;
}

export function findHfCachedModel(): string | undefined {
	// Respect HF env vars in priority order:
	// HF_HOME > HUGGINGFACE_HUB_CACHE > ~/.cache/huggingface/hub
	const hfHub =
		(process.env["HF_HOME"] ? join(process.env["HF_HOME"], "hub") : undefined) ??
		process.env["HUGGINGFACE_HUB_CACHE"] ??
		join(homedir(), ".cache", "huggingface", "hub");

	const snapshotsDir = join(hfHub, "models--Supertone--supertonic-3", "snapshots");
	if (!existsSync(snapshotsDir)) return undefined;

	// Pick the most recently modified snapshot
	let entries: string[];
	try { entries = readdirSync(snapshotsDir); } catch { return undefined; }
	if (entries.length === 0) return undefined;

	const latest = entries
		.filter(e => !e.startsWith('.'))
		.map(e => ({ e, mtime: statSync(join(snapshotsDir, e)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)[0];

	if (!latest) return undefined;
	const candidate = join(snapshotsDir, latest.e);
	return existsSync(candidate) ? candidate : undefined;
}

export function discoverAssetsDir(cfg?: SpeakConfig): string {
	return resolveExplicitAssetsDir(cfg) ?? findHfCachedModel() ?? join(homedir(), ".cache", "huggingface", "hub", "models--Supertone--supertonic-3", "snapshots", "latest");
}

/** True only when the heaviest sentinel file is present — guards against partial downloads. */
export function assetsReady(assetsDir: string): boolean {
	return existsSync(join(assetsDir, "onnx", "duration_predictor.onnx"));
}
