# pi-session-namer

Pi extension that auto-syncs the active [herdr](https://herdr.dev) workspace label to the pi
session display name. It is a no-op outside herdr (`HERDR_ENV !== "1"`).

## Trigger events

| Event | Behaviour |
|-------|-----------|
| `session_start` (startup, resume, reload, fork) | Resets guards and attempts an immediate rename with the current session name. |
| `agent_end` | Checks whether the session name changed since the last successful rename; renames if so. Catches `/name` and any other name-change mechanism that takes effect before a turn ends. |

## Commands

### `/name-session-and-space <label>`

Sets the pi session name **and** immediately renames the herdr workspace to match — no waiting
for the next turn.

```
/name-session-and-space my feature branch
```

Outside herdr, the command still calls `pi.setSessionName()` to name the pi session; the herdr
rename is a no-op (guards inside `tryRenameWithName` short-circuit when `HERDR_ENV !== "1"`).

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HERDR_ENV` | Yes (must be `"1"`) | Set automatically by herdr. The extension is a no-op when this is absent or not `"1"`. |
| `HERDR_PANE_ID` | Yes (effectively) | Format `p_<N>` (e.g. `p_6`). Passed directly to `herdr pane get` to retrieve the stable `workspace_id` hash for the pane that owns this pi process. Returns `null` (no rename) when absent — there is no fallback to the focused workspace, since the focused workspace is whichever one the user is *looking at* in the UI, which may differ from where the agent process lives. |

## Session state

Persisted under the custom type key **`pi-session-namer:state`** via `pi.appendEntry`. Shape:

```ts
{
  lastAppliedName: string;   // name successfully applied to herdr
  herdrWorkspaceId: string;  // workspace number used in the rename call
  appliedAt: number;         // Date.now() at time of rename
}
```

State is written on every successful rename but is intentionally **not** restored on
`session_start` — guards are always reset so the workspace is relabeled fresh on every
new herdr context (startup, resume, fork, reload).

## Caveats

- The built-in `/name` command is handled at the TUI layer before extension routing, so the
  `input` event never fires for it. The extension picks up the new name at `agent_end` (end of
  the next turn). The same applies to `pi.setSessionName()` calls from other extensions or RPC
  `set_session_name` messages. Use `/name-session-and-space` when you want the herdr workspace
  renamed immediately without waiting for a turn.
- Rename failures are silently retried only when the session name changes or a new
  `session_start` fires. The backoff guard (`lastAttemptedName`) prevents repeated CLI
  calls and warning toasts for the same failing name.

## Subagent sessions are ignored

Subagents launched by the `pi-subagents` extension receive auto-generated session names in
the form `<agent-type>#<hex-id>` (e.g. `andrey-implementer#763834d1`). These are internal
identifiers, not human-chosen labels. Subagents run inside the same herdr pane as the parent
session, so renaming on their `session_start` would clobber whatever label the parent session
already set on the workspace. The extension skips any session name that matches the pattern
`<word-chars>#<6+-hex-digits>`.
