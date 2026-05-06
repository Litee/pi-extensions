/**
 * Live-IO shim for the cmux CLI. Isolated here (and excluded from the
 * coverage matrix) so the rest of `cmux.ts` stays pure and testable.
 *
 * `defaultCmuxSpawner` does the actual `spawn("cmux", …)`; `runCmux` is
 * the module-level dispatcher that tests can swap out with
 * `__setCmuxSpawnerForTests` without ever touching a real binary.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { cmuxAvailable } from "./cmuxEnv.js";

/**
 * Signature of a cmux invoker. Must resolve on exit/error/timeout — never
 * reject — so that callers can treat every cmux call as safe fire-and-forget.
 */
export type CmuxSpawner = (args: string[]) => Promise<void>;

/**
 * Default invoker: spawns `cmux <args...>`, discards stdio, resolves on
 * exit/error, and force-kills after a 3-second safety timeout so a hung
 * cmux call cannot stall pi lifecycle events.
 */
export const defaultCmuxSpawner: CmuxSpawner = (args) =>
	new Promise((resolve) => {
		let child: ChildProcess | undefined;
		try {
			child = spawn("cmux", args, {
				stdio: ["ignore", "ignore", "ignore"],
				detached: false,
			});
		} catch {
			resolve();
			return;
		}
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			resolve();
		};
		child.on("error", finish);
		child.on("exit", finish);
		const t = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			finish();
		}, 3000);
		child.on("exit", () => clearTimeout(t));
	});

let currentSpawner: CmuxSpawner = defaultCmuxSpawner;

/**
 * Swap the spawner. Intended for unit tests only; callers outside the test
 * suite should not touch this.
 */
export function __setCmuxSpawnerForTests(s: CmuxSpawner | null): void {
	currentSpawner = s ?? defaultCmuxSpawner;
}

/** Fire-and-forget cmux invocation. Resolves even on error. */
export function runCmux(args: string[]): Promise<void> {
	if (!cmuxAvailable()) return Promise.resolve();
	return currentSpawner(args);
}
