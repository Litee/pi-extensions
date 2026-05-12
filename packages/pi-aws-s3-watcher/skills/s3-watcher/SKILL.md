---
name: s3-watcher
description: "Use this skill when watching an S3 object for changes — waiting for an object to appear, detecting it was updated, or detecting removal. Triggers on: s3_watcher, watch S3 object, monitor S3 object, wait for S3 object to exist, S3 object ready, poll S3, detect S3 change."
---

# AWS S3 Object Watcher

Use this skill when monitoring an S3 object for changes: waiting for a
object to appear, detecting that it has been updated, or detecting removal.

Do not use for watching S3 buckets or prefixes — only a single object
URI is supported. For high-frequency event-driven needs prefer SNS/SQS;
this watcher polls on a 60 s – 15 min back-off schedule.

## Activation required

Activate `s3_watcher` before use — it is inactive by default to avoid
adding it to the system prompt on every session and busting the prefix
cache.

```
manage_tools({"action": "activate", "tools": ["s3_watcher"]})
```

`manage_tools` is provided by the `pi-tools-runtime-manager` extension.
If the call fails with "unknown tool", that extension is not installed —
ask the user to install it before continuing. The tool becomes available
on the next turn after activation.

## What the tool does

`s3_watcher` polls `HeadObject` on a back-off schedule (60 s base,
doubling to a 15 min cap) and fires **one** chat notification when the
watched condition is met. After firing it marks itself terminal — there
is no repeating stream. On timeout (if `timeoutSeconds` was set), one
chat notification is also injected and the watch is marked terminal.

## Actions

### add — start a new watch

```
s3_watcher({
  "action": "add",
  "uri":     "s3://my-bucket/path/to/object.json",
  "target":  "exists" | "updated" | "removed",
  "profile": "my-aws-profile",
  "region":  "us-east-1",          // optional, inferred from profile if omitted
  "timeoutSeconds": 3600           // optional; watch self-cancels after this long
})
```

| Target    | Fires when |
|-----------|------------|
| `exists`  | Object was absent at add time, now present |
| `updated` | Object existed at add time, same key but ETag or size changed |
| `removed` | Object existed at add time, now absent (404) |

`updated` is rejected if the object is absent at add time (no ETag to diff against).

### remove

```
s3_watcher({"action": "remove", "watchId": "<id from list>"})
```

### list

```
s3_watcher({"action": "list"})
```

Returns one line per watch: `[id] uri target state`.

### pause / resume

```
s3_watcher({"action": "pause"})
s3_watcher({"action": "resume"})
```

Global toggle, persisted across session reload.

### status

```
s3_watcher({"action": "status"})
```

Shows paused/active state, watch count, and current poll interval.

## Authentication

Credentials are read from `~/.aws/credentials` / `~/.aws/config` via the
`profile` parameter (same profiles used by the `aws` CLI). Pass the
profile name you would use with `aws --profile <name>`.

## Error handling

| Error | Cause | What to do |
|---|---|---|
| `manage_tools` not found | `pi-tools-runtime-manager` not installed | Ask the user to install the extension, then restart pi |
| `CredentialsProviderError` / `ExpiredToken` on `add` | Stale session | Run `aws sso login --profile <name>`, then retry `add` |
| `AccessDenied` on `add` | Profile lacks `s3:GetObject` or `s3:HeadObject` on the target key | Check IAM policy for the profile; `AccessDenied` is not transient — the watch will never fire |
| `NoSuchBucket` on `add` | Bucket does not exist or is in a different region | Verify bucket name and pass the correct `region` |
| Watch added but never fires | Target condition not met, or polling paused | Call `s3_watcher({action:"status"})` to check state; `s3_watcher({action:"list"})` to inspect the watch |

Auth errors during polling (after `add` succeeds) are back-off'd silently and do not emit chat notifications. Call `status` if a watch seems stale.

## Typical workflow

1. Activate the tool (once per session):
   ```
   manage_tools({"action": "activate", "tools": ["s3_watcher"]})
   ```
2. On the next turn, add a watch:
   ```
   s3_watcher({"action": "add", "uri": "s3://bucket/key", "target": "exists", "profile": "default"})
   ```
3. The agent returns immediately. When the condition is met, a chat
   notification is injected automatically and a new LLM turn starts.

## Related Skills

- `personal-aws-settings` — look up which AWS profile to use for a specific account before calling `add`
