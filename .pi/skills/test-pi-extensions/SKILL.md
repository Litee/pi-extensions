---
name: test-pi-extensions
description: "Use when E2E-testing pi coding-agent extensions in a live pi agent session — verifying behaviors that require the actual agent loop or TUI: auto-continue (triggerTurn), TUI renderResult output, interaction between extensions, or session lifecycle across resume/fork. Triggers on \"E2E test my extension\", \"verify the auto-continue fires\", \"test the TUI renderer\", \"test extension in a live session\", or any request to validate pi extension runtime behavior."
---

# E2E Testing Pi Agent Extensions in a Live Session

Use this skill for behaviors that cannot be exercised by unit tests with a mocked `ExtensionAPI`:

- `triggerTurn: true` actually starts a new agent run
- TUI `renderResult` output text/styling
- Interaction between two installed extensions
- Session lifecycle across resume/fork

For pure logic (tool results, param validation, mock `sendMessage` assertions) use unit tests via `bash` instead — no live pane needed.

> ⚠️ **Do not use herdr panes to run commands that work fine in `bash`** — `npm test`, `npx vitest`, `npm run check`, `tsc`, and similar CLI tools belong in a plain `bash` tool call. Spinning up a pane for these adds latency and complexity with no benefit.

---

## E2E testing in a live pi session (herdr)

> See the `herdr` skill for the full command reference.
>
> ⚠️ **Anchor every pane operation to your own pane id (`$HERDR_PANE_ID`), never to focus.** `herdr pane split` with no pane id — or with `--current` — targets the **focused** pane, i.e. whatever workspace the *user* is currently looking at, not the pane the agent lives in. If you omit the id, your test panes land in an unrelated herdr space the moment the user looks elsewhere. Always pass `$HERDR_PANE_ID` explicitly.

### 0. Confirm you are in herdr and capture your own pane — do this first, every time

```bash
[ "$HERDR_ENV" != "1" ] && echo "ERROR: not running inside herdr — abort E2E" && exit 1
MY_PANE="$HERDR_PANE_ID"        # e.g. wA:p1 — set by herdr, NOT focus-derived
echo "My pane: $MY_PANE"
# Optional: confirm the pane/workspace herdr thinks you live in
herdr pane get "$MY_PANE"
```

**Never close or send keys to `$MY_PANE`.** Keep this value in a shell variable for the whole session. Do not use `herdr pane list` + "focused pane" to identify yourself — focus is whatever the *user* is looking at, which is frequently a different workspace than the one your pi process runs in. Always use `$HERDR_PANE_ID`.

### 1. Install the extension under test (same as before)

```bash
# Install from a local path (worktree or package dir)
pi install -l /path/to/packages/<pkg>

# Confirm it loaded — grep for the package name
pi extensions list | grep <pkg>
```

If the package doesn't appear: check that the path is correct, that `package.json` exists at that path, and that the package builds cleanly (`npx tsc -b /path/to/packages/<pkg>`). Reload pi (`pi reload`) and check again.

> Note: `pi install -l` takes effect on the next `session_start`. Start a fresh pi session in step 2 — the session in your main surface won't pick up the change.

### 2. Create a test pane and start pi

Split your *own* pane with `--no-focus` so the new pane stays in the agent's
workspace and the user's view is left undisturbed. Parse the new pane id from
the JSON response.

```bash
TEST_PANE=$(herdr pane split "$HERDR_PANE_ID" --direction down --no-focus \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
[ -z "$TEST_PANE" ] && echo "ERROR: pane split failed" && exit 1
echo "Test pane: $TEST_PANE"

# Start pi in the new pane — use --no-session for ephemeral test runs:
# no .jsonl is written, nothing is persisted or resumed, stale extension
# state (e.g. displayMode) from previous runs cannot bleed in.
# `pane run` sends the text and a real Enter in one request.
herdr pane run "$TEST_PANE" "pi --no-session"

# Block until pi's input prompt appears instead of guessing with sleep
herdr wait output "$TEST_PANE" --match "›" --timeout 30000 || \
  herdr pane read "$TEST_PANE" --source recent --lines 10
```

### 3. Send a test prompt

```bash
# Send a prompt that exercises the behavior under test
herdr pane run "$TEST_PANE" "<your test prompt here>"
# Wait for the response to land (match on expected output where possible)
herdr wait output "$TEST_PANE" --match "<expected text>" --timeout 60000
```

### 4. Read and verify output

```bash
herdr pane read "$TEST_PANE" --source recent --lines 50
# Use --source recent-unwrapped to inspect the same transcript wait matched against
```

For auto-continue verification (e.g. `pi-tools-management-tool`), look for evidence that a new agent turn started without user input — typically a second LLM response or a status transition from idle to active after the tool result landed. Exact phrasing varies by pi version; check that the turn count incremented or that a new response appeared.

### 5. Clean up

```bash
echo "About to close: $TEST_PANE (my pane: $HERDR_PANE_ID)"
[ "$TEST_PANE" = "$HERDR_PANE_ID" ] && echo "ERROR: same pane!" && exit 1

herdr pane close "$TEST_PANE"

# Uninstall the local extension if you don't want it permanently
pi uninstall <pkg>
```

---

## Gotchas

- **`herdr pane split` returns JSON with the new pane id at `result.pane.pane_id`.** Parse it with the `python3` one-liner in step 2; don't guess the id.
- **A freshly split pane is at a shell prompt, but pi may not be ready immediately after `herdr pane run "$TEST_PANE" "pi --no-session"`.** Use `herdr wait output` to block on the pi input prompt before sending prompts.
- **`pi install -l` takes effect on the next `session_start`.** The already-running pi session in your own pane won't pick up the change; the fresh session in step 2 will.
- **`herdr pane read` shows recent scrollback, not necessarily the full pi transcript.** Use `--lines` large enough to capture the full exchange. `--source recent-unwrapped` joins soft-wrapped lines back together (matches what `wait output --source recent` matched against); `--source visible` is just the current viewport.

### Workspace and pane management

- **Anchor every pane operation to a known pane id, never to focus.** Your own pane is `$HERDR_PANE_ID`; new panes come from the `result.pane.pane_id` of a `herdr pane split` response. `herdr pane split` with no id — or with `--current` — splits the **focused** pane (the workspace the user is looking at), so test panes land in an unrelated space. Do not use `herdr pane list` + "focused pane" to pick a target either, for the same reason.
- **Always split your own pane (`herdr pane split "$HERDR_PANE_ID" …`) with `--no-focus`.** This keeps the test pane in the agent's own tab/workspace and leaves the user's focus untouched. Do **not** create a new workspace (`herdr workspace create`) for tests — it is not visible alongside the current session and the user can accidentally interact with it.
- **Pane ids compact when panes/tabs/workspaces close.** Don't assume an id is still the same pane later in a long session; re-read it from `herdr pane list` or a split response when in doubt. `$HERDR_PANE_ID` for your own pane stays valid for the session.

### Loading the right extension version from a worktree

- **Pi deduplicates packages by resolved absolute path, not by package name.** If the user-level `settings.json` loads `/repo/packages/pkg` and a worktree `.pi/settings.json` adds `./packages/pkg` (which resolves to `/repo/.worktrees/branch/packages/pkg`), these are *different* paths — both load. The user-level package (loaded first) wins the extension-name conflict, so the worktree version is silently ignored.
- **The `_` prefix in a `packages` array entry disables resources (extensions/skills) within a package, not the package itself.** `"_/path/to/pkg"` does not prevent that package from loading.
- **Workaround: copy the changed file(s) to the main package temporarily, test, restore from git.**
  ```bash
  cp <worktree>/packages/pkg/src/foo.ts /repo/packages/pkg/src/foo.ts
  # ... run E2E ...
  git -C /repo checkout packages/pkg/src/foo.ts
  ```

### Session state

- **Pi determines the session directory from the *git root*, not the cwd.** A pi instance launched from a worktree (`/repo/.worktrees/branch/`) uses the same session directory as one launched from `/repo/`. Extension state (watches, display mode, etc.) persists across the two and can bleed into tests unexpectedly.
- **Use `pi --no-session` for test runs.** No session file is written and nothing is resumed on restart — eliminates state bleed and stale `displayMode` entirely. Extension state still initialises from defaults (`state?.field ?? default`) so `session_start` fires normally.
- **Deleting session `.jsonl` files while pi is running does not clear in-memory state.** The process keeps its file handle open; the unlinked file is written back when pi exits, recreating it. Kill pi first, then delete.
- **Persisted `displayMode` flips toggle commands.** Extension state (e.g. `displayMode = "statusline"`) is reloaded on `session_resume`. If a previous session left the display in `statusline`, the next `/ext display` command toggles it *to* `widget` (opposite of intent). Use `pi --no-session` to avoid this entirely, or check current mode before toggling.

### Testing widget show/hide bugs specifically

- **Avoid triggering `s3:change` (or equivalent) via an LLM tool call (add/remove watch) when testing hide-then-re-show bugs.** Adding a watch causes a full LLM turn and a `turn_end` handler that may call `show(ctx)` or `hide(ctx)` via a separate code path, masking or falsely triggering the bug. Instead, **wait for the background poll timer** to fire `s3:change` naturally — it is the exact scenario the fix covers and involves no LLM turn.
- **The poll timer uses exponential backoff on no-change (doubles each cycle, up to ~15 min).** After several polls against a fake/unreachable bucket the interval may be 240 s or more. Set a short `timeoutSeconds` on test watches so they expire during the next poll, giving the poll something to act on and keeping the wait predictable.
- **Both the widget panel and the statusline status can appear simultaneously** when a session resumes with stale state. This is an artifact of a previous partial test run, not necessarily the bug being tested.

---

## Anti-patterns

- ❌ **Running `npm test`, `npx vitest`, `npm run check`, or `tsc` inside a herdr pane** — these are plain bash commands; use the `bash` tool directly
- ❌ Treating `sendMessage` mock assertions as proof that `triggerTurn` works end-to-end
- ❌ Sending prompts before confirming pi is ready (step 2 `herdr wait output`)
- ❌ Closing your own pane — always guard with `[ "$TEST_PANE" = "$HERDR_PANE_ID" ]`
- ❌ Identifying your pane (or any split target) by "which pane is focused" — use `$HERDR_PANE_ID` and parsed split ids
- ❌ Splitting with no pane id or with `--current` — both target the focused (often wrong) workspace

## Related Skills

- `herdr` — full herdr command reference (splits, run, read, wait output, wait agent-status)
- `tdd` — red-green-refactor loop for writing the unit tests before the extension code
- `verification-before-completion` — before claiming the extension works, run the full check and observe actual output
- `systematic-debugging` — when E2E output does not match expectations, use this to diagnose
