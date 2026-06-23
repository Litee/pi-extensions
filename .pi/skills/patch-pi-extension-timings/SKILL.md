---
name: patch-pi-extension-timings
description: >
  Patch the installed pi-coding-agent package to print per-extension startup
  timings (load + handler costs) when PI_TIMING=1 is set. Use when asked to
  "patch pi extension timings", "measure extension startup time", "add
  per-extension load timing to pi", "re-apply the extension timing patch", or
  "patch pi after upgrade to profile extensions". Must be re-done after every
  `pi` upgrade, which overwrites dist/ and wipes the patch.
---

# patch-pi-extension-timings

pi ships a coarse startup profiler (`PI_TIMING=1`, printed in benchmark mode via
`PI_STARTUP_BENCHMARK=1` and on exit). It reports phase buckets like
`createAgentSessionRuntime` and `interactiveMode.init` but **does not break the
extension cost down per extension** — so you can't tell which extension is slow,
or whether the cost is in *loading* it vs in its *event handlers*. This skill
adds that breakdown by editing three compiled files. Everything is gated on
`PI_TIMING==="1"`, so with the env var unset it is a complete no-op.

> **How to use this skill.** Apply the edits below yourself with the `edit` tool.
> There is deliberately **no patch script**: pi's *compiled* JS changes across
> upgrades, so any frozen textual patch goes stale. Instead, the exact before→
> after blocks below are proven code to paste, and your `edit` tool's
> "must match a unique region" guarantee *is* the drift protection — if a `find`
> block no longer matches, the code moved, and you re-locate the site (by the
> structural signature given for each edit) and adapt. Read the target function
> before editing; if its shape differs from the block here, apply the *intent*
> (described per edit), not the literal text.

## What it adds

1. **Main timeline (per-extension load)** — one `ext <name>: <ms>` line per
   extension, subdividing the existing `createAgentSessionRuntime` bucket. Uses
   pi's existing delta-based `time()`, so **`TOTAL` stays exact**.
2. **Detail section (not in TOTAL)** — a new aggregation channel prints a
   `--- Detail timings (not in TOTAL) ---` block:
   - `[load] import <name>` — jiti module evaluation (the extension's heavy imports).
   - `[load] factory <name>` — the `factory(api)` registration call.
   - `[handler] <event> <name>` — time in each extension's handler per event
     (`session_start`, `resources_discover`, …), summed with `xN` on repeats.

   This is what attributes, e.g., the skills scan to
   `[handler] resources_discover pi-claude-code-skills-import` instead of hiding
   it inside `interactiveMode.init`.

## Step 1 — Locate the install

The pi launcher may be a wrapper script, so resolve the package via `npm`, not
`realpath $(which pi)`:

```bash
PIDIST="$(npm root -g)/@earendil-works/pi-coding-agent/dist"
node -p "require('$PIDIST/../package.json').version"   # which version you're patching
ls "$PIDIST/core/timings.js" "$PIDIST/core/extensions/loader.js" "$PIDIST/core/extensions/runner.js"
```

Before editing each file, **back it up** (so you can revert and so a re-run sees
pristine input):

```bash
for f in core/timings.js core/extensions/loader.js core/extensions/runner.js; do
  [ -f "$PIDIST/$f.bak" ] || cp -p "$PIDIST/$f" "$PIDIST/$f.bak"
done
```

To check whether it's already patched, grep for the markers
`addAggregate` (timings.js), `extensionLabel` (loader.js), `extLabel`
(runner.js); to revert, copy each `.bak` back.

## Step 2 — Apply the five edits

Apply each block with the `edit` tool against the file under `$PIDIST`. The
italic line on each edit is its **structural signature** — how to find the site
if the literal `find` text no longer matches after an upgrade.

### `core/timings.js`

**Edit A** — aggregation channel. *Signature: the `const timings = []` /
`resetTimings()` region near the top, gated on `process.env.PI_TIMING`.*

Find:
```js
const ENABLED = process.env.PI_TIMING === "1";
const timings = [];
let lastTime = Date.now();
export function resetTimings() {
    if (!ENABLED)
        return;
    timings.length = 0;
    lastTime = Date.now();
}
```
Replace:
```js
const ENABLED = process.env.PI_TIMING === "1";
const timings = [];
// [patch] Aggregation channel: labeled durations printed as a supplementary
// section that intentionally does NOT contribute to TOTAL (keeps the delta
// timeline exact). Used for per-extension import/factory + handler timings.
const aggregates = new Map();
let lastTime = Date.now();
export function resetTimings() {
    if (!ENABLED)
        return;
    timings.length = 0;
    aggregates.clear();
    lastTime = Date.now();
}
// [patch] Record an aggregated duration (ms) under a label; sums repeats.
export function addAggregate(label, ms) {
    if (!ENABLED)
        return;
    const cur = aggregates.get(label) ?? { ms: 0, count: 0 };
    cur.ms += ms;
    cur.count += 1;
    aggregates.set(label, cur);
}
```

**Edit B** — print the detail section. *Signature: the `printTimings()` function;
the new block goes after the existing `TOTAL` line and the early-return is
loosened so it prints when only aggregates exist.*

Find:
```js
export function printTimings() {
    if (!ENABLED || timings.length === 0)
        return;
    console.error("\n--- Startup Timings ---");
    for (const t of timings) {
        console.error(`  ${t.label}: ${t.ms}ms`);
    }
    console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
    console.error("------------------------\n");
}
```
Replace:
```js
export function printTimings() {
    if (!ENABLED || (timings.length === 0 && aggregates.size === 0))
        return;
    if (timings.length > 0) {
        console.error("\n--- Startup Timings ---");
        for (const t of timings) {
            console.error(`  ${t.label}: ${t.ms}ms`);
        }
        console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
        console.error("------------------------\n");
    }
    if (aggregates.size > 0) {
        console.error("--- Detail timings (not in TOTAL) ---");
        const rows = [...aggregates.entries()].sort((a, b) => b[1].ms - a[1].ms);
        for (const [label, v] of rows) {
            const suffix = v.count > 1 ? ` x${v.count}` : "";
            console.error(`  ${label}: ${Math.round(v.ms)}ms${suffix}`);
        }
        console.error("--------------------------------------\n");
    }
}
```

### `core/extensions/loader.js`

**Edit C** — import + label helper. *Signature: the top import from
`../../config.js`. The `extensionLabel` helper is reused by Edits D & E.*

Find:
```js
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.js";
```
Replace:
```js
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.js";
import { addAggregate, time } from "../timings.js";
// [patch] Derive a short, readable label for per-extension startup timing.
function extensionLabel(extPath) {
    const s = String(extPath);
    const m = s.match(/(?:^|\/)(?:packages|extensions|node_modules)\/(@[^/]+\/[^/]+|[^/]+)/);
    if (m)
        return m[1];
    if (s.startsWith("<") && s.endsWith(">"))
        return s.slice(1, -1);
    const parts = s.split("/").filter(Boolean);
    const i = parts.lastIndexOf("src");
    if (i > 0)
        return parts[i - 1];
    return parts[parts.length - 1] ?? s;
}
```

**Edit D** — import/factory split. *Signature: the body of `loadExtension`, around
`await loadExtensionModule(...)` and `await factory(api)`.*

Find:
```js
async function loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken) {
    const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
    try {
        const factory = await loadExtensionModule(resolvedPath, cacheToken);
        if (!factory) {
            return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
        }
        const extension = createExtension(extensionPath, resolvedPath);
        const api = createExtensionAPI(extension, runtime, cwd, eventBus);
        await factory(api);
        return { extension, error: null };
    }
```
Replace:
```js
async function loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken) {
    const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
    const _label = extensionLabel(extensionPath);
    try {
        const _t0 = performance.now();
        const factory = await loadExtensionModule(resolvedPath, cacheToken);
        addAggregate(`[load] import ${_label}`, performance.now() - _t0);
        if (!factory) {
            return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
        }
        const extension = createExtension(extensionPath, resolvedPath);
        const api = createExtensionAPI(extension, runtime, cwd, eventBus);
        const _t1 = performance.now();
        await factory(api);
        addAggregate(`[load] factory ${_label}`, performance.now() - _t1);
        return { extension, error: null };
    }
```

**Edit E** — per-extension timeline line. *Signature: the `for…of` loop in
`loadExtensionsInternal` that calls `await loadExtension(...)`.*

Find:
```js
    const resolvedRuntime = runtime ?? createExtensionRuntime();
    for (const extPath of paths) {
        const { extension, error } = await loadExtension(extPath, resolvedCwd, resolvedEventBus, resolvedRuntime, cacheToken);
        if (error) {
```
Replace:
```js
    const resolvedRuntime = runtime ?? createExtensionRuntime();
    // [patch] Mark the boundary so the first extension's delta excludes pre-loop setup.
    if (paths.length > 0)
        time("ext:setup");
    for (const extPath of paths) {
        const { extension, error } = await loadExtension(extPath, resolvedCwd, resolvedEventBus, resolvedRuntime, cacheToken);
        // [patch] Per-extension load time on the main timeline (no-op unless PI_TIMING=1).
        time(`ext ${extensionLabel(extPath)}`);
        if (error) {
```

### `core/extensions/runner.js`

**Edit F** — import + label helper. *Signature: the import of `theme` from the
interactive theme module. `extLabel` is reused by Edits G & H.*

Find:
```js
import { theme } from "../../modes/interactive/theme/theme.js";
```
Replace:
```js
import { theme } from "../../modes/interactive/theme/theme.js";
import { addAggregate } from "../timings.js";
// [patch] Short label for per-extension handler timing.
function extLabel(extPath) {
    const s = String(extPath);
    const m = s.match(/(?:^|\/)(?:packages|extensions|node_modules)\/(@[^/]+\/[^/]+|[^/]+)/);
    if (m)
        return m[1];
    if (s.startsWith("<") && s.endsWith(">"))
        return s.slice(1, -1);
    const parts = s.split("/").filter(Boolean);
    const i = parts.lastIndexOf("src");
    if (i > 0)
        return parts[i - 1];
    return parts[parts.length - 1] ?? s;
}
```

**Edit G** — generic dispatch timing. *Signature: the handler loop inside the
generic `emit(event)` method (the one that does `await handler(event, ctx)` and
checks `isSessionBeforeEvent`). `await handler(event, ctx)` also appears in other
`emit*` methods — instrument only this one unless you want full coverage.*

Find:
```js
            for (const handler of handlers) {
                try {
                    const handlerResult = await handler(event, ctx);
                    if (this.isSessionBeforeEvent(event) && handlerResult) {
                        result = handlerResult;
                        if (result.cancel) {
                            return result;
                        }
                    }
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    this.emitError({
                        extensionPath: ext.path,
                        event: event.type,
                        error: message,
                        stack,
                    });
                }
            }
```
Replace:
```js
            for (const handler of handlers) {
                const _t0 = performance.now();
                try {
                    const handlerResult = await handler(event, ctx);
                    if (this.isSessionBeforeEvent(event) && handlerResult) {
                        result = handlerResult;
                        if (result.cancel) {
                            return result;
                        }
                    }
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    this.emitError({
                        extensionPath: ext.path,
                        event: event.type,
                        error: message,
                        stack,
                    });
                }
                finally {
                    addAggregate(`[handler] ${event.type} ${extLabel(ext.path)}`, performance.now() - _t0);
                }
            }
```

**Edit H** — resource-discovery timing. *Signature: the handler loop inside
`emitResourcesDiscover()` (builds `{ type: "resources_discover", … }` and pushes
skill/prompt/theme paths). Captures the skills scan.*

Find:
```js
            for (const handler of handlers) {
                try {
                    const event = { type: "resources_discover", cwd, reason };
                    const handlerResult = await handler(event, ctx);
                    const result = handlerResult;
                    if (result?.skillPaths?.length) {
                        skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
                    }
                    if (result?.promptPaths?.length) {
                        promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
                    }
                    if (result?.themePaths?.length) {
                        themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
                    }
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    this.emitError({
                        extensionPath: ext.path,
                        event: "resources_discover",
                        error: message,
                        stack,
                    });
                }
            }
```
Replace:
```js
            for (const handler of handlers) {
                const _t0 = performance.now();
                try {
                    const event = { type: "resources_discover", cwd, reason };
                    const handlerResult = await handler(event, ctx);
                    const result = handlerResult;
                    if (result?.skillPaths?.length) {
                        skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
                    }
                    if (result?.promptPaths?.length) {
                        promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
                    }
                    if (result?.themePaths?.length) {
                        themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
                    }
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    this.emitError({
                        extensionPath: ext.path,
                        event: "resources_discover",
                        error: message,
                        stack,
                    });
                }
                finally {
                    addAggregate(`[handler] resources_discover ${extLabel(ext.path)}`, performance.now() - _t0);
                }
            }
```

## Step 3 — Sanity-check the edits

```bash
for f in core/timings.js core/extensions/loader.js core/extensions/runner.js; do
  node --check "$PIDIST/$f" && echo "ok: $f"
done
```

## Step 4 — Verify it emits timings

A real benchmark run needs a TTY, so wrap `pi` in `script` (macOS pattern); the
timings go to stderr and are captured by the redirect:

```bash
PI_TIMING=1 PI_STARTUP_BENCHMARK=1 script -q /dev/null \
  pi --no-extensions --no-session \
  -e ./packages/pi-subagents/src/index.ts \
  -e ./packages/pi-claude-code-skills-import/src/index.ts \
  >/tmp/cap.log 2>&1 </dev/null

grep -aoE "(ext [a-zA-Z0-9@/_-]+|TOTAL|\[load\] (import|factory) [a-zA-Z0-9@/_-]+|\[handler\] [a-z_]+ [a-zA-Z0-9@/_-]+): [0-9]+ms( x[0-9]+)?" /tmp/cap.log
```

Expected shape:

```
ext pi-subagents: 423ms
ext pi-claude-code-skills-import: 137ms
TOTAL: 1623ms
[load] import pi-subagents: 402ms                                  ← cost is the import (typebox)
[handler] resources_discover pi-claude-code-skills-import: 174ms   ← cost is the scan handler
[load] factory pi-subagents: 20ms
```

- `--no-extensions` makes only the `-e` extensions load (clean baseline ≈ 200 ms
  with none). Drop it to profile your full configured set.
- Numbers vary with jiti-cache warmth and system load; the *relative* ranking and
  the load-vs-handler attribution are the signal.

## Notes

- **Re-do after every `pi` upgrade** (it overwrites `dist/` and leaves stale
  `.bak` files — refresh the backup on the next clean apply).
- If a `find` block doesn't match, the compiled code moved: re-locate the site by
  its structural signature, read the current function, and apply the *intent* of
  the edit. The inserted snippets (`addAggregate`, the `label`/`extLabel` helper,
  the `performance.now()` wrappers) are version-independent — only the
  surrounding anchor text changes.
- Validated against pi `0.79.10`. Only compiled JS is touched — no upstream
  TypeScript, and nothing in the pi-extensions packages. This is a local
  profiling aid.
- Pairs with the `audit-startup-time` skill: that reasons about what *should* be
  cheap; this measures what actually is.
