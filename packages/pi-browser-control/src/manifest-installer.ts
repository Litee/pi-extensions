/**
 * Installs the Firefox native-messaging host manifest.
 *
 * The NM manifest tells Firefox where to find the daemon executable and which
 * extension ID is allowed to communicate with it.
 *
 * macOS manifest location:
 *   ~/Library/Application Support/Mozilla/NativeMessagingHosts/pi_browser_control.json
 */

import fs from "node:fs";
import { dirname } from "node:path";

import { manifestPath, GECKO_EXTENSION_ID, NM_HOST_NAME } from "./socket-paths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallManifestOptions {
	/** Absolute path to the launcher script (the daemon entry). */
	launcherPath: string;
	/** Gecko extension ID. Defaults to GECKO_EXTENSION_ID. */
	geckoExtensionId?: string;
	/**
	 * Override the output path (for testing — avoids writing to the real
	 * macOS NM manifest directory).
	 */
	overrideManifestPath?: string;
}

export type InstallManifestResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

// ---------------------------------------------------------------------------
// installManifest
// ---------------------------------------------------------------------------

export function installManifest(opts: InstallManifestOptions): InstallManifestResult {
	const outPath = opts.overrideManifestPath ?? manifestPath();
	const geckoId = opts.geckoExtensionId ?? GECKO_EXTENSION_ID;

	const manifest = {
		name: NM_HOST_NAME,
		description: "pi-browser-control native messaging host — bridges the pi agent and Firefox add-on",
		path: opts.launcherPath,
		type: "stdio",
		allowed_extensions: [geckoId],
	};

	try {
		fs.mkdirSync(dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
		return { ok: true, path: outPath };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// readInstalledManifest
// ---------------------------------------------------------------------------

/**
 * Read and parse the installed NM manifest, or null if missing / invalid.
 * @param overridePath For testing — reads from the given path instead of the macOS location.
 */
export function readInstalledManifest(
	overridePath?: string,
): Record<string, unknown> | null {
	const p = overridePath ?? manifestPath();
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}
