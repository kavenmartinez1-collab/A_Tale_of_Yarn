# ArtifexWebGame — Plan & Handoff

> Read this first. This repo was seeded 2026-07-16 by copying the WebGPU inference
> stack out of `C:\Artifex-Assistant-V5\webgpu` (monorepo commit `ebb698d`).
> It is now an independent project. The assistant's memory from the parent
> project does NOT follow into this directory — everything a successor session
> needs is in this file plus `docs/ENGINEERING_LOG.md` (gitignored, read it).

## Vision

Open-world survival game — **Breath of the Wild meets Skyrim** (stylized
low-poly 3D, heightmap terrain, NOT voxel/Minecraft), with survival systems
(health/hunger/temperature/day-night, DayZ-flavored looting), running entirely
in the browser on **one 8 GB GPU (RTX 5060 Ti, Blackwell)** alongside a local
LLM that acts as an **AI Director**:

- Generates dungeons/quests/lore as **structured JSON** → deterministic
  procgen (noise terrain, WFC / graph-grammar dungeons) builds the geometry.
  The LLM decides *what and why*; code decides *where every triangle goes*.
- Drives NPC dialogue live (streamed tokens → speech bubbles → Piper TTS).
- Watches game state and injects world events every few minutes.
- Result: every run/seed is genuinely different — no copy-paste quests.

The LLM is **never in the frame loop**. Inference spikes only during dialogue
and generation beats; rendering owns the GPU the rest of the time.

## Single-model policy

**One LLM across the board** (director + NPCs + quests + lore). It lives in
`models/` (gitignored — this repo may go PUBLIC; never commit weights).

Current candidate, already in `models/`:
`models/flux2-te-qwen3-4b-q4_k_m/flux2-te-qwen3-4b-q4_k_m.gguf`
— a full **Qwen3-4B @ Q4_K_M (2.4 GB)** with tokenizer. It was pulled as the
FLUX.2 text encoder, but it is a complete causal LM the engine's GGUF loader
already handles. Validate it chats coherently first; if it's a poor
conversationalist (TE checkpoints sometimes are), swap in a standard
instruct-tuned Qwen3-4B Q4_K_M GGUF — same size, same kernels.

Voice models (not "the model", tiny, also in `models/`):
- `piper-en-us-joe-medium` (61 MB) — TTS, working (P5–P7 done)
- `whisper-base-en` (281 MB) — STT; port done but the **live mic loop is
  BROKEN** (see parent commits `ebb698d`, `bfa823b`, `caa6287`)

## VRAM budget (8 GB, everything resident)

| Item | Budget |
|---|---|
| Windows/DWM + browser overhead | ~0.8 GB |
| Game rendering (stylized low-poly, heightmap terrain, shadows) | ~2.0–2.5 GB |
| LLM weights (Qwen3-4B Q4_K_M) | ~2.4 GB |
| KV cache, TurboQuant K3/V2, 8–16k ctx | ~0.3 GB |
| Whisper + Piper | ~0.25 GB |
| Headroom / fragmentation | ~0.7 GB |

Stretch options if 4B underwhelms: 8–9B @ ~3 bpw (IQ2_XXS kernels exist and
are parity-verified), or MoE with CPU-offloaded experts (35B-A3B pattern).

## MVP scope (in order)

1. **Terrain engine**: chunked heightmap from noise, stylized shading,
   third-person character controller. Pure engine work, no LLM.
2. **Director loop v1**: prompt → JSON (theme, quest beats, dungeon layout
   graph, loot tables) → WFC/graph-grammar assembles a playable dungeon.
   Constrain output with a JSON schema / grammar-guided sampling.
3. **One talking NPC**: streamed dialogue + Piper voice out. (Whisper mic-in
   once the voice loop is fixed — do not block MVP on it.)
4. **Survival basics**: health/hunger, day-night cycle.

## Engineering gotchas inherited from the parent project (hard-won — respect these)

- **Sampler before kernel**: for any coherence/collapse bug, test greedy
  (temp=0) FIRST. Invisible minP/DRY defaults once caused weeks of false
  kernel-hunting. Sampler presets (Balanced/Deterministic/Creative/Reference)
  are the sampler contract.
- **WGSL needs a real GPU bench**: tsc + CPU parity cannot catch WGSL
  validation errors (override-array placement, runtime-M OOB). Run a GPU
  bench before claiming a kernel works. Headed Chrome (`HEADED=1`) adds VRAM
  pressure headless misses — bench headed before committing perf claims.
- **Never edit `src/` while a Playwright bench runs** — vite HMR reload drops
  the loaded model mid-run.
- **Never use `PROMPT` as an env var name** — cmd.exe injects `PROMPT=$P$G`
  into npx children on Windows.
- **Never pipe long-running background commands through head/tail**; never
  kill Node.js processes (takes down the CLI session too).
- **`ArrayBuffer.slice(s,e)` silently truncates** when `e >` source length —
  assert sliced sizes. (A 512 MB chunk-boundary truncation once corrupted a
  weight and cost days.)
- **Chrome `mapAsync` is slow (~3 ms)**; the writeBuffer-pump trick gets
  readbacks to ~0.19 ms — already in the engine, don't regress it.
- **localStorage overrides** (e.g. `vramBudgetGB`) must be set on the exact
  serving origin (e.g. `127.0.0.1:5173`), not `localhost`.
- **Supply chain**: minimize deps, pin exact versions, no auto-updates.
  `node_modules/` was copied verbatim from the parent (matches the
  lockfile) — prefer `npm ci` if it ever needs rebuilding.
- **Don't hardcode ports or start servers without asking.**
- **espeak WASM assets** have a vite path quirk — fixed in `bfa823b`;
  built artifacts are committed under `src/audio/espeak/`, the 1.8 GB build
  toolchain was intentionally NOT copied (recipe lives in
  `scripts/espeak-build/build.sh` in the parent repo).

## What was excluded from the copy (and where to get it back)

All regenerable/heavy artifacts; originals remain in `C:\Artifex-Assistant-V5\webgpu`:
- `scripts/espeak-build/` toolchain trees (1.8 GB) — recipe committed, artifacts committed
- `scripts/flux2_fixture/`, `piper_fixture/`, `whisper_fixture/` — regenerate
  via `scripts/gen_*_fixture.py` using the PARENT repo's Python venv
  (`C:\Artifex-Assistant-V5\venv\Scripts\python.exe`)
- `dist/`, `test-results/`, `debug-output*.json`, `metrics.jsonl`

## Repo policy

- Fresh git history, **no remote configured**. This is NOT the monorepo and
  NOT the `artifex_web` subtree remote — never push it to either.
- May go public: keep weights, local configs (`model-dirs.local.json`), and
  debug dumps out of git (the `.gitignore` already covers this).
- Keep `docs/ENGINEERING_LOG.md` (gitignored) up to date with explicit
  reasoning chains — sessions are swapped between models and the log is the
  successor's context.
