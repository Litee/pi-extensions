---
name: file-system-watcher
description: "Use this skill when watching a local filesystem path (file or directory) for lifecycle events — waiting for a path to appear, detecting that it was modified, or detecting removal. Triggers on: file_system_watcher, watch file, watch directory, monitor filesystem path, wait for file to exist, file ready, file changed, file deleted, detect file change, local file watcher, poll file."
---

# Local Filesystem Watcher

Use this skill when monitoring a local filesystem path for changes:
waiting for a file or directory to appear, detecting that it was
modified (mtime/size change), or detecting removal.

Do not use for watching multiple paths simultaneously — only a single
path per watch is supported. This watcher uses polling on a 60 s – 15 min
back-off schedule.

## Activation required

Activate `file_system_watcher` before use — it is inactive by default to avoid
adding it to the system prompt on every session.

```
manage_tools({"action": "activate", "tools": ["file_system_watcher"]})
```

`manage_tools` is provided by the `pi-tools-management-tool` extension.
If the call fails with "unknown tool", that extension is not installed —
ask the user to install it before continuing. The tool becomes available
on the next turn after activation.

## What the tool does

`file_system_watcher` polls `fs.promises.stat` on a back-off schedule (60 s base,
doubling to a 15 min cap) and fires **one** chat notification when the
watched condition is met. After firing it marks itself terminal — there
is no repeating stream. On timeout, one notification is injected and the
watch is marked terminal. All watches have a maximum duration of 24 h —
`timeoutSeconds` defaults to 24 h if omitted and is silently capped at
24 h if higher.

## Actions

### add — start a new watch

```
file_system_watcher({
  "action": "add",
  "path":   "/absolute/or/relative/path",
  "target": "exists" | "changed" | "removed",
  "timeoutSeconds": 3600   // optional; defaults to 24 h; capped at 24 h
})
```

| Target    | Fires when |
|-----------|------------|
| `exists`  | Path was absent at add time, now present |
| `changed` | Path existed at add time, same path but `mtimeNs` or `size` changed |
| `removed` | Path existed at add time, now absent (ENOENT) |

`changed` is rejected if the path is absent at add time (no baseline to diff against).

### remove

```
file_system_watcher({"action": "remove", "watchId": "<id from list>"})
```

### list

```
file_system_watcher({"action": "list"})
```

Returns one line per watch: `path  status  timeout  target`.

### pause / resume

```
file_system_watcher({"action": "pause"})
file_system_watcher({"action": "resume"})
```

Global toggle, persisted across session reload.

### status

```
file_system_watcher({"action": "status"})
```

Shows paused/active state, watch count, and current poll interval.

## Error handling

| Error | Cause | What to do |
|-------|-------|------------|
| `manage_tools` not found | `pi-tools-management-tool` not installed | Ask the user to install the extension, then restart pi |
| `target='changed'` rejected at add time | Path does not exist | Wait for the path to exist (use `target='exists'` first), then add a `changed` watch |
| Watch added but never fires | Target condition not met, or polling paused | Call `file_system_watcher({action:"status"})` to check state; `file_system_watcher({action:"list"})` to inspect the watch |
| Threshold warning after N poll failures | `stat()` failing (permissions issue) | Check path accessibility |

## Typical workflow

1. Activate the tool (once per session):
   ```
   manage_tools({"action": "activate", "tools": ["file_system_watcher"]})
   ```
2. On the next turn, add a watch:
   ```
   file_system_watcher({"action": "add", "path": "/tmp/output.json", "target": "exists"})
   ```
3. The agent returns immediately. When the condition is met, a chat
   notification is injected automatically and a new LLM turn starts.

## Example: wait for a build output to appear

```
file_system_watcher({
  "action": "add",
  "path": "/workspace/dist/bundle.js",
  "target": "exists",
  "timeoutSeconds": 300
})
```

## Example: detect when a log file is modified

```
file_system_watcher({
  "action": "add",
  "path": "/var/log/app.log",
  "target": "changed"
})
```

## Example: watch a directory for any change

```
file_system_watcher({
  "action": "add",
  "path": "/data/incoming",
  "target": "changed"
})
```

For a directory, `changed` fires when the directory's own `mtime` or
`size` changes — i.e. when entries are added or removed inside it
(on most filesystems).
