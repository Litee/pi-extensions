/**
 * noSandbox — a SandboxProvider that performs NO isolation.
 *
 * Spawns commands directly on the host. Used for:
 *   - `pi --no-sandbox` style escape hatches where the workflow trusts
 *     the execution environment.
 *   - Unit tests where the test process IS the trusted boundary.
 *
 * Path mapping: identity (sandbox path === host path).
 * All @ai-hero/sandcastle deps removed; implements our own SandboxProvider.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { SandboxProvider, ExecOpts, ExecResult } from "../engine/sandboxProvider.js";
import { mergeChildEnv } from "./srt-env.js";

export interface NoSandboxOptions {
	/** Extra environment variables injected into every exec. */
	readonly env?: Record<string, string>;
}

/**
 * Create a no-isolation provider.
 * All string commands run via `sh -c`; array commands spawn directly.
 */
export const noSandbox = (options?: NoSandboxOptions): SandboxProvider => {
	const providerEnv = options?.env ?? {};

	return {
		name: "noSandbox",

		exec(opts: ExecOpts): Promise<ExecResult> {
			const mergedEnv = mergeChildEnv(process.env, {
				...providerEnv,
				...(opts.env ?? {}),
			});

			// Resolve command → [program, args[]]
			let program: string;
			let args: string[];
			if (typeof opts.command === "string") {
				program = "sh";
				args = ["-c", opts.command];
			} else {
				const [first, ...rest] = opts.command;
				if (first === undefined) {
					return Promise.reject(
						new Error("noSandbox exec: empty command array"),
					);
				}
				program = first;
				args = rest;
			}

			return new Promise<ExecResult>((resolve, reject) => {
				const proc = spawn(program, args, {
					cwd: opts.cwd,
					env: mergedEnv,
					// detached=true makes the subprocess a process-group leader
					// (PGID = proc.pid) so we can reliably kill the whole group —
					// including any node child spawned by a shell wrapper — with
					// process.kill(-proc.pid, signal).
					detached: true,
					stdio: [
						opts.stdin !== undefined ? "pipe" : "ignore",
						"pipe",
						"pipe",
					],
				});
				// unref so the group doesn't prevent the parent from exiting
				// if the caller forgets to await.
				proc.unref();

				// Feed stdin if provided.
				if (opts.stdin !== undefined && proc.stdin !== null) {
					proc.stdin.write(opts.stdin, "utf8");
					proc.stdin.end();
				}

				// Abort: kill the subprocess.
				const onAbort = (): void => {
					const killDelay = opts.forceKillAfterMs ?? 5_000;
					try {
						// Kill the entire process group so the real node child
						// isn't orphaned when the shell wrapper exits first.
						try { process.kill(-proc.pid!, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
						// SIGKILL the process group after grace period if still alive.
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
					// Swallow readline/stream errors on abrupt SIGKILL teardown so
					// they don't become unhandled rejections.
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
					reject(new Error(`noSandbox exec failed: ${err.message}`));
				});

				proc.on("close", (code) => {
					opts.signal?.removeEventListener("abort", onAbort);

					// If aborted, reject with the abort reason.
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
