import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Keys in `~/.pi/agent/settings.json` that pi-coding-agent's
 * `settingsManager.setDefaultModelAndProvider` / `setDefaultThinkingLevel`
 * write to when an extension calls `pi.setModel` or `pi.setThinkingLevel`.
 *
 * Plan mode needs to switch these in-memory for its own session WITHOUT
 * persisting them globally — but the public ExtensionAPI has no
 * `{ persist: false }` option, so we snapshot these values before calling
 * the setters and rewrite them afterwards. See skill-issue
 * pi-plan-mode#0002 for the full story.
 */
export interface DefaultsSnapshot {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
}

const DEFAULTS_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

/**
 * Resolve the pi-coding-agent settings directory.
 *
 * Mirrors pi-coding-agent's `getAgentDir()` in `dist/config.js`: honor the
 * `PI_CODING_AGENT_DIR` env var if set (expanding `~`), else fall back to
 * `~/.pi/agent`. We duplicate the logic because pi-coding-agent does not
 * re-export it, and the exact upstream env-var name matters so test
 * harnesses that sandbox the agent dir keep working.
 */
export function resolveAgentDir(): string {
	const envDir = process.env["PI_CODING_AGENT_DIR"];
	if (envDir && envDir.length > 0) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}

/**
 * Read the three `default*` keys from `<agentDir>/settings.json`. Tolerant of
 * a missing file and malformed JSON — returns `{}` in those cases rather than
 * throwing. The extension must never crash the agent because of an unreadable
 * settings file.
 */
export function readDefaultsSnapshot(agentDir: string): DefaultsSnapshot {
	const path = join(agentDir, "settings.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const src = parsed as Record<string, unknown>;
	const out: DefaultsSnapshot = {};
	for (const key of DEFAULTS_KEYS) {
		const v = src[key];
		if (typeof v === "string") out[key] = v;
	}
	return out;
}

/**
 * Rewrite the three `default*` keys in `<agentDir>/settings.json` to match
 * `snapshot`: keys present in the snapshot are set, keys absent from the
 * snapshot are deleted from the file. All other keys are left untouched.
 *
 * If the file does not exist or is malformed JSON, this is a no-op — we
 * never create a fresh settings.json here, because pi-coding-agent will
 * have created one on first run and we don't want to race with it.
 *
 * All filesystem errors are swallowed. Plan mode must not break the session
 * just because settings.json is briefly unreadable.
 */
export function restoreDefaults(agentDir: string, snapshot: DefaultsSnapshot): void {
	const path = join(agentDir, "settings.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object") return;
	const next = { ...(parsed as Record<string, unknown>) };
	for (const key of DEFAULTS_KEYS) {
		const v = snapshot[key];
		if (v === undefined) {
			delete next[key];
		} else {
			next[key] = v;
		}
	}
	try {
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	} catch {
		// Best-effort: leave settings.json in whatever state pi-coding-agent last wrote.
	}
}
