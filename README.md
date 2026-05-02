# pi-extensions

Personal collection of extensions for Pi Agent.

## Packages

| Package | Description |
|---------|-------------|
| [`pi-ask-user-question`](packages/pi-ask-user-question) | Registers an `ask_user_question` tool so the LLM can open a tabbed TUI dialog for structured clarifying questions (single/multi-select, optional previews, free-text fallback). |
| [`pi-claude-code-skills-import`](packages/pi-claude-code-skills-import) | Imports Claude Code installed skills (user skills, plugin-cache skills, and project-local `.claude/skills`) into pi via `resources_discover`. |
| [`pi-local-issues-watcher`](packages/pi-local-issues-watcher) | Watches a `local-skill-issues-tracker` database on disk and injects issue change notifications into pi chat as `issue-watcher` custom messages. |

## Development

```bash
npm install
npm run check    # typecheck + tests
npm test         # vitest run
```
