# jiti & extension startup cost

How `pi` loads extensions, why it costs what it costs, and which levers actually
move startup time. Findings are from auditing the bundled `jiti` **2.7.0** that
`@earendil-works/pi-coding-agent` ships, on Node **24.12.0** (pi's `engines.node`
floor is `>=22.19.0`). All ms figures are macOS / APFS, single host — treat
ratios as portable, absolute numbers as machine-specific.

## TL;DR

- Per-extension **module import/evaluation is ~94% of extension startup cost**.
  Factory registration and event handlers are nearly free (the one exception is
  scanners that walk disk in a `resources_discover` handler, e.g.
  `pi-claude-code-skills-import`).
- `pi` loads each extension's TypeScript at runtime through jiti. jiti is needed
  (not just convenient) because extensions use `.js` import specifiers that
  resolve to `.ts` files on disk, plus workspace `pkg/subpath` specifiers whose
  exports point at raw `./src/**/*.ts`. Node's native loaders never rewrite the
  extension, so they can't load this source as-is.
- On a **warm** jiti cache the Babel transform is already free (cache hit). What
  remains is `readFileSync` + V8 parse + V8 execute per module + jiti per-module
  bookkeeping. That evaluation cost is **irreducible** without changing how
  extensions are shipped.
- **Switching to Node's native TS type-stripping does not help** (warm parity,
  cold regression). **Naive precompile/bundle to native `.js` actively hurts**
  (+2–3× measured) because it severs jiti's alias to the host's pre-loaded
  `@earendil-works/*` modules — it only helps if paired with host-module
  injection, a pi-core capability.
- pi loads every extension with a **fresh jiti and `moduleCache: false`**, so
  shared workspace deps (e.g. `pi-watcher-core`) are **re-evaluated once per
  extension** — ~250–400 ms of duplicated work across the 5 watchers. Native npm
  deps (incl. `typebox`, which the loader pre-imports) are still deduped by
  Node's cache. Removing the duplication is a pi-core lever.

## How jiti 2.7.0 loads a module

Per `jiti.import(id)`: **resolve → read → decide transform → Babel transpile →
disk-cache → wrap & evaluate**.

1. **Resolve.** `jitiResolve` checks an always-native list
   (`node_modules/(typescript|jiti|…)/`), applies `alias`, then `tsconfigPaths`,
   then `mlly.resolvePathSync`. On a miss it walks `additionalExts`
   (`.ts/.mts/.cts/.tsx/.json`) and — when the parent is a `.ts` file or the
   specifier ends in `.js` — applies the **`.js`→`.ts` remap** (regex
   `/\.(c|m)?j(sx?)$/` → `.$1t$2`). *This remap is the structural reason the
   harness needs jiti at all.*
2. **Read.** `readFileSync(filename, "utf8")`.
3. **Decide transform.** A boolean roughly
   `!cjs && !(esm && async) && (isTS || esm || hasESMSyntax(src))` picks
   transform-vs-native. `packages/*/src/**/*.ts` (loaded via `jiti.import`, i.e.
   async) go through Babel; **`.js` ESM files in `node_modules` skip Babel** and
   load natively — so the agent's own `@earendil-works/*` deps are *not*
   transformed.
4. **Transform.** The transformer is **Babel, not oxc/swc** — `@babel/core 7.29`
   + `preset-typescript`, lazy-loaded from `dist/babel.cjs` on first use.
5. **Cache.** Transform output is cached on disk, keyed by a **content hash**
   (md5 trailer `/* v9-<hash> */`), *not* mtime. Cache dir is
   `node_modules/.cache/jiti` if present, else `$TMPDIR/jiti`. Bumping a
   transform option (e.g. `sourceMaps`) changes the cache filename.
6. **Wrap & evaluate.** Source is wrapped in a
   `(function(exports, require, module, …){ … })` and run via
   `vm.runInThisContext(...)`; a `Module` is registered in Node's
   `require.cache`. Modules with top-level `await` / unwrappable ESM fall back to
   importing a `data:` URL or a temp file under `$TMPDIR/jiti-esm/`.

**Never cached on disk:** the read of the cached file, the V8 parse/compile, the
V8 execution, and the resolver/Module bookkeeping. So a 100%-warm cache still
pays read + parse + execute + jiti overhead **× N modules**.

## Warm-cost decomposition (measured)

Benchmark: `packages/pi-custom-compaction/src/index.ts` (14 first-party `.ts`
files, ~1981 LOC, **zero external deps**) imported via `createJiti(...).import()`
in a process that already loaded jiti, Babel, and the `@earendil-works/*` deps.
Median of 3, warmup first.

| Configuration | Cold cache | Warm cache |
|---|---|---|
| Default (`fsCache=on`, `sourceMaps=off`) | **227 ms** | **101 ms** |
| `fsCache=false` | 222 ms | 217 ms |
| `sourceMaps=true` | 257 ms | 122 ms |
| `tryNative=true` (Node native TS strip) | 288 ms | 107 ms |

- Of the ~101 ms warm: Babel transform is free (cache hit); **~30 ms is jiti
  per-module overhead** (resolve + cache stat + Module construct, ×14); **~70 ms
  is genuine V8 parse+execute** of the 14 module bodies — the irreducible floor
  *for loading this extension once*.

## pi re-pays shared workspace deps once per extension

This is the biggest systemic surprise, and it overrides the naive "jiti shares a
process-wide cache so loading is free the second time." That is true only for
jiti's **default** `moduleCache: true`. pi loads every extension through
`loadExtensionModule` (`dist/core/extensions/loader.js:300`), which creates a
**fresh jiti per extension** with **`moduleCache: false`** (`:307`-`:312`):

- **Native npm deps are still deduped** by Node's own ESM/CJS cache across jiti
  instances. `typebox` in particular is pre-imported by the loader itself
  (`loader.js:17 import * as _bundledTypebox from "typebox"`), so every
  extension's `import { Type } from "typebox"` resolves from cache in **~1 ms**.
- **jiti-transpiled workspace TS is NOT deduped.** Each extension's fresh jiti
  (with `moduleCache: false`) re-reads, re-links and **re-evaluates** workspace
  source like `pi-watcher-core/src/**`. Measured: loading two AWS watchers in
  sequence pays the full `pi-watcher-core` graph cost *each time*
  (`{ec2_first: 178ms, s3_after: 192ms, ec2_second: 195ms}` — identical for the
  repeat). The transpile is fs-cached, but the V8 evaluation is paid per
  extension.
- In the **Node install** the loader passes `alias` (resolve to node_modules),
  **not** `virtualModules` — those (incl. the `@sinclair/typebox`→bundled map at
  `loader.js:48`) only apply to the compiled **Bun** binary. So in Node,
  `@sinclair/typebox` (used only by `pi-subagents`) is *not* pre-warmed and is a
  real eval cost there, whereas plain `typebox` is.

**Consequence:** with 5 watchers active, `pi-watcher-core` (~3 500 LOC) is
transpile-cached once but **evaluated ~5×**, wasting an estimated **~250–400 ms**.
The earlier observed "shared-dependency discount" (combined < sum of isolated)
comes from the *native* deps (typebox, the pi API) being cached — not from
workspace TS. Fixing the duplication is a **pi-core** lever (share one jiti
across extensions, or virtual-module-ify common workspace deps the way typebox
already is), not something an extension can do from its own source.

## Two cost classes across extensions

1. **Heavy third-party dep evaluated at import.** e.g. `pi-subagents`
   (`@sinclair/typebox` — *not* pre-warmed in the Node install, so a genuine
   cost) and `pi-speak` (`onnxruntime-node`). Note: plain `typebox` is **not** in
   this class — it is pre-imported by the loader (~1 ms), so `pi-ask-user-question`
   and the watchers pay nothing for it. And the AWS watchers' `@aws-sdk/*` is
   already lazy (`await import` inside methods; only `import type` at top level).
2. **Pure jiti/V8 cost of TS that must be evaluated** — the extension's own
   source *plus* any workspace deps re-evaluated per extension (see above).
   Proven by `pi-custom-compaction` (no deps, still ~101 ms warm). For the
   watcher family the dominant share is `pi-watcher-core` re-evaluated per
   watcher, not the watcher's own ~1 000–1 300 LOC.

## Levers, prioritised

> **Measured caveat (read the experiment below first):** naive precompilation /
> bundling that ends in **native `.js` loading regresses startup ~2–3×** here,
> because it severs jiti's alias to the host's already-loaded `@earendil-works/*`
> modules. Rows 1/2/2b only hold if those host modules are kept aliased/external
> (a pi-core mechanism). They are **not** safe repo-side wins as-is.

| # | Lever | Effect | Cold Δ | Warm Δ | Owner |
|---|---|---|---|---|---|
| 1 | **Precompile TS→JS** at publish; entry at `dist/index.js` | Skips jiti transform, but native load re-imports host `@earendil-works/*` unless they're injected | — | ⚠ **+1000 ms measured** if done naively | this repo + pi-core |
| 2 | **Bundle each extension to one file** (`@earendil-works/*` external) | Collapses N modules → 1; same host-module hazard as #1 | — | ⚠ untested; same risk | this repo + pi-core |
| 2b | **Precompile `pi-watcher-core` to `.js`** + repoint `exports` at `dist/` | **TESTED — REGRESSES** (see experiment) | — | ⚠ **+770 to +1090 ms measured** | ✗ not viable alone |
| 3 | Keep fs cache warm / on `node_modules/.cache/jiti` | Already in effect for warm runs | — | — | pi-core |
| 3b | **Share one jiti across extensions** (or `moduleCache: true`) / virtual-module-ify common workspace deps | Stops re-evaluating `pi-watcher-core` etc. per extension | — | est. **−250–400 ms** across 5 watchers | pi-core only |
| 4 | `virtualModules` / `nativeModules` for `@earendil-works/*` | Short-circuits resolve for the agent's own deps | small | ≤10 ms (est.) | pi-core |
| 5 | Keep `sourceMaps` off in production (default) | Skips inline source maps | −30 ms | −20 ms | pi-core (default) |
| ✗ | **Do NOT switch to `--import jiti/register`** | Transforms per request *without* the fs cache → large regression | huge | huge | pi-core |
| ✗ | **`tryNative` / Node native type-strip** | Erasable-only TS would parse, but warm parity + cold regression | +60 ms | ~0 | not recommended |

## Measured: naive precompilation regresses startup ~2–3×

Experiment (this machine, warm cache, patched pi 0.79.10, median of 3 after 2
warmups). `pi-watcher-core` was transpiled per-file to `dist/*.js` (`tsc`,
26 files, structure preserved) and its `exports` repointed at `./dist/*.js`;
everything reverted afterward.

| Config | ec2 alone (TOTAL / Σ import) | ec2+s3+glue (TOTAL / Σ import) |
|---|---|---|
| **Baseline** (`pi-watcher-core` = `.ts` via jiti) | ~457 ms / ~170 ms | ~755 ms / ~505 ms |
| **Precompiled** (`pi-watcher-core` = `.js`, native) | ~1544 ms / ~1337 ms | ~1523 ms / ~1337 ms |
| Δ | **+~1090 ms (3.4×)** | **+~770 ms (2×)** |

The regression is **flat** (ec2 alone ≈ 3 watchers), i.e. a fixed per-process
cost, not per-watcher. Cause: `pi-watcher-core/renderer.ts` imports
`@earendil-works/pi-tui` and another module imports
`@earendil-works/pi-coding-agent` at top level. Loaded as `.ts`, jiti keeps the
whole subtree under its **alias** resolution → those resolve to the host's
already-loaded instances. Loaded as `.js`, jiti hands off to Node's native
`import()`, whose sub-imports bypass jiti → Node loads a **fresh full copy of
`pi-coding-agent` + `pi-tui`** (~1 s, once). **Lesson:** jiti's value is not only
transpilation — its alias/virtualModules wiring is what shares the host's
pre-loaded `@earendil-works/*` with extensions. Any precompile/bundle that ends
in native loading must replicate that wiring (externals → host instances), which
is a pi-core capability (`virtualModules`), not a pure repo build step.

## Verdicts

- **Precompiling / bundling (repo-side):** does **not** work as a drop-in win —
  measured +2–3× regression — unless paired with host-module injection. Shelved
  pending pi-core support for mapping `@earendil-works/*` externals to the
  running host instances.
- **Native type-stripping (Node 24):** the extensions are erasable-only, and
  jiti's `tryNative` bridges the `.js`→`.ts` remap, so it *would* parse. But it
  **doesn't help**: Babel→CJS amortises to one on-disk cache + one
  `runInThisContext`, while native ESM re-strips every cold start with only an
  in-process compile cache. Babel-cached-once beats native-repeated.
- **Biggest avoidable waste (multi-extension):** because pi uses a fresh jiti per
  extension with `moduleCache: false`, shared workspace deps are evaluated once
  per consumer. For the 5 watchers that is ~250–400 ms of duplicated
  `pi-watcher-core` evaluation. The clean fix is pi-core (share jiti /
  virtual-modules); there is **no safe repo-side fix** — precompiling
  `pi-watcher-core` regresses (see experiment), because its top-level
  `@earendil-works/*` imports then load fresh under native ESM.
- **No clean ~100 ms win exists inside a watcher's own source.** typebox is
  pre-warmed, the AWS SDK is already lazy, and `pi-watcher-core` has no avoidable
  eager side-effects (top-level work is just constants + a few small `Set`s +
  typebox-derived schema objects). Minor repo wins: import directly from
  `pi-watcher-core/aws/sdk-client-factory` instead of the `pi-watcher-core/aws`
  re-export hub (skips `aws/tool-fields.ts`, ~3–5 ms/AWS watcher); splitting the
  1 361-LOC `base-watcher.ts` so consumers pull only what they need
  (~10–20 ms/watcher, moderate risk).

## Caveats

- Precompile/bundle savings (#1, #2) are **estimates**, not yet measured end to
  end — emit JS and benchmark before adopting at the harness level.
- Figures are single-host macOS / Node 24.12.0; the `tryNative` cold regression
  could shrink if a future Node adds an on-disk type-strip cache.

## How to reproduce these measurements

`pi`'s startup profiler is coarse by default. The `patch-pi-extension-timings`
skill (`.pi/skills/patch-pi-extension-timings/`) patches the installed pi to emit
per-extension `[load] import` / `[load] factory` / `[handler]` timings under
`PI_TIMING=1`. A real run needs a TTY:

```bash
PI_TIMING=1 PI_STARTUP_BENCHMARK=1 script -q /dev/null \
  pi --no-extensions --no-session -e ./packages/<pkg>/src/index.ts \
  >/tmp/cap.log 2>&1 </dev/null
grep -aoE "(ext [a-zA-Z0-9@/_-]+|TOTAL|\[load\] (import|factory) [a-zA-Z0-9@/_-]+): [0-9]+ms" /tmp/cap.log
```

`--no-extensions` makes only the `-e` extensions load (zero-extension baseline
≈ 195 ms). Delete `$TMPDIR/jiti` to force a cold cache.
