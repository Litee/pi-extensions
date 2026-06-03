---
name: git-watcher
description: "Use this skill when watching a local Git repository for changes — new commits on a branch, branch creation/deletion, or tag creation. Triggers on: git_watcher, watch git repo, monitor git branch, wait for commit, detect new git commit, watch for tag, detect branch created, detect branch deleted, poll git, local git watcher, watch local repo."
---

# Git Repository Watcher

Use when monitoring a local Git repository for:
- New commits on a tracked branch (`new_commit`)
- Any local branch being created (`branch_created`) or deleted (`branch_deleted`)
- Any local tag being created (`tag_created`)

Do **not** use for watching remote refs directly — this watcher polls **local** refs only and does not run `git fetch`.

## Activation required

```
manage_tools({"action": "activate", "tools": ["git_watcher"]})
```

Requires `pi-tools-management-tool` to be installed. If the tool is not found, activate it first.

## What the tool does

`git_watcher` polls `git for-each-ref` and `git rev-parse` on a back-off schedule (60 s base, doubling to 15 min cap) and fires a chat notification whenever a watched condition is met. **Continuous** — the watch keeps firing for each subsequent change. Use `remove` to stop it. An optional `timeoutSeconds` adds a hard cap.

## Actions

### add — start a new watch

```
git_watcher({
  "action":        "add",
  "repoPath":      "/Users/me/code/my-project",
  "branch":        "main",
  "targets":       ["new_commit", "tag_created"],
  "timeoutSeconds": 86400
})
```

| Target | Fires when |
|---|---|
| `new_commit` | The watched branch's HEAD SHA changes. Branch must exist at add time. |
| `branch_created` | Any new local branch appears in the repo. |
| `branch_deleted` | Any local branch is removed from the repo. |
| `tag_created` | Any new local tag appears in the repo. |

### remove
```
git_watcher({"action": "remove", "watchId": "<id from add response>"})
```

### list / pause / resume / status
```
git_watcher({"action": "list"})
git_watcher({"action": "pause"})
git_watcher({"action": "resume"})
git_watcher({"action": "status"})
```

## Polling schedule

Base 60 s, doubling each idle cycle to a 15 min cap. Resets to base on any observable repo change (HEAD move, branch added/removed, tag added).

## Error handling

| Error | Cause | Remedy |
|---|---|---|
| `not a git repository` | `repoPath` is not a git work tree | Check the path |
| `branch '<b>' does not exist` | Branch missing at add time | Create the branch first |
| `git CLI not found in PATH` | `git` not installed | Install git |
| `git index locked` | Concurrent git operation writing | Transient — watcher backs off automatically |
| `manage_tools: git_watcher not found` | Tool not activated | Run `manage_tools({"action":"activate","tools":["git_watcher"]})` |

## Typical workflow

1. Activate the tool:
   `manage_tools({"action":"activate","tools":["git_watcher"]})`
2. Add a watch:
   `git_watcher({"action":"add","repoPath":"/path/to/repo","branch":"main","targets":["new_commit"]})`
3. Notifications fire each time a commit lands on `main`.
4. When done: `git_watcher({"action":"remove","watchId":"<id>"})`
