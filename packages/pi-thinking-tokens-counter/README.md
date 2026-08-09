# pi-thinking-tokens-counter

Shows the number of tokens consumed by the thinking block, plus the average tokens-per-second rate, in the collapsed/hidden thinking label.

## How it works

- Listens to `message_start` events to track individual assistant messages
- During `message_update` streaming, extracts all `thinking` content and shows a live estimate: token count from character length (~4 chars/token heuristic), throttled to one update per second, with an EMA-smoothed tokens/second rate
- On `message_end`, replaces the estimate with the provider's exact thinking-token count (`usage.reasoning`) when the provider reports one, shown as `thinking: N t (exact)`; otherwise clears the status
- Calls `ctx.ui.setStatus("thinking-tokens", ...)` to update the label

## Requirements

- pi >= 0.81.0 (root-exported `Message*Event` types and `usage.reasoning` exact count)
- Works best with `hideThinkingBlock: true` (toggle with `/thinking` or the built-in toggle)

## Label format

```
_Thinking… [2.1k tokens 1.3/s]_   (live estimate during streaming)
_Thinking… [1.2k t (exact)]_      (final exact count at message_end)
```

Tokens are formatted with k suffixes. Rate shows average tokens per second since the start of thinking.
