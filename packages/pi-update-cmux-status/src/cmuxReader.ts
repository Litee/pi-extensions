/**
 * Read-side wrapper around the `cmux rpc` CLI.
 *
 * Complements `cmuxSpawner.ts` (which is fire-and-forget, stdio
 * discarded). Here we need stdout so we can parse JSON — so we use a
 * second spawner shape, `CmuxReader: (args) => Promise<string>`, with
 * its own test double injection point.
 *
 * `readWorkspaceTitle` is the only public helper; it MUST return `null`
 * on any failure (cmux unavailable, non-zero exit, timeout, malformed
 * JSON, missing field, empty title). Callers use `null` as the
 * fail-open signal: when we can't confirm the current title, default to
 * the pre-#0003 behaviour of renaming unconditionally.
 *
 * Tab-title reading lived here briefly during earlier scoping of #0003;
 * the tab rename feature was removed before merge, so no tab reader is
 * needed.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { cmuxAvailable } from "./cmuxEnv.js";

/**
 * Signature of a read-side cmux invoker. Resolves with captured stdout on
 * success; rejects on exit code != 0, error, or timeout.
 */
export type CmuxReader = (args: string[]) => Promise<string>;

/**
 * Default reader: spawns `cmux <args...>`, buffers stdout, resolves with
 * the decoded string on clean exit, rejects on non-zero exit / spawn error
 * / 3-second timeout.
 */
export const defaultCmuxReader: CmuxReader = (args) =>
	new Promise((resolve, reject) => {
		let child: ChildProcess | undefined;
		try {
			child = spawn("cmux", args, {
				stdio: ["ignore", "pipe", "ignore"],
				detached: false,
			});
		} catch (err) {
			reject(err);
			return;
		}
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (b: Buffer) => chunks.push(b));
		let done = false;
		const finish = (err: Error | null): void => {
			if (done) return;
			done = true;
			clearTimeout(t);
			if (err) reject(err);
			else resolve(Buffer.concat(chunks).toString("utf8"));
		};
		child.on("error", (err) => finish(err));
		child.on("exit", (code) => {
			if (code === 0) finish(null);
			else finish(new Error(`cmux exited with code ${code ?? "?"}`));
		});
		const t = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			finish(new Error("cmux rpc timed out after 3s"));
		}, 3000);
	});

let currentReader: CmuxReader = defaultCmuxReader;

/**
 * Swap the read-side cmux invoker. Intended for unit tests only. Pass
 * `null` to restore the default spawner.
 */
export function __setCmuxReaderForTests(r: CmuxReader | null): void {
	currentReader = r ?? defaultCmuxReader;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current cmux workspace title, or `null` when the title
 * cannot be determined (cmux unavailable, RPC failed, JSON parse, empty
 * title). Never throws.
 */
export async function readWorkspaceTitle(): Promise<string | null> {
	if (!cmuxAvailable()) return null;
	const raw = await safeRpc(["rpc", "workspace.current"]);
	if (raw == null) return null;
	const obj = safeParse(raw);
	const title = (obj as { workspace?: { title?: unknown } } | null)?.workspace?.title;
	return typeof title === "string" && title.length > 0 ? title : null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function safeRpc(args: string[]): Promise<string | null> {
	try {
		return await currentReader(args);
	} catch {
		return null;
	}
}

function safeParse(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
