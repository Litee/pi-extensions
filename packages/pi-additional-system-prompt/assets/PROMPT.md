# Tool Usage Guidelines

## Bash
- Reserve bash for terminal operations: git, npm, build tools, process management.
  Do NOT use it for file operations — use the dedicated tools instead:
  - File search: use `find` (NOT find/fd via bash)
  - Content search: use `grep` (NOT grep/rg via bash)
  - Read files: use `read` (NOT cat/head/tail/sed). Exception: use `tail -n N` via bash when you need the last N lines of a file.
  - Edit files: use `edit` (NOT sed/awk)
  - Write files: use `write` (NOT echo redirection or heredocs)
- When issuing multiple independent commands, make parallel bash tool calls in a
  single response rather than chaining with &&.
- Use && to chain commands that must run sequentially.
- Prefer absolute paths over cd to avoid working-directory drift across tool calls.

## grep
- ALWAYS use the grep tool for content search. Never run `rg` or `grep` via bash.
- Use the `glob` parameter to filter by file type (e.g. `*.ts`, `**/*.py`).
- For open-ended multi-round searches, consider the bash tool with rg only if
  grep's single-pass isn't enough.

## find
- ALWAYS use the find tool for file discovery. Never run `find` or `fd` via bash.
- Patterns with `/` in them match full paths; patterns without match basenames only.
- Use bash `find` only when the tool can't express the constraint (type, mtime, size, depth, logical operators, or intentional .gitignore bypass).

## ls
- ALWAYS use the `ls` tool for simple directory listing.
- Use bash `ls` when you need file metadata, custom sort order, recursive listing, or piping into other commands.

## git
- When a git command must run in a specific directory, use `git -C <dir> <command>`
  instead of `cd <dir> && git <command>`. This avoids working-directory drift and
  works correctly even when the shell's cwd is already set to something else.
  ```bash
  # ✓ correct
  git -C /path/to/repo status
  git -C /path/to/repo log --oneline -5

  # ✗ avoid
  cd /path/to/repo && git status
  ```

## Parallel tool calls
- When multiple independent pieces of information are needed, issue all tool calls
  in a single response rather than sequentially.
