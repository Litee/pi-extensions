/**
 * Pure key-dispatch for the EC2 WatchesView.
 */

import type { KeyId } from "@earendil-works/pi-tui";

export type KeyMatcher = (data: string, key: KeyId) => boolean;

export type WatchesAction =
	| { kind: "ignore" }
	| { kind: "quit" }
	| { kind: "move-up" }
	| { kind: "move-down" }
	| { kind: "refresh" }
	| { kind: "toggle-display" }
	/** User pressed `x` on the selected row — shell should open stop-confirm. */
	| { kind: "begin-stop" }
	/** User pressed `s` on the selected row — shell should open start-confirm. */
	| { kind: "begin-start" }
	/** User pressed `d` on the selected row — shell should open unwatch-confirm. */
	| { kind: "begin-unwatch" }
	| { kind: "begin-purge-terminal" }
	| { kind: "confirm" }
	| { kind: "cancel" };

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
	if (matchesKey(data, "x")) return { kind: "begin-stop" };
	if (matchesKey(data, "s")) return { kind: "begin-start" };
	if (matchesKey(data, "d")) return { kind: "begin-unwatch" };
	if (data === "D") return { kind: "begin-purge-terminal" };
	return { kind: "ignore" };
}
