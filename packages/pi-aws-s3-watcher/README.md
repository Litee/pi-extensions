# pi-aws-s3-watcher

Pi extension that watches a single S3 object URI for **existence**,
**update**, or **removal** using the AWS SDK v3. When the watched
condition is met — or when an optional per-watch timeout elapses — it
fires exactly one chat notification (`customType:
"pi-aws-s3-watcher"`, `triggerTurn: true`) and marks the watch
terminal. The extension is auto-enabled: the `s3_watcher` tool is
registered and active from `session_start` with no `/s3-watcher enable`
gate required.

## Polling schedule

Polling runs on a back-off-aware scheduler from `pi-watcher-core`:

- **Base:** 60 s.
- **Idle back-off:** each quiet poll doubles the interval, up to a
  **15 min cap**.
- **Reset:** any observable change to the watched object (existence
  flip OR ETag/size change) snaps the interval back to the base.
- **Throttle / auth back-off:** an `@aws-sdk/client-s3`
  `CredentialsProviderError`, `ExpiredToken`, `SlowDown`, or
  `ThrottlingException` doubles the effective interval without
  touching the idle base.
- **Re-entry guard:** a slow `HeadObject` call can never be re-entered
  by the timer — the next tick is scheduled from the END of the
  previous tick.

When every watch is terminal the poll loop stops.

## Tool: `s3_watcher`

| Action   | Required params                               | Notes                                                                 |
|----------|-----------------------------------------------|-----------------------------------------------------------------------|
| `add`    | `uri`, `target`, `profile`                    | Optional: `region`, `timeoutSeconds`. Seeds a baseline via HeadObject.|
| `remove` | `watchId`                                     | Stops polling the final active watch.                                 |
| `list`   | —                                             | One line per watch: `[id] uri target state`.                          |
| `pause`  | —                                             | Global. Persisted across session reload.                              |
| `resume` | —                                             | Restarts polling iff at least one non-terminal watch exists.          |
| `status` | —                                             | Paused/active, watch counts, current poll interval.                   |

### Targets

| Target    | Fires when                                                                      |
|-----------|---------------------------------------------------------------------------------|
| `exists`  | Baseline said `absent`, now `present`.                                          |
| `updated` | Baseline existed, now exists, AND ETag or Content-Length differs. `add` rejects this target if the object is absent at add time — there is no ETag to diff against.|
| `removed` | Baseline existed, now `absent` (HeadObject 404 / NoSuchKey / NotFound).         |

A fired watch emits **one** bullet-list chat message then self-marks terminal. There is no repeating notification stream.

### Timeout

`timeoutSeconds` (optional, positive number). If the target condition has
not fired by `addedAt + timeoutSeconds`, the watcher emits a single
`timeout` event and marks the watch terminal. Omit for no timeout —
the watch polls indefinitely until manually removed.

## `/s3-watcher` command

| Subcommand | Effect                                                                 |
|------------|------------------------------------------------------------------------|
| (no args)  | Notify the runtime status (active/paused, watch counts, poll interval).|
| `status`   | Alias for no-args.                                                     |
| `pause`    | Stop polling. Persisted — survives session reload.                     |
| `resume`   | Resume polling.                                                        |

## Authentication

Credentials resolve through `fromIni({ profile })`, so the same
`~/.aws/credentials` / `~/.aws/config` layout used by the `aws` CLI is
picked up. A SigV4 session token refresh from `aws sso login` or
`aws sso login` is read on the next poll without restarting pi.

## Security notes

- No subprocess spawns. All AWS access goes through
  `@aws-sdk/client-s3` in-process.
- Raw SDK error messages land **only** in
  `pi.appendEntry("s3-watcher:poll-error", …)` — never in chat, tool
  output, or the status line. User-facing text comes from
  `pi-watcher-core`'s `classifyWatcherError`, whose output is
  guaranteed free of server-supplied strings.
- Persistence goes through `pi.appendEntry` only — no writes to
  arbitrary paths.

## Package layout

```
src/
  types.ts         — S3Watch, S3Event, baseline + target types
  uri.ts           — parseS3Uri, S3UriError
  s3-client.ts     — SDK-backed S3Client interface + HeadObject wrapper
  poller.ts        — snapshotObject, detectChanges, buildTimeoutEvent (pure)
  runtime.ts       — Runtime, PollScheduler, pollOnce
  toolAction.ts    — s3_watcher tool registration + handler
  persistence.ts   — createPersistence delegate
  format.ts        — chat message + status-line formatters
  index.ts         — session lifecycle + /s3-watcher command
test/
  uri.test.ts
  sdk-client.test.ts
  poller.test.ts
  runtime.test.ts
  toolAction.test.ts
  persistence.test.ts
  format.test.ts
  index.test.ts
```
