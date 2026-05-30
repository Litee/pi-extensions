# pi-built-in-tool-renderer

Pi extension that re-registers the built-in `read`, `bash`, `edit`, and
`write` tools with compact custom renderers while delegating execution to
the originals. Also adds renderers for `grep`, `ls`, and `find` (no upstream
equivalent).

Use it when the default built-in-tool output is too noisy and you want a
tighter, glanceable view in the TUI without changing tool behaviour.

## What it does

Each built-in tool is re-registered under the same name, which replaces the
original registration. Execution is delegated to the original tool instance
created via `createReadTool()` / `createBashTool()` / `createEditTool()` /
`createWriteTool()`, so behaviour is unchanged. Only the visible output in
the TUI is replaced.

Collapsed (default) renderers show:

| Tool  | Collapsed output                                              |
|-------|---------------------------------------------------------------|
| read  | `read <path>` header and `N lines` (+ `(truncated from M)` when applicable) |
| bash  | `$ <command>` header and `✓ done · N lines · 1.2s` / `✗ exit N · 1.2s` with live-ticking elapsed time while running |
| edit  | `edit <path>` header and `+additions / -removals` summary     |
| write | `write <path> (N lines)` header and `Written`                 |

Expanded renderers (`ctrl+e`, or the `app.tools.expand` binding) add up to
15 lines of content for `read`, 20 lines for `bash`, and 30 lines of the
unified diff for `edit`.

## Customising

Edit `src/index.ts` and adjust the `renderCall` / `renderResult` bodies:

- Change the `slice(0, 15)` / `slice(0, 20)` / `slice(0, 30)` line caps.
- Replace exit-code parsing or diff-stat counting with different heuristics.
- Add conditional formatting based on `result.details` (typed via
  `ReadToolDetails`, `BashToolDetails`, `EditToolDetails`).

See the [pi extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
for the full rendering API.

## Attribution

This package is a port of
[`pi-coding-agent/examples/extensions/built-in-tool-renderer.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts)
(MIT, © Mario Zechner). The locally-added `grep` / `ls` / `find` renderers
and the `bash` renderer extensions listed below are original to this
port by Andrey Lipatkin. See [`UPSTREAM.md`](./UPSTREAM.md) for the
exact copied commit and a recipe for diffing against future upstream
changes.

## Differences from upstream

Not exhaustive — just the highlights that matter if you are considering
copying this package. Here is what you will be picking up on top of the
upstream example:

- **`bash` renderer extensions.** Uses `context.isError` (the authoritative
  non-zero-exit signal) instead of regex-matching stdout; parses the real
  `Command exited with code N` / `Command timed out after Ns` / `Command
  aborted` sentinels for the failure label; displays the execution duration
  inline on the status line, ticking every second while the command is
  running.
- **Renderers for `grep`, `ls`, and `find`.** Added locally; no upstream
  equivalent. Same collapsed / expanded pattern as the other renderers.
- **Shell preservation fix.** Removed an erroneous `renderShell: self` on
  the edit-tool re-registration (upstream had the same line in the example
  at copy time, since fixed there).
- **Expanded bash view.** Shows the full command verbatim instead of
  truncating to a single line.

## License

MIT (inherited from the upstream). See [`LICENSE`](LICENSE).
