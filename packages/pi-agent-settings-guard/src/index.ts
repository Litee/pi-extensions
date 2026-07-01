/**
 * pi-agent-settings-guard
 *
 * Prevents the LLM from editing settings files in the wrong location
 * and instructs it to use the correct files instead.
 *
 * Rules:
 * 1. Block edits to ~/.pi/settings.json (user-level) → use ~/.pi/agent/settings.json
 * 2. Block edits to ./pi/agent/settings.json (project agent) → use ./pi/settings.json
 * 3. Inject system prompt instructions about correct settings file locations
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const USER_SETTINGS_FILE = ".pi/settings.json";
const PROJECT_AGENT_SETTINGS_FILE = "pi/agent/settings.json";

const SYSTEM_PROMPT_INSTRUCTION = `# Settings Files — Use the Correct Location

Pi has TWO settings files with different scopes. Always use the right one:

## User-Level Settings
- **WRONG**: ~/.pi/settings.json
- **CORRECT**: ~/.pi/agent/settings.json

The file ~/.pi/settings.json is reserved for the pi system itself. If you need
to modify user-level settings, edit ~/.pi/agent/settings.json instead.

## Project-Level Settings
- **WRONG**: ./pi/agent/settings.json
- **CORRECT**: ./pi/settings.json

For project-wide configuration, use ./pi/settings.json. The file
./pi/agent/settings.json is reserved for the pi system itself.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a file path is the user-level settings file (~/.pi/settings.json).
 * Handles both ~-prefixed and resolved absolute paths.
 */
export function isUserSettingsFile(filePath: string): boolean {
  // Match ~/.pi/settings.json (with ~ prefix)
  if (filePath.startsWith("~/.pi/settings.json")) {
    return true;
  }
  // Match resolved absolute paths ending with /.pi/settings.json
  // where the parent directory is a user home directory
  const resolved = filePath.replace(/^~(?=\/|$)/, process.env["HOME"] ?? "");
  return resolved.endsWith(USER_SETTINGS_FILE);
}

/**
 * Check if a file path is the project-level agent settings file (pi/agent/settings.json).
 * Excludes user-level paths like ~/.pi/agent/settings.json.
 */
export function isProjectAgentSettingsFile(filePath: string): boolean {
  // Exclude user-level paths like ~/.pi/agent/settings.json
  if (filePath.startsWith("~") || filePath.startsWith("/Users/") || filePath.startsWith("/home/")) {
    return false;
  }
  return filePath.endsWith(PROJECT_AGENT_SETTINGS_FILE);
}

/**
 * Build the block reason for user-level settings file access.
 */
export function buildUserSettingsBlockReason(): string {
  return [
    "⛔ SETTINGS GUARD: ~/.pi/settings.json is a system-reserved file.",
    "",
    "For user-level settings, edit ~/.pi/agent/settings.json instead.",
  ].join("\n");
}

/**
 * Build the block reason for project-level agent settings file access.
 */
export function buildProjectAgentSettingsBlockReason(): string {
  return [
    "⛔ SETTINGS GUARD: ./pi/agent/settings.json is a system-reserved file.",
    "",
    "For project-level settings, use ./pi/settings.json instead.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function agentSettingsGuard(pi: ExtensionAPI): void {
  // Inject system prompt instructions
  pi.on("before_agent_start", (event, _ctx) => {
    if (event.systemPrompt.includes("# Settings Files")) {
      return; // Already injected
    }
    return {
      systemPrompt: event.systemPrompt + "\n\n" + SYSTEM_PROMPT_INSTRUCTION,
    };
  });

  // Block tool calls targeting wrong settings files
  pi.on("tool_call", (event, _ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) {
      return undefined;
    }

    const filePath = event.input.path;

    // Rule 1: Block edits to user-level settings file
    if (isUserSettingsFile(filePath)) {
      return { block: true, reason: buildUserSettingsBlockReason() };
    }

    // Rule 2: Block edits to project-level agent settings file
    if (isProjectAgentSettingsFile(filePath)) {
      return { block: true, reason: buildProjectAgentSettingsBlockReason() };
    }

    return undefined;
  });
}
