---
name: aws-ec2-watcher
description: "Use when watching an AWS EC2 instance for state transitions — waiting for an instance to start, stop, or terminate. Triggers on: ec2_instance_watcher, watch EC2 instance, monitor EC2 state, wait for EC2 to start, wait for EC2 to stop, EC2 lifecycle, poll EC2, detect EC2 state change, EC2 status check, wait for instance ready, instance running, i- instance ID."
---

# aws-ec2-watcher

Watch an AWS EC2 instance for state transitions and get notified in chat when its state changes.

## When to use this skill

Use when:
- Monitoring an EC2 instance until it reaches `running`, `stopped`, or `terminated` state
- Getting notified when a long-running EC2 operation completes (e.g., instance startup, shutdown, termination)
- Watching an instance with an optional timeout
- Managing multiple concurrent instance watches

Do not use for:
- Fleet-wide monitoring of many instances — use CloudWatch Events/EventBridge instead
- Sub-minute precision — base poll interval is 60 s
- Instance health checks or CPU/memory metrics — use CloudWatch metrics for those

## Activation required

Activate `ec2_instance_watcher` before use — it is inactive by default to avoid
adding it to the system prompt on every session and busting the prefix cache.

```
manage_tools({"action": "activate", "tools": ["ec2_instance_watcher"]})
```

`manage_tools` is provided by the `pi-tools-management-tool` extension.
If `manage_tools` is not available, install the `pi-tools-management-tool` package first.
If the call fails with "unknown tool", that extension is not installed —
ask the user to install it before continuing. The tool becomes available
on the next turn after activation.

## Actions

### `add` — Start watching an EC2 instance

```
ec2_instance_watcher({
  action: "add",
  instanceId: "i-0a1b2c3d4e5f67890",
  profile: "my-aws-profile",
  region: "us-east-1",          // optional; falls back to profile default
  stopOnStopped: false,          // optional; mark terminal when instance reaches "stopped"
  timeoutSeconds: 3600           // optional; max 259200s (72h); defaults to 72h
})
```

- `instanceId` must match `i-[0-9a-f]{8,17}`
- If the instance is **not found**, `add` is rejected immediately
- If seeding fails for any other reason, the watch is added without a baseline and retried on the next poll

### `remove` — Stop watching

```
ec2_instance_watcher({ action: "remove", watchId: "<watchId>" })
```

### `list` — Show all watches

```
ec2_instance_watcher({ action: "list" })
```

### `pause` / `resume` — Toggle polling globally

```
ec2_instance_watcher({ action: "pause" })
ec2_instance_watcher({ action: "resume" })
```

### `status` — Show runtime state

```
ec2_instance_watcher({ action: "status" })
```

## State machine

`terminated` is always terminal. `stopped` is terminal only when `stopOnStopped: true` (default `false`); all other states (`pending`, `running`, `stopping`, `shutting-down`) are transient and emit change events but keep the watch active.

## Poll schedule

- Base interval: **60 seconds**
- Idle back-off: doubles up to **10 minutes** when no state change is detected
- Resets to base on any observed change

## Notifications

When a state change is detected, a chat message is injected automatically:

```
[10:30] 1 event detected

• EC2 i-0a1b2c3d4e5f67890: running → terminated ✓
```

Event types:
- `state_changed` — the instance state changed
- `not_found` — the instance no longer exists (always terminal)
- `timeout` — the watch timed out before reaching terminal state

## TUI menu

Open the interactive menu with `/ec2-watcher`:
- **Browse watches** — view and manage active watches
- **Paused** — toggle polling on/off
- **Display mode** — switch between widget (below editor) and status-line
- **User default display mode** — persist your preferred display mode

## Authentication

Credentials are read from `~/.aws/credentials` / `~/.aws/config` via the
`profile` parameter (same profiles used by the `aws` CLI). Pass the
profile name you would use with `aws --profile <name>`.

For SSO profiles, refresh credentials with `aws sso login --profile <name>`
before the session starts. The watcher picks up refreshed credentials on the
next poll automatically — no restart required.

## Error handling

| Error | Cause | What to do |
|---|---|---|
| `manage_tools` not found | `pi-tools-management-tool` not installed | Install the extension, then restart pi |
| `CredentialsProviderError` / `ExpiredToken` | Stale SSO session | Run `aws sso login --profile <name>`, then retry; watcher picks up refreshed creds on next poll |
| `AccessDenied` / `UnauthorizedOperation` | Profile lacks `ec2:DescribeInstances` | Check IAM policy; `AccessDenied` is not transient — add the permission before retrying |
| `InvalidInstanceID.NotFound` | Instance was deleted after `add` succeeded | Watch goes terminal with a `not_found` event; no action needed |
| Region mismatch | Instance is in a different region than the profile default | Pass the correct `region` param explicitly |
| `RequestLimitExceeded` | EC2 API throttling | Back-off kicks in automatically; recovers without action |

## Common mistakes / Gotchas

- **`running` is not terminal** — the watcher keeps polling after the instance starts. Use `timeoutSeconds` to bound it if you only care that the instance reached `running`.
- **`stopOnStopped` defaults to `false`** — the watch survives a stop/start cycle. Set `stopOnStopped: true` if a `stopped` state should end the watch.
- **Silent partial success on seed failure** — if seeding fails (e.g., transient API error), the watch is added without a baseline and retried on the next poll. No error is surfaced; call `list` to verify the watch exists.
- **`watchId` is required for `remove`** — copy it from the `add` response or from `list` output; there is no lookup by `instanceId`.

## Examples

### Full end-to-end: wait for instance to reach running

```
// Step 1 — activate (once per session)
manage_tools({"action": "activate", "tools": ["ec2_instance_watcher"]})

// Step 2 (next turn) — add a watch
ec2_instance_watcher({
  action: "add",
  instanceId: "i-0a1b2c3d4e5f67890",
  profile: "dev",
  region: "us-east-1",
  timeoutSeconds: 600
  // 'running' is not terminal — watcher keeps polling until timeout fires
  // or until 'terminated' (or 'stopped' if stopOnStopped: true)
})

// Step 3 — confirm the watch is registered
ec2_instance_watcher({ action: "list" })
// → [abc123] i-0a1b2c3d4e5f67890  state:pending  target:running  timeout:600s
```

### Wait for termination (stop when stopped)

```
ec2_instance_watcher({
  action: "add",
  instanceId: "i-0a1b2c3d4e5f67890",
  profile: "prod",
  stopOnStopped: true
})
```

## Related Skills

- `personal-aws-settings` — look up which AWS profile to use for a specific account before calling `add`
- `pi-tools-management-tool` — prerequisite extension that provides `manage_tools` for activation
