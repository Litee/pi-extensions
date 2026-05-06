/**
 * pi-thinking-level-control — pi extension.
 *
 * Adds separate keyboard shortcuts for stepping the agent's thinking level
 * up and down one rung at a time. Distinct from pi core's
 * `app.thinking.cycle`, which cycles single-direction through all levels.
 *
 * Ladder: ["off", "minimal", "low", "medium", "high"].
 *   - ctrl+]  → step up one rung (no-op at "high")
 *   - ctrl+[  → step down one rung (no-op at "off")
 *
 * Edge case: pi's ThinkingLevel also includes "xhigh" for some model
 * families. Increase from "xhigh" is a no-op; decrease snaps to "high".
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
type LadderLevel = (typeof LEVELS)[number];

export function nextLevel(current: string, direction: 1 | -1): LadderLevel | null {
	const idx = LEVELS.indexOf(current as LadderLevel);
	if (idx === -1) {
		return direction === -1 ? "high" : null;
	}
	const nextIdx = idx + direction;
	if (nextIdx < 0 || nextIdx >= LEVELS.length) return null;
	return LEVELS[nextIdx] ?? null;
}

export default function thinkingLevelControl(pi: ExtensionAPI): void {
	pi.registerShortcut(Key.ctrl("]"), {
		description: "Increase thinking level",
		handler: async (ctx) => {
			const next = nextLevel(pi.getThinkingLevel(), 1);
			if (next === null) return;
			pi.setThinkingLevel(next);
			ctx.ui.notify(`Thinking: ${next}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrl("["), {
		description: "Decrease thinking level",
		handler: async (ctx) => {
			const next = nextLevel(pi.getThinkingLevel(), -1);
			if (next === null) return;
			pi.setThinkingLevel(next);
			ctx.ui.notify(`Thinking: ${next}`, "info");
		},
	});
}
