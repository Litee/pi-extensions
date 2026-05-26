/**
 * Chat-message and status-line formatters for pi-aws-ec2-watcher.
 *
 * Pure functions — no I/O, no timers, no runtime state.
 */

import { formatShortTime } from "pi-watcher-core/time";
import { statusLineColorAlias, type StatusLineColorAlias } from "pi-watcher-core/status-line";
export type { StatusLineColorAlias } from "pi-watcher-core/status-line";

import type { Ec2Event, WatchMap } from "./types.js";

export interface StatusLineResult {
	text: string;
	colorAlias: StatusLineColorAlias;
}

export interface StatusLineInput {
	watches: WatchMap;
	paused: boolean;
	/** Kept for API consistency with sibling watchers; no longer rendered. */
	pollIntervalMs: number;
	hasErrors?: boolean;
}

/**
 * Build the row shown in the pi status-line.
 *
 * | State            | Row                                | Alias   |
 * |------------------|------------------------------------|---------|
 * | Idle             | `aws-ec2: idle`                    | muted   |
 * | Active           | `aws-ec2: 3`                       | accent  |
 * | Active + errors  | `aws-ec2: 3 | ⚠ errors`            | warning |
 * | Paused           | `aws-ec2: 3 (paused)`              | muted   |
 * | Paused + errors  | `aws-ec2: 3 | ⚠ errors (paused)`   | warning |
 */
export function buildStatusLine(input: StatusLineInput): StatusLineResult {
	const { watches, paused, hasErrors } = input;
	const active = Object.values(watches).filter((w) => !w.terminal);
	if (active.length === 0) return { text: "aws-ec2: idle", colorAlias: "muted" };

	const parts: string[] = [`${active.length}`];
	if (hasErrors) parts.push("⚠ errors");

	const body = parts.join(" | ");
	const text = paused ? `aws-ec2: ${body} (paused)` : `aws-ec2: ${body}`;
	const colorAlias: StatusLineColorAlias =
		hasErrors ? "warning" : statusLineColorAlias(paused ? "paused" : "active");
	return { text, colorAlias };
}

/**
 * Build the chat-message content for a detected-change notification.
 */
export function buildChangeChatMessage(events: Ec2Event[], date: Date): string {
	const noun = events.length === 1 ? "event" : "events";
	const header = `[${formatShortTime(date)}] ${events.length} ${noun} detected`;
	const bullets = events.map((e) => e.formatted).join("\n");
	return `${header}\n\n${bullets}`;
}

/**
 * Build the header phrase summarising a watch list.
 */
export function buildWatchSummaryHeader(watches: WatchMap): string | undefined {
	const all = Object.values(watches);
	if (all.length === 0) return undefined;
	const total = all.length;
	const done = all.filter((w) => w.terminal).length;
	const active = total - done;
	const noun = total === 1 ? "instance" : "instances";
	if (done === 0) return `active — watching ${total} ${noun}`;
	if (active === 0) return `watching ${total} ${noun} (${done} done)`;
	return `watching ${total} ${noun} · ${active} active, ${done} done`;
}

/**
 * Build the chat-message content for the startup summary.
 */
export function buildStartupChatMessage(watches: WatchMap, date: Date): string {
	const all = Object.values(watches);
	if (all.length === 0) {
		return "active — no watches configured. Use the ec2_instance_watcher tool to add a watch.";
	}
	const lines = all.map((w) => {
		const state = w.baseline === undefined ? "?" : w.baseline.state;
		const tag = w.terminal ? " [terminal]" : "";
		const name = w.baseline?.nameTag ? ` (${w.baseline.nameTag})` : "";
		return `• ${w.instanceId}${name} — state=${state}${tag}`;
	});
	const header = buildWatchSummaryHeader(watches) ?? "";
	return `[${formatShortTime(date)}] ${header}:\n\n${lines.join("\n")}`;
}
