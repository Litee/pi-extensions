# pi-extensions

Personal collection of extensions for Pi Agent.

## Packages

| Package | Description |
|---------|-------------|
| [`pi-ask-user-question`](packages/pi-ask-user-question) | Registers an `ask_user_question` tool so the LLM can open a tabbed TUI dialog for structured clarifying questions (single/multi-select, optional previews, free-text fallback). |
| [`pi-claude-code-skills-import`](packages/pi-claude-code-skills-import) | Imports Claude Code installed skills (user skills, plugin-cache skills, and project-local `.claude/skills`) into pi via `resources_discover`. |
| [`pi-cmux-notifications`](packages/pi-cmux-notifications) | Mirrors pi lifecycle events into cmux (sidebar status pill, log lines, notifications). Three-state pill: `idle`, `working`, `waiting` (the last fires for attention tools like `ask_user_question`). |
| [`pi-cmux-update-workspace-name`](packages/pi-cmux-update-workspace-name) | Auto-renames the cmux workspace once per pi session based on an LLM summary of the first user prompt, gated on cmux's default `Terminal ` title prefix, plus a `/cmux-rename` command for on-demand regeneration. |
| [`pi-local-issue-tracker-watcher`](packages/pi-local-issue-tracker-watcher) | Watches a `local-skill-issues-tracker` database on disk and injects issue change notifications into pi chat as `local-issue-watcher` custom messages. |
| [`pi-session-recap`](packages/pi-session-recap) | Copy of [`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap) (MIT, © Thomas Mustier): one-line recap widget above the editor when you refocus a pi session, with DECSET `?1004` focus reporting and an idle fallback. |
| [`pi-tool-info`](packages/pi-tool-info) | Registers a `/tool-info` command that lists every tool available in a pi session (builtin / sdk / extension / skill), with per-tool description, parameter schema, active/inactive state, and a compact `chars/4` token estimate. |

## Development

```bash
npm install
npm run check    # typecheck + tests
npm test         # vitest run
```
