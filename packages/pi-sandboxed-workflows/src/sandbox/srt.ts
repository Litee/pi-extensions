/**
 * SRT (Anthropic Sandbox Runtime) provider.
 *
 * Wraps each command in a per-process Seatbelt (macOS) / bubblewrap (Linux)
 * sandbox. Unlike Docker/Finch there is no long-lived container — every
 * exec() is a fresh sandboxed subprocess. We use identity path mapping
 * (sandbox path === host path) because srt runs on the host filesystem.
 *
 * Filesystem enforcement is done entirely via Seatbelt allowWrite/denyRead
 * rules — HOME is NOT overridden so the subprocess finds its credentials,
 * settings, and toolchain through the normal PATH/HOME inherited from the
 * parent process.
 *
 * The only per-run tmpDir is used for the srt settings JSON file itself.
 *
 * Options:
 *   - allowedDomains: restrict network to these domains only (default: ["*"] = allow all)
 *   - extraAllowWrite: additional host paths to grant write access
 *   - extraDenyWrite: host paths to deny write within allowed regions
 *   - extraDenyRead:  host paths to deny read access
 *   - worktreeReadonly: deny write on the worktree root (planner/reviewer)
 *   - env: env vars merged into every exec
 */
import { spawn } from "node:child_process";
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { SandboxProvider, ExecOpts, ExecResult } from "../engine/sandboxProvider.js";
import { mergeChildEnv } from "./srt-env.js";

export interface SrtOptions {
	readonly allowedDomains?: readonly string[];
	readonly extraAllowWrite?: readonly string[];
	readonly extraDenyWrite?: readonly string[];
	readonly extraDenyRead?: readonly string[];
	readonly worktreeReadonly?: boolean;
	readonly env?: Record<string, string>;
}

interface SrtSettings {
	network: {
		allowedDomains?: string[];
		deniedDomains: string[];
		allowLocalBinding?: boolean;
	};
	filesystem: {
		denyRead: string[];
		allowRead?: string[];
		allowWrite: string[];
		denyWrite: string[];
	};
}

/**
 * Create an SRT-backed SandboxProvider.
 *
 * Setup (settings file, process cleanup handlers) runs eagerly
 * so the provider is immediately usable.
 */
export const srt = (options?: SrtOptions): SandboxProvider => {
	const allowedDomains = options?.allowedDomains ?? [];
	const extraAllowWrite = options?.extraAllowWrite ?? [];
	const extraDenyWrite = options?.extraDenyWrite ?? [];
	const extraDenyRead = options?.extraDenyRead ?? [];
	const worktreeReadonly = options?.worktreeReadonly ?? false;
	const providerEnv = options?.env ?? {};

	// ── Eager setup ───────────────────────────────────────────────────────────
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-sw-srt-"));
	const settingsPath = join(tmpDir, "srt-settings.json");

	// Base allowWrite — cwd/.pi is added per-exec so pi can write its lock file.
	const baseAllowWrite = Array.from(
		new Set([
			"/tmp",
			"/private/tmp",
			"/var/folders",
			"/private/var/folders",
			// Pi writes session files here when --session-id is used.
			join(homedir(), ".pi", "agent", "sessions"),
			...extraAllowWrite,
		]),
	);

	const settings: SrtSettings = {
		network: {
			// Empty allowedDomains means deny-all in srt. Use ["*"] to allow all
			// outbound network when the caller hasn't restricted it.
			allowedDomains: allowedDomains.length > 0 ? [...allowedDomains] : ["*"],
			deniedDomains: [],
			allowLocalBinding: true,
		},
		filesystem: {
			denyRead: [...extraDenyRead],
			allowWrite: baseAllowWrite,
			denyWrite: [...extraDenyWrite],
		},
	};

	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	// ── Process cleanup ───────────────────────────────────────────────────────
	const cleanup = (): void => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* swallow — best-effort cleanup */
		}
	};
	const onSignal = (): void => {
		cleanup();
		process.exit(1);
	};
	process.on("exit", cleanup);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	// ── Provider ──────────────────────────────────────────────────────────────
	return {
		name: "srt",

		exec(opts: ExecOpts): Promise<ExecResult> {
			const cwd = opts.cwd ?? process.cwd();

			// Allow writing to <cwd>/.pi so pi can create its settings lock file.
			settings.filesystem.allowWrite = Array.from(
				new Set([...baseAllowWrite, join(cwd, ".pi")]),
			);

			// Update denyWrite with worktree path if worktreeReadonly requested.
			if (worktreeReadonly) {
				settings.filesystem.denyWrite = Array.from(
					new Set([...extraDenyWrite, cwd]),
				);
			}
			// Re-write settings so srt picks up any dynamic changes.
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

			// Build srt args. For array commands, pass them directly after
			// the settings flag so srt exec's them without a shell. For string
			// commands, use -c so srt runs them through the shell (legacy behaviour).
			let srtArgs: string[];
			if (typeof opts.command === "string") {
				srtArgs = ["--settings", settingsPath, "-c", opts.command];
			} else {
				// Direct exec: srt --settings <path> <program> [args...]
				srtArgs = ["--settings", settingsPath, ...opts.command];
			}

			const merged = mergeChildEnv(process.env, {
				...providerEnv,
				...(opts.env ?? {}),
			});

			return new Promise<ExecResult>((resolve, reject) => {
				const proc = spawn("srt", srtArgs, {
					cwd,
					env: merged,
					detached: true,
					stdio: [
						opts.stdin !== undefined ? "pipe" : "ignore",
						"pipe",
						"pipe",
					],
				});
				proc.unref();

				if (opts.stdin !== undefined && proc.stdin !== null) {
					proc.stdin.write(opts.stdin, "utf8");
					proc.stdin.end();
				}

				// Abort: kill subprocess.
				const onAbort = (): void => {
					const killDelay = opts.forceKillAfterMs ?? 5_000;
					try {
						try { process.kill(-proc.pid!, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
						const killTimer = setTimeout(() => {
							try { process.kill(-proc.pid!, "SIGKILL"); } catch {
								try { proc.kill("SIGKILL"); } catch { /* already gone */ }
							}
						}, killDelay);
						killTimer.unref();
						// Cancel the SIGKILL timer if the process group exits.
						proc.once("exit", () => clearTimeout(killTimer));
					} catch {
						/* already exited */
					}
				};
				if (opts.signal?.aborted) {
					onAbort();
				} else {
					opts.signal?.addEventListener("abort", onAbort, { once: true });
				}

				const outChunks: string[] = [];
				const errChunks: string[] = [];
				const { onLine } = opts;

				if (onLine !== undefined && proc.stdout !== null) {
					const rl = createInterface({ input: proc.stdout });
					// Swallow readline/stream errors on abrupt SIGKILL teardown.
					rl.on("error", () => { /* swallow pipe-closed errors on SIGKILL */ });
					proc.stdout.on("error", () => { /* swallow pipe-closed errors on SIGKILL */ });
					rl.on("line", (line) => {
						outChunks.push(line);
						onLine(line);
					});
				} else if (proc.stdout !== null) {
					proc.stdout.on("error", () => { /* swallow pipe-closed errors on SIGKILL */ });
					proc.stdout.on("data", (c: Buffer) => {
						outChunks.push(c.toString("utf8"));
					});
				}

				if (proc.stderr !== null) {
					proc.stderr.on("error", () => { /* swallow pipe-closed errors on SIGKILL */ });
					proc.stderr.on("data", (c: Buffer) => {
						errChunks.push(c.toString("utf8"));
					});
				}

				proc.on("error", (err) => {
					opts.signal?.removeEventListener("abort", onAbort);
					reject(new Error(`srt exec failed: ${err.message}`));
				});

				proc.on("close", (code) => {
					opts.signal?.removeEventListener("abort", onAbort);

					if (opts.signal?.aborted) {
						const reason: unknown = opts.signal.reason;
						reject(
							reason instanceof Error
								? reason
								: new Error("aborted"),
						);
						return;
					}

					resolve({
						stdout: outChunks.join(onLine !== undefined ? "\n" : ""),
						stderr: errChunks.join(""),
						exitCode: code ?? 0,
					});
				});
			});
		},
	};
};
