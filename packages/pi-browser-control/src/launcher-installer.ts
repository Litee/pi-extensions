/**
 * Installs the launcher shell script that Firefox invokes via the NM manifest.
 *
 * The launcher is a minimal #!/bin/sh script that exec's node with daemon.ts.
 * Firefox native messaging runs it as a child process (stdio-based).
 */

import fs from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallLauncherOptions {
	/** Absolute path where the launcher script should be written. */
	targetPath: string;
	/**
	 * Absolute path to the node executable.
	 * Defaults to process.execPath (the currently-running Node binary).
	 */
	nodePath?: string;
	/** Absolute path to the daemon TypeScript entry file. */
	daemonScriptPath: string;
}

export type InstallLauncherResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

// ---------------------------------------------------------------------------
// installLauncher
// ---------------------------------------------------------------------------

export function installLauncher(opts: InstallLauncherOptions): InstallLauncherResult {
	const nodePath = opts.nodePath ?? process.execPath;
	const scriptContent =
		`#!/bin/sh\nexec "${nodePath}" "${opts.daemonScriptPath}" "$@"\n`;

	try {
		fs.mkdirSync(dirname(opts.targetPath), { recursive: true });
		fs.writeFileSync(opts.targetPath, scriptContent, "utf-8");
		fs.chmodSync(opts.targetPath, 0o755);
		return { ok: true, path: opts.targetPath };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
