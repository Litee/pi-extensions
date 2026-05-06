# pi-worktree-guard

Pi extension that blocks file edits in the main repository and directs the LLM
to use git worktrees instead.

## Behaviour

Any `edit` or `write` tool call targeting a file in the main repository (i.e.
not inside a `.worktrees/` subdirectory) is blocked. The LLM receives a clear
error message with step-by-step worktree instructions.

Tool calls targeting worktree paths (`.worktrees/<branch>/...`) are allowed
through unchanged.

## Detection

The main repository root is detected once per session by running:

    git worktree list --porcelain

The result is cached until the next `session_start`. If detection fails (git
not available, not a git repo), the guard fails open and allows all edits.

## Why .worktrees/?

The project convention is to place worktrees at `.worktrees/<branch-name>/`
inside the main repo. Any path under that directory is treated as worktree work
and allowed. All other paths inside the repo are blocked.
