/**
 * Install script for pi-browser-control native-messaging setup.
 *
 * Writes:
 *   1. Launcher script at ~/.pi/agent/pi-browser-control/launch (chmod 0755)
 *   2. NM manifest at ~/Library/Application Support/Mozilla/NativeMessagingHosts/pi_browser_control.json
 *
 * Usage:
 *   node packages/pi-browser-control/scripts/install.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { installLauncher } from "../src/launcher-installer.ts";
import { installManifest } from "../src/manifest-installer.ts";
import { launcherPath } from "../src/socket-paths.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonScriptPath = resolve(__dirname, "../src/daemon/daemon.ts");
const lp = launcherPath();

const launcherResult = installLauncher({
	targetPath: lp,
	daemonScriptPath,
});

if (!launcherResult.ok) {
	process.stderr.write(`[pi-browser-control] Failed to write launcher: ${launcherResult.error}\n`);
	process.exit(1);
}

process.stdout.write(`[pi-browser-control] Launcher written to: ${launcherResult.path}\n`);

const manifestResult = installManifest({ launcherPath: lp });

if (!manifestResult.ok) {
	process.stderr.write(`[pi-browser-control] Failed to write NM manifest: ${manifestResult.error}\n`);
	process.exit(1);
}

process.stdout.write(`[pi-browser-control] NM manifest written to: ${manifestResult.path}\n`);
process.stdout.write("[pi-browser-control] Install complete. Restart Firefox to pick up the manifest.\n");
