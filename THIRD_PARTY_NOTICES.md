# Third-Party Notices

ArtifexWebGame itself is MIT licensed — see [`LICENSE`](./LICENSE),
Copyright (c) 2025 Kaven Martinez. This file covers everything else that is
**distributed with it**: model weights, JavaScript dependencies, and vendored
native code.

It exists because Apache License 2.0 §4 requires, when you distribute the
work, that you give recipients a copy of the licence and retain the
attribution notices. Several of the models below are Apache-2.0, so this is an
obligation and not a courtesy. Full licence texts are in [`LICENSES/`](./LICENSES).

> **Scope note.** This repository builds **two** front ends and they do not
> ship the same third-party code:
>
> | Entry point | What it is | Third-party surface |
> |---|---|---|
> | `game.html` → `src/game/main.ts` | **the game** | Qwen3 weights, `@huggingface/transformers` (tokeniser only) |
> | `index.html` → `src/main.ts` | companion chat / image / TTS app | all of the above **plus** ONNX Runtime Web, a vendored **GPL-3.0** eSpeak NG, Piper and Whisper weights, the FLUX.2 text encoder |
>
> Section 4 explains why that distinction decides whether this build is
> shippable on Steam. **Read it before cutting a release.**

---

## 1. Model weights

None of these are in the git repository (`models/*` is gitignored); they are
downloaded at runtime or bundled into the release depot. Sizes and hashes are
of the exact artefacts verified on 2026-07-25 — pin them in CI so a silent
upstream re-upload cannot change what you ship.

### 1.1 Shipped with the game

**Qwen3-1.7B** — NPC dialogue *and* the Dungeon Director (one model serves
both).

```
Qwen3-1.7B — Copyright 2024 Alibaba Cloud
Licensed under the Apache License, Version 2.0
https://www.apache.org/licenses/LICENSE-2.0
```

| | |
|---|---|
| Artefact | `Qwen3-1.7B-Q4_K_M.gguf` |
| Distribution repo | [`unsloth/Qwen3-1.7B-GGUF`](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF) (quantised by Unsloth) |
| Base model | [`Qwen/Qwen3-1.7B`](https://huggingface.co/Qwen/Qwen3-1.7B) |
| Licence | Apache-2.0, declared on both repos; [`license_link`](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE) |
| Gated | No |
| Size | 1,107,409,472 bytes |
| SHA-256 | `b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897` |

The upstream `Qwen/Qwen3-1.7B` LICENSE is unmodified Apache-2.0 with
`Copyright 2024 Alibaba Cloud` in the appendix. **Qwen ships no `NOTICE` file**
(verified: HTTP 404), so there are no NOTICE contents to reproduce under
Apache-2.0 §4(d).

### 1.2 Optional, not shipped by default

**Qwen3-4B-Instruct-2507** — reachable only via `?npcllm=large`. Ship it only
if you decide to promote it to the default; otherwise it is not distributed.

| | |
|---|---|
| Artefact | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` |
| Distribution repo | [`unsloth/Qwen3-4B-Instruct-2507-GGUF`](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) |
| Base model | [`Qwen/Qwen3-4B-Instruct-2507`](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) |
| Licence | Apache-2.0, `Copyright 2024 Alibaba Cloud` |
| Size / SHA-256 | 2,497,281,120 bytes / `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |

**`bartowski/mlabonne_Qwen3-4B-abliterated-GGUF`** — reachable via
`?npcllm=abliterated`, for comparison only. **Do not ship it.** The GGUF repo
declares *no licence field at all*; its base `mlabonne/Qwen3-4B-abliterated`
declares Apache-2.0, so an argument exists, but the artefact you would actually
distribute carries no grant of its own. Separately, removing a model's refusal
behaviour is the opposite of what Steam's Content Survey asks about — see
[`docs/AI_GUARDRAILS.md`](./docs/AI_GUARDRAILS.md).

### 1.3 Companion app only (`index.html`)

These are **not** part of the game build. If you ship only `game.html`, none of
this section applies.

| Component | Licence | Notes |
|---|---|---|
| **Whisper base.en** (STT) — [`openai/whisper-base.en`](https://huggingface.co/openai/whisper-base.en) | Apache-2.0, Copyright OpenAI | ungated |
| **Piper voice `en_US-joe-medium`** (TTS) — [`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) | Repo declares MIT | **Confirm the individual voice.** Piper voices inherit the licence of the speech *dataset* they were trained on, which varies per voice and is not always MIT. The repo-level tag is not sufficient evidence for the voice you ship. |
| **FLUX.2 text encoder** — `models/flux2-te-qwen3-4b-q4_k_m/` | **Undetermined** | See §5. Used by `src/diffusion/` as an image text encoder, which is what it actually is. No longer used as an LLM. |

---

## 2. JavaScript dependencies in the shipped bundle

Verified against a production `npm run build` (`dist/assets/`), not against
`node_modules` — most of the dependency tree is build-time only and is never
distributed.

| Package | Version | Licence | In the game bundle? |
|---|---|---|---|
| [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) | 3.8.1 | Apache-2.0, Copyright Hugging Face | **Yes** — used *only* as a BPE tokeniser. Inference is this repo's own WebGPU engine. |
| [`@huggingface/jinja`](https://github.com/huggingface/jinja) | 0.5.6 | MIT | Yes (transitive; chat-template rendering) |
| [`onnxruntime-web`](https://github.com/microsoft/onnxruntime) | 1.22.0-dev | MIT, Copyright Microsoft | **No** — companion app only (`ort-wasm-simd-threaded.jsep.wasm`) |

`vite`, `typescript`, `tsx`, `@playwright/test`, `express`, `cors`, `ws` and
their trees are **build- and development-time only** and are not distributed.

### A note on `sharp` / `@img/sharp-*`

`@huggingface/transformers` declares a **production** dependency on `sharp`,
whose platform binaries (`@img/sharp-win32-x64` and siblings) are
**`Apache-2.0 AND LGPL-3.0-or-later`**. It does **not** reach the browser
bundle — transformers.js only requires it on its Node code path, and it is
absent from `dist/`. It is called out here because it *would* become a
distributed component the moment this ships inside an Electron or Node wrapper
that bundles `node_modules`, and LGPL is exactly the kind of term Valve's
open-source-compatibility rule is about.

---

## 3. Vendored native code

| Component | Location | Licence |
|---|---|---|
| **eSpeak NG** (WASM build, pinned commit `212928b`) | `src/audio/espeak/` — `espeak.js`, `espeak.wasm`, `espeak.data` | **GPL-3.0-or-later** |

See §4. This is the one entry in this file that is not a formality.

---

## 4. Licence-compatibility warning — eSpeak NG is GPL-3.0

**This needs a decision before any commercial release.**

`src/audio/espeak/` contains a compiled WebAssembly build of
[eSpeak NG](https://github.com/espeak-ng/espeak-ng), used by the Piper TTS
grapheme-to-phoneme stage (`src/audio/g2p.ts`). eSpeak NG is licensed
**GPL-3.0-or-later** (verified against upstream `COPYING`). It is currently
vendored with **no licence file, no copyright notice and no written offer of
source** — which is itself out of compliance with GPL-3.0 §4–6, independently
of Steam.

Valve's documentation states:

> "If your application contains third party open source code that is
> incompatible with the Steamworks SDK, then YOU MUST NOT DISTRIBUTE YOUR
> APPLICATION VIA STEAM."

…and names GPL as the problem case, while listing MIT, BSD and Apache-2.0 as
acceptable. ([Distributing open source](https://partner.steamgames.com/doc/sdk/uploading/distributing_opensource))

**The good news, and it is load-bearing:** the *game* does not use it. A
production build was checked directly — `dist/game.html` loads only
`game-*.js`, `gpu-device-*.js` and `preload-helper-*.js`, and the game chunk
contains **zero** references to espeak (`grep -c espeak` → 0). The dependency
comes in solely through `src/main.ts`, the companion chat/TTS app on
`index.html`.

So the options are, in order of preference:

1. **Ship `game.html` only** and exclude `index.html`, `src/main.ts`,
   `src/audio/` and `src/diffusion/` from the depot. Verify with a grep over
   the shipped `dist/` rather than by assumption — this is a build-configuration
   guarantee, and build configurations drift.
2. **Replace the G2P stage** with a permissively-licensed phonemiser if TTS is
   wanted in the game later.
3. **Keep it and comply with GPL-3.0** — which means offering the complete
   corresponding source and accepting the copyleft reach into whatever the
   FSF would consider the same program. Given Valve's rule, this is the
   option to avoid.

Whichever is chosen, add the eSpeak NG licence text and copyright notice to
`src/audio/espeak/` if that directory is retained at all.

---

## 5. Unresolved provenance — `flux2-te-qwen3-4b-q4_k_m.gguf`

`models/flux2-te-qwen3-4b-q4_k_m/flux2-te-qwen3-4b-q4_k_m.gguf` (2.50 GB)
carries **29 GGUF metadata keys and not one of them is a licence or a base
model**; `general.name` is `"Te Gguf Staging"`. It was traced by matching
hyperparameters to the text encoder of
[`black-forest-labs/FLUX.2-klein-4B`](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B),
which is Apache-2.0 and ungated — but sibling repos in that family
(`FLUX.2-klein-9B`, `FLUX.2-dev`) are gated and carry a **non-commercial**
licence, and nothing in the artefact records which one it came from.

**As of 2026-07-25 it is no longer used as an LLM.** The Dungeon Director and
the `?npcllm=default` key both pointed at it and now point at the Apache-2.0
Qwen3-1.7B above, so no chat or dungeon-generation path can reach it.

It remains on disk for `src/diffusion/` (companion app), where it is used as an
image text encoder — its actual purpose. **If the diffusion feature is ever
shipped, re-derive this file from a known-good source first.** Full analysis:
[`docs/AI_MODEL_LICENSING.md`](./docs/AI_MODEL_LICENSING.md) §4.2.

---

## 6. Verifying this file

```sh
# model artefact hashes
sha256sum Qwen3-1.7B-Q4_K_M.gguf

# what actually reaches the browser
npm run build
grep -o 'assets/[A-Za-z0-9_.-]*\.js' dist/game.html
grep -c espeak dist/assets/game-*.js        # must be 0

# dependency licences
npm ls --omit=dev --all
```

Last verified: **2026-07-25**. Re-check on the day you cut a release build —
Hugging Face repos can be re-uploaded, re-licensed or renamed under the same
name, and the hashes above are the only thing that will tell you.
