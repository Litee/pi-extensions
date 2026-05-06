# pi-context-window-analysis

Pi extension that adds a `/context` command with a per-component token breakdown widget — similar to Claude Code's `/context`.

## Usage

```
/context           Toggle the breakdown widget on/off
/context refresh   Force-refresh without toggling
/context help      Show help
```

## Widget

```
──── Context Breakdown ──────────────────────────────
System prompt        ████████░░░░░░░░░░░░  38%  ~9.8k
  core instructions  ████████░░░░░░░░░░░░  82%  ~8.0k
  tools              █░░░░░░░░░░░░░░░░░░░   9%  ~0.9k
  guidelines         ░░░░░░░░░░░░░░░░░░░░   3%  ~0.3k
  AGENTS.md          ░░░░░░░░░░░░░░░░░░░░   4%  ~0.4k
  skills catalog     ░░░░░░░░░░░░░░░░░░░░   2%  ~0.2k
Conversation         ████░░░░░░░░░░░░░░░░  22%  ~5.7k
  user messages      ██░░░░░░░░░░░░░░░░░░  45%  ~2.6k
  assistant output   ██░░░░░░░░░░░░░░░░░░  40%  ~2.3k
  tool results       ░░░░░░░░░░░░░░░░░░░░  15%  ~0.9k
──── Last turn (actual) ─────────────────────────────
  input sent         ████████████████████ 100%  15.5k
  cache read         ████████████████░░░░  78%  12.1k
  cache write        █░░░░░░░░░░░░░░░░░░░   5%   0.8k
  output             █░░░░░░░░░░░░░░░░░░░   3%   0.5k
  cost               $0.0023
─────────────────────────────────────────────────────
Total  ~25.4k / 200k  (12.7%)  ████░░░░░░░░░░░░░░░░
```

## Token estimation

Uses the same `chars / 4` heuristic pi uses internally. Per-component
estimates are derived by reconstructing each system-prompt section (tools
snippets, guidelines, context files, skills XML block) then computing core
as the remainder.

Last-turn numbers come from the actual API usage on the most recent
`AssistantMessage` in the session branch (zero cost when the session has
not yet completed a turn).
