/**
 * pi-llm-response-length-guard — pi extension.
 *
 * Monitors streaming LLM output (thinking and response) in real-time.
 * When either exceeds a configurable length threshold, interrupts the
 * stream and sends a corrective steer message so the LLM learns to keep
 * responses concise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default thresholds (in characters, not tokens). */
const DEFAULT_THINKING_LIMIT = 8_192;
const DEFAULT_RESPONSE_LIMIT = 32_768;

/**
 * Configuration for the length guard.
 */
export interface LengthGuardConfig {
	/** Maximum characters for thinking (reasoning) content. 0 = disabled. */
	thinkingLimit?: number;
	/** Maximum characters for the actual response (non-thinking) content. 0 = disabled. */
	responseLimit?: number;
	/** Custom steer message sent when a limit is exceeded. */
	correctiveMessage?: string;
}

const defaultConfig: LengthGuardConfig = {
	thinkingLimit: DEFAULT_THINKING_LIMIT,
	responseLimit: DEFAULT_RESPONSE_LIMIT,
	correctiveMessage:
		"Your response was cut because it exceeded the allowed length. Please keep your next response shorter — aim for significantly fewer characters in both your thinking and your final response.",
};

export default function lengthGuardExtension(pi: ExtensionAPI): void {
	let isThinking = false;
	let thinkingChars = 0;
	let responseChars = 0;
	let hasInterruptedThisTurn = false;

	pi.on("message_update", (event, ctx) => {
		// Only monitor assistant messages
		if (!event.assistantMessageEvent) return;

		// Reset counters on thinking_start / text_start
		if (event.assistantMessageEvent.type === "thinking_start") {
			isThinking = true;
			thinkingChars = 0;
			responseChars = 0;
			hasInterruptedThisTurn = false;
			return;
		}

		if (event.assistantMessageEvent.type === "text_start") {
			isThinking = false;
			// responseChars already 0 from reset above, but be explicit
			responseChars = 0;
			return;
		}

		// Accumulate character counts from deltas
		// Only 'thinking_delta' and 'text_delta' have a delta property
		const evt = event.assistantMessageEvent;
		if (
			(evt.type === "thinking_delta" || evt.type === "text_delta") &&
			typeof evt.delta === "string" &&
			evt.delta.length > 0
		) {
			if (isThinking) {
				thinkingChars += evt.delta.length;
			} else {
				responseChars += evt.delta.length;
			}

			// Check thresholds — interrupt on first breach
			const config = defaultConfig;
			const exceeded =
				((config.thinkingLimit ?? 0) > 0 && thinkingChars > (config.thinkingLimit ?? 0)) ||
				((config.responseLimit ?? 0) > 0 && responseChars > (config.responseLimit ?? 0));

			if (exceeded && !hasInterruptedThisTurn && ctx.signal) {
				hasInterruptedThisTurn = true;

				// Abort the current stream
				ctx.abort();

				// Send a corrective steer message
				const limitType =
					(config.thinkingLimit ?? 0) > 0 && thinkingChars > (config.thinkingLimit ?? 0)
						? "thinking"
						: "response";

				const cutMessage = `${config.correctiveMessage}\n\n(The output was cut because the ${limitType} exceeded its length limit.)`;

				// customType is required — use a stable identifier
				pi.sendMessage(
					{ customType: "pi-llm-response-length-guard/cut-off", content: [{ type: "text", text: cutMessage }], display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
		}
	});

	// Reset state on turn boundaries
	pi.on("turn_end", () => {
		isThinking = false;
		thinkingChars = 0;
		responseChars = 0;
		hasInterruptedThisTurn = false;
	});
}
