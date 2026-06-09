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

This patch sets `paddingY` to `0` in two places so that tool output starts
and ends flush with the coloured border — no blank line between the border
and the first or last line of text. It is purely cosmetic and must be re-applied
after each `pi` upgrade.

## Step 1 — Locate the pi package

```bash
PI_DIST=$(dirname $(realpath $(which pi)))
# e.g. /Users/you/.local/share/mise/installs/node/24.x.x/lib/node_modules/@earendil-works/pi-coding-agent/dist
# OR:   /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist
```

Confirm the target files exist:

```bash
ls "$PI_DIST/modes/interactive/components/tool-execution.js"
ls "$PI_DIST/core/tools/edit.js"
```

## Step 2 — Verify the lines to patch

### 2a. `tool-execution.js` (shared outer box for all non-self-rendering tools)

```bash
grep -n 'new Box(1, 1,' "$PI_DIST/modes/interactive/components/tool-execution.js"
```

Expected output (line number may vary after upgrades):

```
46:    this.contentBox = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
```

### 2b. `edit.js` (inner box + spacing gaps unique to the edit tool)

The `edit` tool is the only one that uses `renderShell: "self"`, which bypasses
the outer Box entirely. It has its own inner `Box(1, 1, ...)` for the call
renderer and two `Spacer(1)` separators between components.

```bash
grep -n 'new Box(1, 1,' "$PI_DIST/core/tools/edit.js"
grep -n 'component\.addChild(new Spacer(1))' "$PI_DIST/core/tools/edit.js"
```

Expected output (line numbers may vary):

```
58:    return Object.assign(new Box(1, 1, (text) => text), {
...
140:    component.addChild(new Spacer(1));
...
275:            component.addChild(new Spacer(1));
```

If any lines are missing or look different, the upstream component has changed —
read it manually before patching.

## Step 3 — Apply the patches

### 3a. Patch `tool-execution.js`

```bash
sed -i '' 's/new Box(1, 1, (text) => theme\.bg("toolPendingBg", text))/new Box(1, 0, (text) => theme.bg("toolPendingBg", text))/' \
 "$PI_DIST/modes/interactive/components/tool-execution.js"
```

### 3b. Patch `edit.js`

Strip inner box padding:

```bash
sed -i '' 's/new Box(1, 1, (text) => text)/new Box(1, 0, (text) => text)/' \
 "$PI_DIST/core/tools/edit.js"
```

Shrink spacing gaps between header↔preview and result↔output:

```bash
sed -i '' 's/component\.addChild(new Spacer(1))/component.addChild(new Spacer(0))/' \
 "$PI_DIST/core/tools/edit.js"
```

## Step 4 — Verify

```bash
grep -n 'new Box(1,' "$PI_DIST/modes/interactive/components/tool-execution.js"
# Should now read: new Box(1, 0, ...

grep -n 'new Box(1,' "$PI_DIST/core/tools/edit.js"
# Should now read: new Box(1, 0, ...

grep -n 'Spacer(' "$PI_DIST/core/tools/edit.js"
# Should now read: Spacer(0) on all occurrences
```

## Notes

- Leave the `Spacer(1)` a few lines above the patched line in `tool-execution.js`
  untouched — that is the gap *between* tool blocks, not the padding inside them.
- This change touches only the compiled JS. There is no TypeScript source to
  update; the change survives until the next `npm install` / version upgrade of
  `@earendil-works/pi-coding-agent`.
- Re-run this skill after every `pi` upgrade.
