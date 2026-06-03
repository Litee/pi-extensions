/**
 * User-level config for pi-git-watcher.
 *
 * Reads `~/.pi/agent/pi-git-watcher.json` (if present) and validates
 * known fields. Any failure mode — file missing, unreadable, invalid
 * JSON, wrong root type, unknown field value — is swallowed and yields
 * `{}` so the runtime falls back to its hardcoded defaults.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Valid display modes for the Git watcher widget / status row. */
export type DisplayMode = "widget" | "statusline";

const VALID_DISPLAY_MODES: ReadonlySet<string> = new Set<DisplayMode>([
  "widget",
  "statusline",
]);

/** Shape of `~/.pi/agent/pi-git-watcher.json`. */
export interface GitWatcherConfig {
  defaultDisplayMode?: DisplayMode;
}

/** Path to the user-level config JSON. Centralised for tests + saveConfig. */
export function configFilePath(): string {
  return join(getAgentDir(), "pi-git-watcher.json");
}

export function loadConfig(): GitWatcherConfig {
  let raw: unknown;
  try {
    const content = readFileSync(configFilePath(), "utf-8");
    raw = JSON.parse(content);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const r = raw as Record<string, unknown>;
  const out: GitWatcherConfig = {};

  const mode = r["defaultDisplayMode"];
  if (typeof mode === "string" && VALID_DISPLAY_MODES.has(mode)) {
    out.defaultDisplayMode = mode as DisplayMode;
  }

  return out;
}

export function saveConfig(
  change: {
    [K in keyof GitWatcherConfig]?: GitWatcherConfig[K] | undefined;
  },
): boolean {
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
