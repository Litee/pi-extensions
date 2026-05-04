# pi-extensions

Personal collection of extensions for Pi Agent.

## Packages

| Package | Description |
|---------|-------------|
| [`pi-ask-user-question`](packages/pi-ask-user-question) | Registers an `ask_user_question` tool so the LLM can open a tabbed TUI dialog for structured clarifying questions (single/multi-select, optional previews, free-text fallback). |
| [`pi-claude-code-skills-import`](packages/pi-claude-code-skills-import) | Imports Claude Code installed skills (user skills, plugin-cache skills, and project-local `.claude/skills`) into pi via `resources_discover`. |
| [`pi-local-issue-tracker-watcher`](packages/pi-local-issue-tracker-watcher) | Watches a `local-skill-issues-tracker` database on disk and injects issue change notifications into pi chat as `local-issue-watcher` custom messages. |
| [`pi-session-recap`](packages/pi-session-recap) | Copy of [`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap) (MIT, © Thomas Mustier): one-line recap widget above the editor when you refocus a pi session, with DECSET `?1004` focus reporting and an idle fallback. |
| [`pi-tool-info`](packages/pi-tool-info) | Registers a `/tool-info` command that lists every tool available in a pi session (builtin / sdk / extension / skill), with per-tool description, parameter schema, active/inactive state, and a compact `chars/4` token estimate. |
| [`pi-update-cmux-status`](packages/pi-update-cmux-status) | Mirrors pi lifecycle events into cmux (sidebar status pill, log lines, progress, notifications) and auto-renames the cmux workspace from an LLM summary of the first user prompt. |

## Development

```bash
npm install
npm run check    # typecheck + tests
npm test         # vitest run
```
