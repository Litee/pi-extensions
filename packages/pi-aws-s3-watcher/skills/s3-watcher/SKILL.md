# AWS S3 Object Watcher

Use this skill when monitoring an S3 object for changes: waiting for a
file to appear, detecting that it has been updated, or detecting removal.

## ⚠️ Activation required

**`s3_watcher` is inactive by default.** Before calling any `s3_watcher`
action you MUST activate it:

```
manage_tools({"action": "activate", "tools": ["s3_watcher"]})
```

This requires the `pi-tools-runtime-manager` extension. The tool becomes
available on the next turn after activation.

## What the tool does

`s3_watcher` polls `HeadObject` on a back-off schedule (60 s base,
doubling to a 15 min cap) and fires **one** chat notification when the
watched condition is met. After firing it marks itself terminal — there
is no repeating stream.

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
