/**
 * Canonical path constants for the pi-browser-control daemon.
 *
 * Resolves the agent directory from PI_CODING_AGENT_DIR (if set) or
 * ~/.pi/agent — replicating getAgentDir() without importing the pi package
 * so the daemon stays import-light and runnable under `node daemon.ts`.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export const GECKO_EXTENSION_ID = "pi-browser-control@earendil-works";
export const NM_HOST_NAME = "pi_browser_control";

/**
 * Resolve the pi agent directory from the given env (defaults to process.env).
 * Pure function — safe to call in tests without mutating the global env.
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

/** Unix socket path: <agentDir>/pi-browser-control.sock */
export function sockPath(agentDir: string = resolveAgentDir()): string {
	return join(agentDir, "pi-browser-control.sock");
}

/** Daemon log path: <agentDir>/pi-browser-control-daemon.log */
export function logPath(agentDir: string = resolveAgentDir()): string {
	return join(agentDir, "pi-browser-control-daemon.log");
}

/** Launcher script path: <agentDir>/pi-browser-control/launch */
export function launcherPath(agentDir: string = resolveAgentDir()): string {
	return join(agentDir, "pi-browser-control", "launch");
}

/** Firefox NM manifest path (macOS only). */
export function manifestPath(): string {
	return join(
		homedir(),
		"Library",
		"Application Support",
		"Mozilla",
		"NativeMessagingHosts",
		"pi_browser_control.json",
	);
}
