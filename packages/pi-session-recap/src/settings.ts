/**
 * User-level settings reader for the recap-model override.
 *
 * Looks up `sessionRecap.model` inside `<agentDir>/settings.json`, where
 * `<agentDir>` defaults to pi's `getAgentDir()` (i.e. `~/.pi/agent` on a
 * typical install, or `$PI_CODING_AGENT_DIR` when overridden).
 *
 * Precedence is enforced by the caller (index.ts): the `--recap-model` CLI
 * flag wins over this value, which wins over the active model default.
 *
 * All error paths (missing file, invalid JSON, missing key, wrong type,
 * empty/whitespace value) return `undefined` silently. The caller treats an
 * `undefined` result as "no override configured" and proceeds with the next
 * fallback, matching pi's existing CLI-flag behaviour.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

/** Extract `sessionRecap.model` from `<agentDir>/settings.json`. */
export function readUserRecapModel(agentDir: string = getAgentDir()): string | undefined {
	const file = join(agentDir, "settings.json");
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const sessionRecap = (parsed as { sessionRecap?: unknown }).sessionRecap;
	if (!sessionRecap || typeof sessionRecap !== "object" || Array.isArray(sessionRecap)) return undefined;
	const model = (sessionRecap as { model?: unknown }).model;
	if (typeof model !== "string") return undefined;
	const trimmed = model.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
