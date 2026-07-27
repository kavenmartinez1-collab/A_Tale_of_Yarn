# Local models

**Single-model policy (this project):** one LLM drives everything — AI
Director, NPCs, quests, lore. Current candidate:
`flux2-te-qwen3-4b-q4_k_m/` (Qwen3-4B Q4_K_M, 2.4 GB). Voice sidecars:
`rhasspy--piper-en-us-joe-medium/` (TTS, men + the Evil King),
`rhasspy--piper-en-us-ljspeech-medium/` (TTS, women) and `whisper-base-en/`
(STT). Weights are gitignored — never commit them (repo may go public). See
`../GAME_PLAN.md`.

**Two TTS voices, not one.** Resampling a male voice upward does not produce a
female one — the formants move with the pitch and it reads as a fast small man.
Gender selects the model; see `BANDS` in `src/game/voice/voice-out.ts`. Both
voices' licences are recorded in `scripts/audio-credits.json` under
`voiceModels`, and `scripts/test-audio-credits.mts` fails if a vendored voice is
missing from that list. The G2P lexicon is shared and lives in joe's directory
only — it is a property of English, not of the speaker.

Drop GGUF files or model folders here and they appear in the in-app model
browser as `local/<name>`:

- **Loose GGUF**: `models/MyModel-Q4_K_M.gguf` → `local/MyModel-Q4_K_M`
- **Model folder**: `models/my-model/` containing a `.gguf` or a
  `config.json` + `*.safetensors`

To point at models that live elsewhere on disk, create
`model-dirs.local.json` next to `package.json` (gitignored) — see
`model-dirs.local.example.json`. The dev server also auto-discovers your
Ollama store and HuggingFace cache; nothing here is required.
