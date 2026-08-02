Upstream

**Repository:** [`buddingnewinsights/pi-diff`](https://github.com/buddingnewinsights/pi-diff)

**Upstream path:** `.` (entire repo)

**License:** MIT, © huynhgiabuu

**Initially ported:** `0c4768c` (local commit `7443d13`)

**Last synced:** `eeceac487a2023ba10258c5fc194e5bc762a3c43` (`release: harden apply patch and add tool config`, 2026-07-21)

**Differences from upstream**

The local package adapts the direct copy to the monorepo's stricter lint/typecheck
(eslint + `@tsconfig/strictest`) and registry conventions:

- `src/index.ts` — strict-config adaptations: `!` non-null assertions, `as Record<string, unknown>` /
  `as unknown` casts on returns (no-unsafe-return), `delete text.__piDiffTask` instead of
  `= undefined`, `process.env["X"]` bracket access, unused SDK vars (`getMarkdownTheme`,
  `MarkdownComponent`) dropped, `console.error`/`console.warn` calls removed (no-console).
- `src/index.ts` and `src/review/hunk-preview.ts` — dead upstream helpers/constants deleted
  outright instead of kept as "documentation artifacts" (no `@ts-expect-error`/`@ts-ignore`
  directives remain anywhere in the package). Representative examples: `_deriveBgFromFg`,
  `_applyDiffPalette`, `_stripes`, `_lang`, `_DIVIDER`, `_BG_EMPTY`, `_FG_STRIPE`, `FG_RULE`, plus
  their cascade orphans — duplicate types/constants/functions that existed only in index.ts
  (`DiffPreset`, `DIFF_PRESETS`, `loadDiffConfig`, `hexToBgAnsi`, `hexToFgAnsi`, `EXT_LANG`, and the
  `extname` import). The live versions of those live in `src/review/hunk-preview.ts` and are used
  there (e.g. `loadDiffConfig()` is called by the exported `applyDiffPalette()`).
- `src/review/hunk-preview.ts` — strictness fixes under the root `@tsconfig/strictest` config using
  real narrowing instead of suppressions: `process.env["X"]` bracket access for index-signature
  properties (`DIFF_THEME`, `HOME`, `shikiTheme`), `!` non-null assertions only where loop-guarded
  (`visible[index]!`, `diff.lines[idx]!`, `ranges[rangeIndex]!`), `const` extraction of
  `deletions[0]`/`additions[0]` into `deletion`/`addition` then `deletion && addition` guards,
  destructure defaults for `parseAnsiRgb` (`[, , r = 0, g = 0, b = 0]`), `delLine`/`addLine` consts
  in `renderSplit`, and 8 now-never-reassigned `let`s converted to `const`.
- `src/edit-guard.ts` — handler kept synchronous (require-await), return type
  `ToolCallEventResult | undefined`.
- Extra local tests: coverage additions in `src/core/{config,diff,replace,conflicts}.test.ts` and the
  E2E test `test/edit-tool-flow.e2e.test.ts`.
- Not ported (upstream-only project files): `src/collapsed-hint.ts` (unused by upstream's own
  `src/index.ts` since v0.7.x), `scripts/*.py`, `media/`, release-notes, `.hunk/config.toml`.
- `package.json` — monorepo conventions: name `pi-diff` (not `@heyhuynhgiabuu/pi-diff`), `private: true`,
  `@earendil-works/*` as peerDependencies at `^0.79.10` (the monorepo's pinned pi version; upstream
  requires `^0.80.0`, which is unsatisfiable here), `@shikijs/cli` pinned `^4.3.0`.

```bash
UP=$(mktemp -d)/pi-diff
git clone --quiet https://github.com/buddingnewinsights/pi-diff.git "$UP"
git -C "$UP" log --oneline eeceac487a2023ba10258c5fc194e5bc762a3c43..origin/HEAD
```
