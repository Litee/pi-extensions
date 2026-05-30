/**
 * Warning sink — a fire-once-per-session helper that defers `notify()` calls
 * made during extension load (when no `ExtensionContext` exists yet) until
 * `session_start` provides a real UI.
 *
 * Dual-emission contract: every queued warning is delivered through TWO
 * channels at flush time:
 *  - `pi.sendMessage(...)` → the LLM-visible channel. Warnings land in
 *    session history and are included in the next LLM prompt's context.
 *  - `ctx.ui.notify(...)`  → an immediate toast for the human. Skipped
 *    silently when no UI is present (`-p`, JSON mode), but the
 *    sendMessage path still fires so the LLM never misses a warning.
 *
 * Extracted so unit tests can drive the queue → flush handshake without
 * standing up a live `ExtensionAPI`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { EVENT_CUSTOM_TYPE } from "./host.js";

export type NotifyLevel = "info" | "warning" | "error";
export type NotifyFn = (message: string, level: NotifyLevel) => void;

/**
 * Build a notify sink that returns a callable + the `session_start` handler
 * that flushes its queue. The factory subscribes the handler via `pi.on`
 * automatically; the returned function is what discovery code uses to push
 * warnings.
 */
export function createDefaultNotifySink(pi: ExtensionAPI): NotifyFn {
	const queue: Array<[string, NotifyLevel]> = [];
	pi.on("session_start", (_event, ctx) => {
		const ui = ctx.ui as
			| { notify?: (m: string, l?: NotifyLevel) => void }
			| undefined;
		const notify = ui?.notify;
		while (queue.length > 0) {
			const next = queue.shift();
			if (next === undefined) break;
			const [m, l] = next;
			// LLM-visible channel: always fire, even when there's no TUI.
			try {
				pi.sendMessage(
					{
						customType: EVENT_CUSTOM_TYPE,
						content: m,
						display: true,
						details: {
							kind: "startup-warning",
							name: "framework",
							level: l,
						},
					},
					{ triggerTurn: false },
				);
			} catch {
				/* swallow — pi.sendMessage failures must not block flush */
			}
			// Toast channel: best-effort, skipped in non-interactive runtimes.
			if (notify !== undefined) {
				try {
					notify(m, l);
				} catch {
					/* swallow */
				}
			}
		}
		return Promise.resolve();
	});
	return (message, level) => {
		queue.push([message, level]);
	};
}
