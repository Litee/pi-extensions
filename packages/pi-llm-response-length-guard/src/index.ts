/**
 * pi-llm-response-length-guard — pi extension.
 *
 * Monitors streaming LLM output (thinking and response) in real-time.
 * When either exceeds a configurable length threshold, interrupts the
 * stream and sends a corrective steer message so the LLM learns to keep
 * responses concise.
 *
 * Provides a `/llm-response-length-guard` slash command that prints
 * extension statistics for the current session.
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
		"Your response was cut because it exceeded the allowed length. Please keep your next response shorter — aim for significantly fewer characters in both your thinking and your final response. If the task is complex, break it into smaller pieces.",
};

/**
 * Session statistics tracked by the length guard.
 */
export interface LengthGuardStats {
	/** Total number of interruptions this session. */
	interruptionCount: number;
	/** Total thinking characters monitored this session. */
	totalThinkingChars: number;
	/** Total response characters monitored this session. */
	totalResponseChars: number;
	/** Details of the most recent interruption, or undefined. */
	lastInterruption: {
		/** Which limit was exceeded: "thinking" or "response". */
		limitType: "thinking" | "response";
		/** Character count at time of interruption. */
		charCount: number;
		/** Threshold that was exceeded. */
		limit: number;
		/** How far over the limit (in characters). */
		overBy: number;
	} | undefined;
}

export default function lengthGuardExtension(pi: ExtensionAPI): void {
	let isThinking = false;
	let thinkingChars = 0;
	let responseChars = 0;
	let hasInterruptedThisTurn = false;

	/** Session-scoped statistics. */
	const stats: LengthGuardStats = {
		interruptionCount: 0,
		totalThinkingChars: 0,
		totalResponseChars: 0,
		lastInterruption: undefined,
	};

	// Register the /llm-response-length-guard slash command
	pi.registerCommand("llm-response-length-guard", {
		description: "Show length guard statistics: interruptions, chars monitored, thresholds, and last interruption details.",
		// eslint-disable-next-line @typescript-eslint/require-await
		handler: async (_args, ctx) => {
			const config = defaultConfig;
			const totalChars = stats.totalThinkingChars + stats.totalResponseChars;
			const last = stats.lastInterruption;

			const lines: string[] = [];
			lines.push("🛡️ **LLM Response Length Guard — Session Stats**");
			lines.push("");
			lines.push(`**Interruptions:** ${stats.interruptionCount}`);
			lines.push(`**Total chars monitored:** ${totalChars.toLocaleString()} (thinking: ${stats.totalThinkingChars.toLocaleString()}, response: ${stats.totalResponseChars.toLocaleString()})`);
			lines.push("");
			lines.push("**Thresholds:**");
			lines.push(`- Thinking: ${config.thinkingLimit?.toLocaleString() ?? "disabled"} chars`);
			lines.push(`- Response: ${config.responseLimit?.toLocaleString() ?? "disabled"} chars`);

			if (last) {
				lines.push("");
				lines.push(`**Last interruption:**`);
				lines.push(`- Exceeded: ${last.limitType} (${last.charCount.toLocaleString()} chars, limit: ${last.limit.toLocaleString()}, over by ${last.overBy.toLocaleString()})`);
			} else {
				lines.push("");
				lines.push("**Last interruption:** none this session");
			}

			lines.push("");
			lines.push(`**Corrective message:**\n\`${config.correctiveMessage}\``);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

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
				stats.totalThinkingChars += evt.delta.length;
			} else {
				responseChars += evt.delta.length;
				stats.totalResponseChars += evt.delta.length;
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

				const limit = limitType === "thinking" ? (config.thinkingLimit ?? 0) : (config.responseLimit ?? 0);
				const charCount = limitType === "thinking" ? thinkingChars : responseChars;

				// Update stats
				stats.interruptionCount += 1;
				stats.lastInterruption = {
					limitType,
					charCount,
					limit,
					overBy: charCount - limit,
				};

				const cutMessage = `${config.correctiveMessage}\n\n(The output was cut because the ${limitType} exceeded its length limit.)`;

				// customType is required — use a stable identifier
				pi.sendMessage(
					{ customType: "pi-llm-response-length-guard/cut-off", content: [{ type: "text", text: cutMessage }], display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
		}
	});

	// Reset per-turn counters on turn boundaries (but keep session stats)
	pi.on("turn_end", () => {
		isThinking = false;
		thinkingChars = 0;
		responseChars = 0;
		hasInterruptedThisTurn = false;
	});
}
