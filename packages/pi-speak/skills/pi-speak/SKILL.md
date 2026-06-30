---
name: pi-speak
description: "Use this skill when speaking text aloud, reading output to the user, or producing voice/audio output. Triggers on: speak aloud, say this out loud, read this to me, speak text, text to speech, TTS, /speak, voice output, audio output."
---

# pi-speak

Use this skill when you need to synthesise text and play it through the
system audio device: announcing a result aloud, narrating a summary, or
any request for voice output.

Do not use for streaming audio, playing media files, or recording — only
in-process TTS synthesis and playback via the Supertone engine is
supported.

## Activation required

`speak` is **registered at session_start but starts inactive every
session**. It appears in `manage_tools({action:"list"})` immediately; one
action is needed to make it callable. Two paths:

**Preferred — LLM activates via `manage_tools`** (no user action needed):

```
manage_tools({"action": "activate", "tools": ["speak"]})
```

The tool becomes callable on the next turn. `manage_tools` is provided
by the `pi-tools-management-tool` extension; if the call fails with
"unknown tool", that extension is not installed — ask the user to
install it before continuing.

**`/speak` slash command** toggles the `speak` tool on for the current
session. Running `/speak` a second time disables it again. If model
assets are missing when `/speak` is run, it prints the exact
`hf download` command to run manually — run that command,
then run `/speak` again to enable.

State is **scoped to the current session only** and never carries over to
a new session. Re-enable with `/speak` (or `manage_tools`) after starting
a new session.

## Slash command reference

| Command | What it does |
|---|---|
| `/speak` | Toggle the `speak` tool on/off for this session |
| `/speak status` | Show enabled state, assets path, and whether assets are ready |
| `/speak test` | Speak "Hello from pi-speak." as a smoke test (only when enabled) |

## What the tool does

`speak` synthesises text in-process using the Supertone ONNX TTS engine,
writes a temporary WAV file, and plays it through the OS audio device
(`afplay` on macOS; `paplay`/`aplay`/`ffplay` on Linux; PowerShell
`Media.SoundPlayer` on Windows). Speech always plays in the background
queue — the tool never blocks. The temporary file is deleted immediately
after playback.

**Use the `speak` tool for short outputs.** Prefer
short, high-value utterances (confirmations, summaries, key results)
over narrating large blocks of text.

## Tool parameters

```
speak({
  "text":  "Your text here",   // required, non-empty
  "voice": "M1",               // optional: M1–M5 (male) or F1–F5 (female), default M1
  "lang":  "en",               // optional: language code, default en
  "speed": 1.05,               // optional: 0.5–2.0 rate multiplier, default 1.05
  "steps": 8,                  // optional: 1–32 diffusion steps, default 8
  "trigger_turn": false        // optional: if true, triggers a new LLM turn after speech plays, default false
})
```

### Supported languages

`en`, `ko`, `ja`, `ar`, `bg`, `cs`, `da`, `de`, `el`, `es`, `et`, `fi`,
`fr`, `hi`, `hr`, `hu`, `id`, `it`, `lt`, `lv`, `nl`, `pl`, `pt`, `ro`,
`ru`, `sk`, `sl`, `sv`, `tr`, `uk`, `vi`, `na`.

### Diffusion steps

Higher `steps` values produce better audio quality but increase synthesis
latency. The default of `8` balances quality and speed for interactive
use. Increase to `16`–`32` for a polished, slow output; reduce to `1`–`4`
for the fastest possible response.

## Assets setup

Model assets (~500 MB) must be downloaded once before the tool can be
used. After download, the extension auto-discovers the model from the
HuggingFace cache. If assets are missing, `/speak` prints the install command:

```bash
hf download Supertone/supertonic-3
```

Requires the `hf` CLI:

```bash
pip install hf-transfer
```

The path is auto-discovered from the HF cache (`~/.cache/huggingface/hub/`
by default; respects `HF_HOME` and `HUGGINGFACE_HUB_CACHE` if set).
After downloading, run `/speak` again to enable.

**Override the assets path** with the `PI_SPEAK_ASSETS_DIR` environment
variable or via `~/.pi/agent/pi-speak.json`:

```json
{
  "assetsDir": "/path/to/custom/assets",
  "timeoutMs": 30000
}
```

`PI_SPEAK_ASSETS_DIR` takes precedence over both the config file and the
auto-discovered HF cache path.

## Error handling

| Error | Cause | What to do |
|---|---|---|
| `manage_tools` not found | `pi-tools-management-tool` not installed | Ask the user to install the extension, then restart pi |
| "assets not downloaded" from `speak` tool | Assets not present at the configured path | Run the `hf download` command shown by `/speak`, then re-enable |
| `/speak enable` prints download command instead of enabling | Assets missing | Run the printed command, then run `/speak enable` again |
| `speak` tool not callable after `manage_tools` activate | `activate` call must be the last action in a turn | Send the `manage_tools` call alone; invoke `speak` on the next turn |
| Playback silent or no audio | No compatible OS audio player found | Ensure `afplay` (macOS), `paplay`/`aplay`/`ffplay` (Linux), or PowerShell (Windows) is available |
| Tool disabled after session restart | State does not carry across sessions by design | Run `/speak enable` or `manage_tools({"action":"activate","tools":["speak"]})` again |

## Typical workflow

1. Activate the tool (once per session):
   ```
   manage_tools({"action": "activate", "tools": ["speak"]})
   ```
2. On the next turn, call the tool:
   ```
   speak({"text": "Task complete. Three files were updated.", "voice": "F1"})
   ```
3. The call returns immediately — speech plays in the background queue.
   Pass `trigger_turn: true` to fire a new LLM turn after the item finishes.

## Related Skills

- `convert-audio` — convert or process existing audio files rather than synthesising new speech
