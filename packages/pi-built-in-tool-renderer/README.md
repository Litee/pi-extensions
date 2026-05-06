# pi-built-in-tool-renderer

Pi extension that re-registers the built-in `read`, `bash`, `edit`, and `write`
tools with compact custom renderers while delegating execution to the originals.

> **Source:** derived from
> [`pi-coding-agent/examples/extensions/built-in-tool-renderer.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts)
> (MIT, © Mario Zechner). The `read` / `edit` / `write` renderers are copied
> as-is. The `bash` renderer has been extended to (a) use `context.isError`
> (the authoritative non-zero-exit signal) instead of a regex match against
> stdout, (b) parse the real `Command exited with code N` message for the
> exit code, and (c) display the execution duration inline on the status
> line (ticking every second while the command is running).

## What it does

Each built-in tool is re-registered under the same name, which replaces the
original registration. Execution is delegated to the original tool instance
created via `createReadTool()` / `createBashTool()` / `createEditTool()` /
`createWriteTool()`, so behaviour is unchanged. Only the visible output in the
TUI is replaced.

Collapsed (default) renderers show:

| Tool  | Collapsed output                                              |
|-------|---------------------------------------------------------------|
| read  | `read <path>` header and `N lines` (+ `(truncated from M)` when applicable) |
| bash  | `$ <command>` header and `✓ done · N lines · 1.2s` / `✗ exit N · 1.2s` with live-ticking elapsed time while running |
| edit  | `edit <path>` header and `+additions / -removals` summary     |
| write | `write <path> (N lines)` header and `Written`                 |

Expanded renderers (ctrl+e) add up to 15 lines of content for `read`, 20 lines
for `bash`, and 30 lines of the unified diff for `edit`.

## Usage

With the extension loaded (either via the monorepo config, a local
`-e ./path/to/index.ts`, or an installed pi package) the built-in tools render
with the compact output above. Toggle a tool open with `ctrl+e` (or the
`app.tools.expand` binding) to see the expanded view.

## Customising

The renderers are straightforward; edit `src/index.ts` and adjust the
`renderCall` / `renderResult` bodies:

- Change the `slice(0, 15)` / `slice(0, 20)` / `slice(0, 30)` line caps
- Replace exit-code parsing or diff-stat counting with different heuristics
- Add conditional formatting based on `result.details` (typed via
  `ReadToolDetails`, `BashToolDetails`, `EditToolDetails`)

See the [pi extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
for the full rendering API.
