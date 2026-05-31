# Upstream

This package vendors code from an upstream open-source project. Use the
information below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`supertone-inc/supertonic`](https://github.com/supertone-inc/supertonic)
- **Upstream paths:** `nodejs/helper.js`, `nodejs/helper.d.ts`
- **License:** MIT, © 2025 Supertone Inc.

## Copied versions

- **Commit:** `dff55dc00064c398736080c78195f577527832ae` (HEAD, 2026-05-31)
- **Covers:** `src/vendor/supertonic-helper.js`, `src/vendor/supertonic-helper.d.ts`

## Divergences

- Renamed: `.js` file renamed from `helper.js` to `supertonic-helper.js` and
  `.d.ts` from `helper.d.ts` to `supertonic-helper.d.ts` to avoid confusion
  with other vendor helpers.
- Removed all `console.log` calls (lines 415, 429, 503, 506 in the original)
  to prevent output from bleeding into the pi TUI during in-process synthesis.
- `loadTextToSpeech`: added `logSeverityLevel: 3` to ONNX session options to
  suppress onnxruntime-node C++ info/warning messages from reaching stderr.

## Model License

The Supertone/supertonic-3 ONNX model assets (downloaded separately by users via
`huggingface-cli download Supertone/supertonic-3`) are licensed under the
**BigScience Open RAIL-M License** (see `LICENSE-MODELS`). This license permits
broad use but includes use-based restrictions — see Attachment A in `LICENSE-MODELS`
for the full list. The extension code itself remains MIT.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/supertone-inc-supertonic
git clone --quiet https://github.com/supertone-inc/supertonic.git "$UP"
git -C "$UP" log --follow dff55dc00064c398736080c78195f577527832ae..origin/HEAD -- nodejs/helper.js nodejs/helper.d.ts
```
