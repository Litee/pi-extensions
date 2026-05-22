/**
 * Pure key-dispatch for the S3 WatchesView.
 *
 * Mirrors `pi-aws-glue-watcher/src/ui/watchesKeys.ts` but omits the
 * `begin-stop` / `stop`-confirm flow: S3 watches have nothing to stop —
 * they are purely observational. The only confirm-mode action is
 * unwatch (`d`).
 */

import type { KeyId } from "@earendil-works/pi-tui";

export type KeyMatcher = (data: string, key: KeyId) => boolean;

/** Actions the WatchesView shell can take in response to a keypress. */
export type WatchesAction =
	| { kind: "ignore" }
	| { kind: "quit" }
	| { kind: "move-up" }
	| { kind: "move-down" }
	| { kind: "refresh" }
	| { kind: "toggle-display" }
	/** User pressed `d` on the selected row — shell should open unwatch-confirm. */
	| { kind: "begin-unwatch" }
	/** User pressed `D` — shell should open bulk-purge-terminal confirm. */
	| { kind: "begin-purge-terminal" }
	/** In confirm-mode: user pressed `y`. */
	| { kind: "confirm" }
	/** In confirm-mode: user pressed `n` or Escape. */
	| { kind: "cancel" };

/**
 * Map a raw input chunk to a {@link WatchesAction}. `inConfirmMode` is
 * the view's current confirm-state; when true, only `confirm` / `cancel`
 * actions are produced.
 */
export function dispatchKey(
	inConfirmMode: boolean,
	data: string,
	matchesKey: KeyMatcher,
): WatchesAction {
	if (inConfirmMode) {
		if (matchesKey(data, "y")) return { kind: "confirm" };
		if (matchesKey(data, "n") || matchesKey(data, "escape")) return { kind: "cancel" };
		return { kind: "ignore" };
	}

	if (matchesKey(data, "q") || matchesKey(data, "escape")) return { kind: "quit" };
	if (matchesKey(data, "up")) return { kind: "move-up" };
	if (matchesKey(data, "down")) return { kind: "move-down" };
	if (matchesKey(data, "r")) return { kind: "refresh" };
	if (matchesKey(data, "t")) return { kind: "toggle-display" };
	if (matchesKey(data, "d")) return { kind: "begin-unwatch" };
	if (data === "D") return { kind: "begin-purge-terminal" };
	return { kind: "ignore" };
}
