/**
 * pi-thinking-level-control — pi extension.
 *
 * Adds separate keyboard shortcuts for stepping the agent's thinking level
 * up and down one rung at a time. Distinct from pi core's
 * `app.thinking.cycle`, which cycles single-direction through all levels.
 *
 * The level ladder is derived dynamically from the active model's supported
 * thinking levels at shortcut-press time (via getSupportedThinkingLevels from
 * @earendil-works/pi-ai), so models that support "xhigh" (e.g. Opus) step all
 * the way up to xhigh while others stop at "high".
 *
 *   - ctrl+]  → step up one rung (no-op at the top)
 *   - ctrl+[  → step down one rung (no-op at "off")
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Key } from "@earendil-works/pi-tui";

/** Fallback used when ctx.model is undefined (shouldn't happen at shortcut time). */
const FALLBACK_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function nextLevel(
	levels: readonly string[],
	current: string,
	direction: 1 | -1,
): string | null {
	const idx = levels.indexOf(current);
	if (idx === -1) {
		// Off-ladder (e.g. xhigh on a model that doesn't list it):
		// decrease snaps to top of ladder; increase is a no-op.
		return direction === -1 ? (levels[levels.length - 1] ?? null) : null;
	}
	const nextIdx = idx + direction;
	if (nextIdx < 0 || nextIdx >= levels.length) return null;
	return levels[nextIdx] ?? null;
}

export default function thinkingLevelControl(pi: ExtensionAPI): void {
	pi.registerShortcut(Key.ctrl("]"), {
		description: "Increase thinking level",
		handler: (ctx) => {
			const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : FALLBACK_LEVELS;
			const next = nextLevel(levels, pi.getThinkingLevel(), 1);
			if (next === null) return;
			pi.setThinkingLevel(next as ThinkingLevel);
			ctx.ui.notify(`Thinking: ${next}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrl("["), {
		description: "Decrease thinking level",
		handler: (ctx) => {
			const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : FALLBACK_LEVELS;
			const next = nextLevel(levels, pi.getThinkingLevel(), -1);
			if (next === null) return;
			pi.setThinkingLevel(next as ThinkingLevel);
			ctx.ui.notify(`Thinking: ${next}`, "info");
		},
	});
}
