# pi-speak

Registers a `speak` tool that synthesises text via the [Supertone TTS](https://github.com/supertone-inc/supertonic) engine (ONNX runtime, in-process) and plays audio through the OS audio device.

**Inactive by default every session.** Enable with `/speak enable`.

---

## What it does

| Command | What it does |
|---|---|
| `/speak enable` | Enable the speak tool for this session |
| `/speak disable` | Disable the speak tool |
| `/speak status` | Show enabled state and assets path |
| `/speak test` | Speak a test phrase (only when enabled) |

---

## Requirements

- **Node.js ≥ 18**
- **OS audio player** (one of the following):
  - macOS: `afplay` (built-in)
  - Linux: `paplay` (PulseAudio), `aplay` (ALSA), or `ffplay` (FFmpeg)
  - Windows: PowerShell `Media.SoundPlayer` (built-in)

---

## Setup

Before using pi-speak for the first time, download the Supertone model assets (~500 MB) manually:

```bash
huggingface-cli download Supertone/supertonic-3
```

Requires `huggingface-cli`:
```bash
pip install huggingface_hub
```

Once the download completes, the extension auto-discovers the model from the HuggingFace cache (`~/.cache/huggingface/hub/` by default, or `HF_HOME`/`HUGGINGFACE_HUB_CACHE` if set). Run `/speak enable` in pi to enable the tool. If assets are missing when you run `/speak enable`, pi-speak prints the exact command to run.

`PI_SPEAK_ASSETS_DIR` or `assetsDir` in the config file can override the auto-discovered path if needed.

---

## `speak` tool parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | — | Text to speak aloud (required, non-empty) |
| `voice` | `M1`–`M5`, `F1`–`F5` | `M1` | Voice ID. M1–M5 male, F1–F5 female |
| `lang` | language code | `en` | Language (en, ko, ja, de, fr, …) |
| `speed` | number 0.5–2.0 | `1.05` | Speaking rate multiplier |
| `steps` | integer 1–32 | `8` | Diffusion steps (higher = better quality, slower) |
| `wait` | boolean | `true` | Block until playback finishes |

Supported languages: `en`, `ko`, `ja`, `ar`, `bg`, `cs`, `da`, `de`, `el`, `es`, `et`, `fi`, `fr`, `hi`, `hr`, `hu`, `id`, `it`, `lt`, `lv`, `nl`, `pl`, `pt`, `ro`, `ru`, `sk`, `sl`, `sv`, `tr`, `uk`, `vi`, `na`.

---

## Configuration

### Config file: `~/.pi/agent/pi-speak.json`

```json
{
  "assetsDir": "/path/to/custom/assets",
  "timeoutMs": 30000
}
```

| Field | Description |
|-------|-------------|
| `assetsDir` | Override the assets directory (overrides the auto-discovered HF cache path) |
| `timeoutMs` | Synthesis timeout in milliseconds |

### Environment variable

`PI_SPEAK_ASSETS_DIR` — override the assets directory. Takes precedence over both config file and default.

---

## Assets

Model assets are downloaded from [Supertone/supertonic-3](https://huggingface.co/Supertone/supertonic-3) on HuggingFace.

- **Location:** auto-discovered from the HuggingFace cache (`~/.cache/huggingface/hub/` by default; respects `HF_HOME` and `HUGGINGFACE_HUB_CACHE`)
- **Size:** ~500 MB
- **Sentinel file:** `onnx/duration_predictor.onnx` (presence indicates download is complete)

To re-download: delete the model snapshot directory and run `huggingface-cli download Supertone/supertonic-3` again.

---

## Session state

State is stored under the `pi-speak:state` custom type in the session log. The `speak` tool is always **disabled on session start** — it never carries over across sessions. Within a session, branch navigation restores the correct on/off state.

---

## Vendored code

`src/vendor/supertonic-helper.js` and `src/vendor/supertonic-helper.d.ts` are verbatim copies from [`supertone-inc/supertonic`](https://github.com/supertone-inc/supertonic) (MIT license). See [UPSTREAM.md](./UPSTREAM.md) for tracking.
