# pi-thinking-tokens-counter

Shows the estimated number of tokens consumed by the thinking block, plus the average tokens-per-second rate, in the collapsed/hidden thinking label.

## How it works

- Listens to `message_start` events to track individual assistant messages
- Listens to `message_update` events during streaming
- Extracts all `thinking` content from the message
- Estimates token count from character length (~4 chars/token, a rough heuristic)
- Calls `ctx.ui.setThinkingTokenCount(count, { messageId, rate })` to update the label with per-message scoping

## Requirements

- Requires a patched pi agent that exposes `ctx.ui.setThinkingTokenCount(count, options)`
- Works best with `hideThinkingBlock: true` (toggle with `/thinking` or the built-in toggle)

## Label format

```
_Thinking… [2.1k tokens 1.3/s]_
```

Tokens are formatted with k/M suffixes. Rate shows average tokens per second since the start of thinking.
