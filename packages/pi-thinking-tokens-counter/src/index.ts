import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Rough heuristic: ~4 chars per token for English text
// const CHARS_PER_TOKEN = 4;

export default function (pi: ExtensionAPI): void {
  let currentMessageId: number | null = null;
  let thinkingCharCount = 0;
  // let startTime = 0;

  // Reset when a new assistant message starts
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      currentMessageId = event.message.timestamp;
      thinkingCharCount = 0;
      // startTime = Date.now();
    }
  });

  // Listen to message_update events during streaming
  pi.on("message_update", (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    // Skip if this is not the current streaming message
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
      // const estimatedTokens = Math.round(chars / CHARS_PER_TOKEN);
      // const elapsed = (Date.now() - startTime) / 1000;
      // const rate = elapsed > 0 ? estimatedTokens / elapsed : 0;
      // ctx.ui.setThinkingTokenCount(estimatedTokens, { messageId: currentMessageId, rate });
    }
  });
}
