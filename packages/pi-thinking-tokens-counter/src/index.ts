import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Rough heuristic: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;

// Throttle status updates to once per second
const THROTTLE_MS = 1000;

export default function (pi: ExtensionAPI): void {
  let currentMessageId: number | null = null;
  let thinkingCharCount = 0;
  let displayedTokens = 0;
  let displayedRate = 0;
  let lastUpdate = 0;
  let prevTokens = 0;
  let prevTime = 0;
  let firstSample = true;

  // Reset when a new assistant message starts
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      currentMessageId = event.message.timestamp;
      thinkingCharCount = 0;
      displayedTokens = 0;
      displayedRate = 0;
      lastUpdate = 0;
    }
  });

  // Listen to message_update events during streaming
  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (event.message.timestamp !== currentMessageId) return;

    // Sum up all thinking content in the current message
    let chars = 0;
    for (const part of event.message.content) {
      if (part.type === "thinking" && part.thinking) {
        chars += part.thinking.length;
      }
    }

    // Only update if we have new thinking content
    if (chars > thinkingCharCount) {
      thinkingCharCount = chars;
      const estimatedTokens = Math.round(chars / CHARS_PER_TOKEN);
      const now = Date.now();
      const deltaTime = (now - prevTime) / 1000;
      const rawRate = deltaTime > 0
        ? (estimatedTokens - prevTokens) / deltaTime
        : 0;

      // Throttle: only update if at least THROTTLE_MS ms since last update
      if (now - lastUpdate < THROTTLE_MS) return;
      lastUpdate = now;
      prevTokens = estimatedTokens;
      prevTime = now;

      // Exponential moving average for smoothing (alpha=0.4)
      displayedRate = firstSample
        ? rawRate
        : 0.4 * rawRate + 0.6 * displayedRate;
      firstSample = false;

      // Update display only if values changed (reduces flicker)
      if (estimatedTokens !== displayedTokens) {
        displayedTokens = estimatedTokens;
        const formattedTokens = estimatedTokens < 1000
          ? String(estimatedTokens)
          : `${(estimatedTokens / 1000).toFixed(1)}k`;
        ctx.ui.setStatus("thinking-tokens", `thinking: ${formattedTokens} t, ${displayedRate.toFixed(1)}/s`);
      }
    }
  });

  // Clear status when message ends
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant" && event.message.timestamp === currentMessageId) {
      currentMessageId = null;
      ctx.ui.setStatus("thinking-tokens", undefined);
    }
  });
}
