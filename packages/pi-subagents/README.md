# pi-subagents

Copy of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (MIT, © tintinweb): A pi extension that brings Claude Code-style autonomous sub-agents to pi. Registers the `Agent`, `get_subagent_result`, and `steer_subagent` tools, along with a `/agents` management command. Supports foreground and background execution, agent types defined via `.pi/agents/*.md` files, smart group notifications, scheduled agents (cron/interval/one-shot), worktree isolation, and a live agent-activity sidebar widget.

## Differences from upstream

- **Collapsed `get_subagent_result` output.** Added a `renderResult` to the `get_subagent_result` tool. In collapsed mode the result is shown as a single summary line — `✓`/`✗`/`○` icon followed by agent type · status · description — with `… ctrl-o to expand` below it. Pressing Ctrl-o expands to the full result text, each line dim-styled with a two-space indent. Upstream renders the raw text blob with no collapsing.
