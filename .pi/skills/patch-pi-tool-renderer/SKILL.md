---
name: patch-pi-tool-renderer
description: >
  Patch the pi-coding-agent package after an upgrade to remove inner vertical
  padding from tool blocks, giving the compact tool renderers a denser layout.
  Use when asked to "patch pi tool renderer", "apply compact tool block patch",
  "remove tool block padding", "patch pi after upgrade", or "tighter tool layout".
---

# patch-pi-tool-renderer

Pi's built-in `Box` component adds one blank line of vertical padding inside
every coloured tool block by default. The `pi-built-in-tool-renderer` extension
already strips unnecessary whitespace from the text it produces, but the outer
box padding is applied unconditionally by the host component and cannot be
overridden from an extension.

This patch sets `paddingY` to `0` in `tool-execution.js` so that tool output
starts and ends flush with the coloured border — no blank line between the
border and the first or last line of text. It is purely cosmetic and must be
re-applied after each `pi` upgrade.

## Step 1 — Locate the pi package

```bash
PI_DIST=$(dirname $(realpath $(which pi)))
# e.g. /Users/you/.local/share/mise/installs/node/24.x.x/lib/node_modules/@earendil-works/pi-coding-agent/dist
# OR:  /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist
```

Confirm the target file exists:

```bash
ls "$PI_DIST/modes/interactive/components/tool-execution.js"
```

## Step 2 — Verify the line to patch

```bash
grep -n 'new Box(1, 1,' "$PI_DIST/modes/interactive/components/tool-execution.js"
```

Expected output (line number may vary after upgrades):

```
46:        this.contentBox = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
```

If the line is missing or the signature looks different, the upstream component
has changed — read it manually before patching.

## Step 3 — Apply the patch

```bash
sed -i '' 's/new Box(1, 1, (text) => theme\.bg("toolPendingBg", text))/new Box(1, 0, (text) => theme.bg("toolPendingBg", text))/' \
  "$PI_DIST/modes/interactive/components/tool-execution.js"
```

Verify it took effect:

```bash
grep -n 'new Box(1,' "$PI_DIST/modes/interactive/components/tool-execution.js"
# Should now read: new Box(1, 0, ...
```

## Notes

- Leave the `Spacer(1)` a few lines above the patched line untouched — that is
  the gap *between* tool blocks, not the padding inside them.
- This change touches only the compiled JS. There is no TypeScript source to
  update; the change survives until the next `npm install` / version upgrade of
  `@earendil-works/pi-coding-agent`.
- Re-run this skill after every `pi` upgrade.
