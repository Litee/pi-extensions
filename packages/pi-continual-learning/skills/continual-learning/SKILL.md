---
name: continual-learning
description: "Use this skill when the agent is asked to consolidate memory, update AGENTS.md from session history, mine recent sessions for user preferences, or run continual learning. Triggers on: continual learning, consolidate memory, update AGENTS.md from history, mine session for preferences, memory consolidation, learn from session, capture durable preferences, update workspace facts."
---

# Continual Learning

Use when the agent should mine recent session history for durable signal and
surgically update `AGENTS.md` with learned user preferences and workspace facts.

This skill is typically triggered automatically by the `pi-continual-learning`
extension after enough activity has accumulated, but can also be invoked
manually.

## What this skill does

Dispatches a **memory-updater subagent** whose sole job is to:

1. Read the current conversation context and recent session history for
   durable signal (recurring corrections, explicit preferences, consistent
   style choices, stable facts about the codebase or project).
2. Update `AGENTS.md` in the project root (or cwd), editing **only** these
   two sections:
   - `## Learned User Preferences` — recurring corrections, style choices,
     workflow habits the user repeatedly applies.
   - `## Learned Workspace Facts` — durable truths about the codebase or
     project that are not already in AGENTS.md.
   If `AGENTS.md` does not exist, create it with **only** these two
   sections (no other content).
3. Make **surgical** edits: update or add individual bullets in place;
   deduplicate semantically similar bullets; keep each learned section to
   at most 12 bullets; never rewrite the whole file or touch other
   sections.
4. Exclude transient details, one-offs, and any secrets or credentials.
5. If nothing meaningful is found, respond with exactly:
   `No high-signal memory updates.`
   and make no file changes.

## Activation

```
/skill:continual-learning
```

## Subagent prompt

Dispatch a subagent with the following prompt (substitute `{AGENTS_MD_PATH}`
with the absolute path to `AGENTS.md`):

---

You are a memory-consolidation assistant. Your only job is to update the
`## Learned User Preferences` and `## Learned Workspace Facts` sections of
`AGENTS.md` at `{AGENTS_MD_PATH}`.

**Instructions:**

1. Read the current conversation context for durable signal:
   - Recurring corrections the user has made (style, naming, approach).
   - Explicit preferences stated across multiple turns.
   - Stable workspace facts not already documented.

2. Open `{AGENTS_MD_PATH}`. If it does not exist, create it with **only**
   these two sections (no other content):
   - `## Learned User Preferences`
   - `## Learned Workspace Facts`
   If it exists but the two target sections are missing, append them at the
   end of the file.

3. Make **surgical** edits only:
   - Add new bullets to the relevant section.
   - Update existing bullets that are now stale.
   - Deduplicate semantically similar bullets.
   - Keep each learned section to at most 12 bullets.
   - Do NOT rewrite existing sections, delete content, or touch any other
     part of the file.

4. Exclude: one-off instructions, transient context, secrets, credentials,
   or anything that may not hold in a future session.

5. If you find no high-signal updates worth persisting, output exactly:
   `No high-signal memory updates.`
   and make no file changes whatsoever.

---

## Notes

- The extension automatically invokes this skill via
  `pi.sendMessage({ customType: "pi-continual-learning:consolidate", … }, { triggerTurn: true })`
  after the configured thresholds are met.
- The triggered turn itself produces an `agent_end` event, but both the
  `turnsSinceLastRun` reset (condition 2) and the `processedMarker` advance
  (condition 4) prevent immediate re-triggering.
- To adjust thresholds without modifying code, set environment variables:
  `PI_CONTINUAL_LEARNING_MIN_TURNS` (default 10),
  `PI_CONTINUAL_LEARNING_MIN_MINUTES` (default 120),
  or enable trial mode with `PI_CONTINUAL_LEARNING_TRIAL=1`
  (3 turns / 15 min thresholds, active for 24 h).
