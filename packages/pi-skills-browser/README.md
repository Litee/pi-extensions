# pi-skills-browser

Pi extension that registers a `/skills` command for interactively browsing every skill registered in the current pi session.

## Features

- **Scope grouping** — skills are grouped by file path into two sections: `USER-SKILLS` (skills loaded from `~/.pi/agent/skills/`) and `PROJECT` (a catch-all for every other skill — project `.pi/skills/`, `~/.agents/skills/`, package `skills/` directories, skills added via `settings.json` or `--skill`, and skills injected by other extensions). Classification is purely path-based: anything outside `~/.pi/agent/skills/` lands in `PROJECT`.
- **Name + token count** — shows each skill's name alongside a compact description token estimate (`chars/4` heuristic)
- **Two sort modes** — press `Ctrl-S` to toggle between alphabetical by name (default) and descending by description token count
- **Filter as you type** — any printable character narrows the list by case-insensitive substring match on the skill name
- **Windowed scrolling** — handles large skill sets (100+ skills) with viewport-clamped rendering and section headers

## Usage

```
/skills
```

### Keybindings

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate the list |
| `Ctrl-S` | Toggle sort: name ↔ tokens↓ |
| any printable char | Add to filter query |
| `⌫` Backspace | Remove last filter character |
| `Esc` | Close |

## How token counts work

Token count is estimated as `ceil(description.length / 4)` — the same heuristic pi uses
internally. It counts only the skill's description string (the `<description>` metadata
in `SKILL.md`), not the full skill body. This gives a quick indicator of how much each
skill contributes to the system prompt when loaded.
