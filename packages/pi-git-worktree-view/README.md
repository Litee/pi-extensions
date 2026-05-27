# pi-git-worktree-view

A pi extension that spins up a local HTTP server and opens a web-based git worktree explorer in your cmux browser panel.

## Features

- **Worktree list** — top bar lists every `git worktree` for the current repo. The main worktree is pre-selected; click any chip to switch.
- **Changed files** — left panel shows all changed files in the selected worktree (`git status --porcelain`), with colour-coded `M` / `A` / `D` / `R` / `?` badges.
- **Side-by-side diff** — right panel renders a proper side-by-side diff with line numbers, red/green colouring for removed/added lines, and neutral context lines. Untracked files are shown as fully-added.

## Usage

Install the extension in your pi session:

```
/install pi-git-worktree-view
```

The server starts automatically when your session starts. A notification appears with the URL (`http://localhost:<port>`), and if you are running inside **cmux** the browser panel opens automatically.

## Architecture

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry point — lifecycle wiring (`session_start` / `session_shutdown`) |
| `src/server.ts` | `node:http` server; `startServer(repoRoot)` → `{ port, close }` |
| `src/diff.ts`   | Unified-diff parser → side-by-side `DiffLine[]` records |
| `src/html.ts`   | Inline SPA HTML/CSS/JS string |

No npm runtime dependencies — only Node.js built-ins and pi peer dependencies.

## Keyboard / UI

- Click a worktree chip to load its changed files.
- Click a file row to load its diff.
- Each panel scrolls independently.
