# pi-cmux-cli-guard

Pi extension that blocks bash tool calls referencing `focused.workspace_ref`
and directs the LLM to use `caller.workspace_ref` from `cmux identify --json`
instead.

## Behaviour

Any `bash` tool call whose command string contains `focused.workspace_ref` is
blocked. The LLM receives a clear error message explaining the rule and how to
obtain the correct `caller.workspace_ref`.

Commands that use `caller.workspace_ref`, plain bash commands, and `cmux
identify --json` (which outputs both refs for inspection) are allowed through
unchanged.

## Rule enforced

> When using cmux, you MUST use `caller.workspace_ref` from `cmux identify
> --json` for self-referential operations — never `focused.workspace_ref`.

## Why this extension?

The LLM may not always distinguish between `caller.workspace_ref` (its own
workspace) and `focused.workspace_ref` (the focused session's workspace). This
extension provides a hard guard: any attempt to use the prohibited reference is
blocked at the tool-call level with an explicit reminder of the correct pattern.
