# pi-herdr-integration

Pi extension that auto-syncs the active [herdr](https://herdr.dev) workspace label to the pi
session display name. It is a no-op outside herdr (`HERDR_ENV !== "1"`).

## Trigger events

| Event | Behaviour |
|-------|-----------|
| `session_start` (startup, resume, reload, fork) | Resets guards, attempts an immediate rename with the current session name, then starts (or restarts) the 15-second idle poll. |
| `agent_end` | Checks whether the session name changed since the last successful rename; renames if so. Catches `/name` and any other name-change mechanism that takes effect before a turn ends. |
| 15-second poll (idle safety net) | Started inside `session_start`. Reads `pi.getSessionName()` (cheap, in-process) every 15 s and calls `tryRenameWithName` only when the name differs from what was last applied. Picks up `/name` and `pi.setSessionName()` calls made while the agent is idle, without waiting for the next turn. |
| `session_shutdown` | Clears the poll interval so the timer does not outlive the session. |

The poll callback relies entirely on the existing idempotency guards inside
`tryRenameWithName` (`name === lastAppliedName`, `name === lastAttemptedName`) to
avoid spurious subprocess calls — a steady-state poll with no name change is a
pure no-op.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HERDR_ENV` | Yes (must be `"1"`) | Set automatically by herdr. The extension is a no-op when this is absent or not `"1"`. |
| `HERDR_PANE_ID` | Yes (effectively) | Format `p_<N>` (e.g. `p_6`). Passed directly to `herdr pane get` to retrieve the stable `workspace_id` hash for the pane that owns this pi process. Returns `null` (no rename) when absent — there is no fallback to the focused workspace, since the focused workspace is whichever one the user is *looking at* in the UI, which may differ from where the agent process lives. |

## Session state

Persisted under the custom type key **`pi-herdr-integration:state`** via `pi.appendEntry`. Shape:

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
  `input` event never fires for it. The extension therefore relies on `agent_end` (picks up
  the change at the end of the next turn) and the 15-second idle poll (picks up the change
  within ~15 s even when the agent is idle). The same applies to `pi.setSessionName()` calls
  from other extensions or RPC `set_session_name` messages.
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
