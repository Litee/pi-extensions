# pi-herdr-integration

Pi extension that auto-syncs the active [herdr](https://herdr.dev) workspace label to the pi session display name. Whenever the session name is set or changes — either on session start/restore or when the user types the built-in `/name` command — the extension renames the current herdr workspace to match. It is a no-op outside herdr (`HERDR_ENV !== "1"`).

## Trigger events

| Event | Behaviour |
|-------|-----------|
| `session_start` (startup, resume, reload, fork) | Restores `lastAppliedName` from session state, then calls `tryRenameWithName` with the current session name. |
| `input` | Regex-matches `/^\s*\/name\s+(\S.*?)\s*$/` and extracts the target name directly from the command text — does **not** wait for pi to process the command. |

No `agent_end` hook and no `session_shutdown` teardown.

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

State is restored on `session_start` so a `/reload` or fork does not re-rename unnecessarily.

## Caveats

Calls to `pi.setSessionName()` from other extensions and RPC `set_session_name` messages are **not** detected live by the `input` hook. Such name changes are picked up on the next `session_start` (e.g. after `/reload`).

## Subagent sessions are ignored

Subagents launched by the `pi-subagents` extension receive auto-generated session names in the form `<agent-type>#<hex-id>` (e.g. `andrey-implementer#763834d1`). These are internal identifiers, not human-chosen labels. Subagents run inside the same herdr pane as the parent session, so renaming on their `session_start` would clobber whatever label the parent session already set on the workspace. The extension skips any session name that matches the pattern `<word-chars>#<6+-hex-digits>`.
