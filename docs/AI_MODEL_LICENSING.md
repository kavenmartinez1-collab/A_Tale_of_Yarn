# AI Model Licensing & Selection for Commercial Release

**Status:** research + recommendation, **now largely implemented** — see the
box below. The body of this document is preserved as written, so anything that
reads as "you should" was the recommendation *before* the change.
**Date:** 2026-07-25.

> ### What was actually implemented, 2026-07-25
>
> | § | Recommendation | Status |
> |---|---|---|
> | 1 | Ship stock `Qwen3-1.7B` Q4_K_M, Apache-2.0, for NPC dialogue | **Done** — `NPC_MODELS.fast` |
> | 4.2 / 8.1 | Stop using the unlabelled `flux2-te-qwen3-4b-q4_k_m` as an LLM | **Done** — the Director and the `?npcllm=default` key both point at the Qwen3-1.7B. The file stays on disk for `src/diffusion/`, its actual purpose. **Not deleted** — §8's "delete it" would break the image text encoder. |
> | 1.4 / 8.2 | One model for both Director and NPCs | **Done** — they share one GGUF session (dedup on `repo::file`), so ~1.1 GB resident instead of ~3.6 GB |
> | 8.2 | Record the sha256 so the build is reproducible | **Done** — `THIRD_PARTY_NOTICES.md` |
> | 8.5 | Write the third-party notices file | **Done** — `THIRD_PARTY_NOTICES.md` + `LICENSES/` |
> | 8.3 | Benchmark before/after | **Done** — `scripts/test-npc-live.mts`; results and the two defects it found are in the notes below |
> | 8.4 | Bundle weights in the depot instead of fetching at runtime | **Not done** — release packaging, unchanged |
> | 8.6 | Legal sign-off on the Steam survey and Art. 50 | **Not done** — see `AI_TRANSPARENCY_GAP_ANALYSIS.md` |
>
> **Three findings that change the advice in this document:**
>
> 1. **The 4B fallback in §1 is not usable as a default on this hardware.**
>    Measured TTFT median **45 s** against a 20 s watchdog — every turn would
>    abort to a canned line. §1 anticipated this qualitatively ("will silently
>    degrade to stubs"); the measurement makes it decisive.
> 2. **§1's claim that `Qwen3-4B-Instruct-2507` removes the `emptyThink` hack is
>    right, and the code did not know it.** Being non-thinking, it emits EOS
>    immediately when fed the empty `<think></think>` block — a zero-length
>    reply. `NPC_MODELS` now carries a per-model `emptyThink` flag. Conversely
>    `emptyThink: true` is exactly correct for the 1.7B: its GGUF's own template
>    emits that identical block for `enable_thinking = false`.
> 3. **§5's "the nine NPC action verbs" warning was justified, but it is not a
>    swap regression.** Both the stock 1.7B *and* the abliterated 1.7B that
>    shipped before it emit an action verb on **0 of 4** explicit threats. A
>    deterministic floor (`threatActionFor`) now supplies the verb, matching
>    what stub mode already did.
**Scope:** which local LLM ArtifexWebGame should ship if it goes on Steam as a paid product.

> **Get a lawyer to sign this off before release.** Everything below is verified
> against primary sources and cited, but licence interpretation — especially the
> question of whether a third party had the right to grant the licence they
> declared — is a legal judgement, not a technical one. This document is
> research to hand to a lawyer, not a substitute for one.

---

## 1. Recommendation

### Ship this

**`Qwen3-1.7B` (stock instruct), Apache-2.0, quantised to Q4_K_M — ~1.11 GB — used for
both the NPC dialogue model and the Director.**

Get the artefact from either:
- `unsloth/Qwen3-1.7B-GGUF` → `Qwen3-1.7B-Q4_K_M.gguf`, 1.107 GB
  ([repo](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF), declared `apache-2.0`,
  `license_link` → the Qwen LICENSE), **or**
- quantise it yourself from [`Qwen/Qwen3-1.7B`](https://huggingface.co/Qwen/Qwen3-1.7B)
  with `llama-quantize`. This is the better option: it makes the provenance
  reproducible and removes a third party from the chain entirely.

**Why this one:**

1. **The licence is clean end to end and short.** `Qwen/Qwen3-1.7B` is plain
   Apache License 2.0 — I fetched the LICENSE file and diffed it against the
   standard text: it is unmodified Apache-2.0 with `Copyright 2024 Alibaba Cloud`
   in the appendix at line 190. No appended clauses, no acceptable-use policy, no
   revenue cap, no MAU threshold, no field-of-use restriction, no gating.
   ([LICENSE](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE))
2. **It is the same size as what ships today** (1.11 GB vs 1.11 GB), so the
   download and VRAM budget do not move.
3. **It is a zero-engineering swap.** Same `qwen3` GGUF architecture, same 151936
   Qwen2-BPE vocab, same ChatML template that the engine hardcodes. Two string
   changes. Details in §5.
4. **One model for both consumers.** Today the game can pull down two separate
   ~1.1–2.5 GB models. Collapsing Director + NPC onto the single 1.7B halves the
   depot, removes a second cold-start stall, and leaves exactly one licence to
   document in the credits.
5. **It has guardrails.** That is not a licence point — it is the Steam point, and
   it is covered in §4. It is also the single biggest reason not to ship what
   ships today.

### Fallback if 1.7B is not good enough

**`Qwen3-4B-Instruct-2507`, Apache-2.0, Q4_K_M — 2.497 GB.**
[`unsloth/Qwen3-4B-Instruct-2507-GGUF`](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)
(declared `apache-2.0`, `license_link` → the Qwen LICENSE) or self-quantised from
[`Qwen/Qwen3-4B-Instruct-2507`](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507).

Same licence, same architecture, same tokeniser, same template — it is a
size/quality dial on the identical integration. It is also a *non-thinking*
variant, which means the `emptyThink: true` hack that currently exists to stop
Qwen3 burning its whole 320-token budget inside `<think>`
(`src/game/ui/npc-chat-panel.ts:775`, `src/game/director/director.ts:280-283`)
becomes unnecessary rather than load-bearing.

The 4B costs ~2.2x the download and roughly 2–2.5x the prefill and decode time of
the 1.7B (the codebase's own measured ratio,
`src/game/ui/npc-chat-panel.ts:683`). Given that the NPC path already has a 20 s
time-to-first-token watchdog that falls back to canned dialogue
(`NPC_TTFT_DEADLINE_MS = 20_000`, `npc-chat-panel.ts:799`), the 4B will silently
degrade to stubs on mid-range and low-end GPUs far more often than the 1.7B will.
**Use the 4B only if measurement shows the 1.7B failing the dialogue quality bar,
and consider shipping it as an opt-in "higher quality" setting rather than the
default.**

### Do not ship

- The two abliterated models currently wired in — see §4.
- `local/flux2-te-qwen3-4b-q4_k_m`, the Director model — see §4.

---

## 2. What the game actually runs today

Three models are selectable via `?npcllm=`
(`src/game/ui/npc-chat-panel.ts:696-709`). The **shipped default is `fast`**
(`src/game/main.ts:1560`).

| Key | Repo / file | Size | What it actually is |
|---|---|---|---|
| `fast` **(default)** | `mradermacher/Qwen3-1.7B-abliterated-GGUF` / `Qwen3-1.7B-abliterated.Q4_K_M.gguf` | 1.11 GB | mlabonne's abliterated Qwen3-1.7B, quantised by mradermacher |
| `abliterated` | `bartowski/mlabonne_Qwen3-4B-abliterated-GGUF` / `mlabonne_Qwen3-4B-abliterated-Q4_K_M.gguf` | 2.50 GB | mlabonne's abliterated Qwen3-4B, quantised by bartowski |
| `default` (also the Director, `src/game/director/director.ts:32-33`) | `local/flux2-te-qwen3-4b-q4_k_m` / `flux2-te-qwen3-4b-q4_k_m.gguf` | 2,497,280,320 bytes (2.50 GB) | **unlabelled Qwen3-4B-architecture checkpoint, no provenance metadata** |

Inference is the repo's own WebGPU engine (`src/engine/`, `src/model/`,
`src/shaders/`) — not llama.cpp, not web-llm, not transformers.js.
`@huggingface/transformers` 3.8.1 (Apache-2.0) is used **only as a tokeniser**.
The only other inference-relevant deps are transitive and MIT/BSD. The repo
itself is MIT (`LICENSE`, Copyright (c) 2025 Kaven Martinez).

A source-code note that is wrong and should be fixed regardless of what you
decide: `npc-chat-panel.ts:681` describes the default as *"huihui-ai's abliterated
Qwen3-1.7B"*. It is not. `mradermacher/Qwen3-1.7B-abliterated-GGUF` declares
`base_model: mlabonne/Qwen3-1.7B-abliterated`. huihui-ai's model is a different
abliteration by a different author with a different model card. If you were
relying on the comment to know what you shipped, you had the wrong provenance.

### What the model has to be good at

This matters for sizing, so it is worth stating plainly. This is not a
one-liner-generator workload:

- **Persona prose with multi-turn memory** — 8 turns of history
  (`npc-prompt.ts:436`), plus persisted cross-session facts, a roster of up to 8
  named neighbours, and live world facts it is told to weave in.
- **Structured output interleaved with prose.** The model must emit in-character
  dialogue *and* decide unprompted whether the turn warrants exactly one of nine
  JSON control verbs — `{"action":"hostile"}`, `{"trade":{...}}`,
  `{"action":"follow"}`, `{"action":"accept_proposal"}` and so on — with strict
  negative constraints (*"Never emit an action JSON during normal, civil
  conversation"*, `npc-prompt.ts:354`).
- **Conditional instruction-following** — whole prompt branches flip on runtime
  state, and getting the branch wrong is a visible gameplay bug.
- **Light arithmetic** — haggling is bounded at 80% of listed price
  (`npc-prompt.ts:343`), validated server-side.
- **Director**: a single fenced ```` ```json ```` dungeon spec against a schema,
  greedy, with a validator, an error-feedback retry loop (3 attempts,
  `director-llm.ts:27`), and a deterministic fallback spec.

Context is modest — worst measured persona prompt is ~1,110 tokens, and the whole
thing is hard-capped at 2048 by `MAX_ATTN_SEQ_LEN`
(`src/engine/forward-pass.ts:79`). So **no candidate needs long context**; what it
needs is instruction-following density in a small parameter count. That is exactly
the regime where Qwen3 small models are strongest, and it is why I am not
recommending stepping outside the family.

---

## 3. Comparison table

Sizes are the real Q4_K_M artefact sizes I pulled from the Hugging Face file
listings. "Speed" is relative to the 1.7B baseline; see the note on measurement in
§7.

| Model | Licence | Restrictions that matter | Q4_K_M size | Speed | Quality for this use | Engine support |
|---|---|---|---|---|---|---|
| **Qwen3-1.7B** *(recommended)* | Apache-2.0 ([LICENSE](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE)) | None. No cap, no MAU, no AUP, not gated | 1.107 GB | baseline | Adequate — needs measurement against the 9-verb JSON contract | Native; zero work |
| **Qwen3-4B-Instruct-2507** *(fallback)* | Apache-2.0 ([LICENSE](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/LICENSE)) | None | 2.497 GB | ~0.4–0.5x | Best in class at this size; no `<think>` workaround needed | Native; zero work |
| Qwen3-0.6B | Apache-2.0 ([LICENSE](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE)) | None | 0.397 GB | ~2.5–3x | Likely too weak for the JSON verbs; possible low-spec tier | Native; zero work |
| Qwen3-4B (base instruct) | Apache-2.0 | None | 2.497 GB | ~0.4–0.5x | Superseded by 2507 | Native |
| **Qwen3.5-2B / 4B** | Apache-2.0, not gated ([LICENSE](https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE)) | None | n/a | — | Newer/stronger family | **Blocked** — hybrid linear-attention layers; the game's session is dense-only (`gguf-session.ts:110-113`). Future upgrade path, needs engine work |
| **Gemma 4** (E2B / E4B / 12B) | **Apache-2.0** ([licence page](https://ai.google.dev/gemma/docs/gemma_4_license)), not gated — a change from Gemma 1–3's custom terms | Prohibited Use Policy + Terms of Use referenced alongside; whether they bind downstream needs a lawyer's read | — | — | Strong | **Blocked** for the small sizes — E2B/E4B use Per-Layer Embeddings, rejected by the dense-only guard. Smallest dense Gemma 4 is 12B, far too large |
| Gemma 3 (270M / 1B / 4B) | Custom **[Gemma Terms of Use](https://ai.google.dev/gemma/terms)** (`license: gemma`) — not open source. **`gated: manual`** | The heaviest obligations here. §3.2 incorporates the [Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) *by reference*, and §3.1 requires you to include those restrictions **as an enforceable provision in your own game's EULA**, give every player a copy of the Gemma Terms, and ship a NOTICE file — with the NOTICE condition explicitly targeting non-hosted distribution, i.e. exactly a game installer. The PUP bars sexual chatbot content, which is in direct tension with an uncensored dialogue model | — | — | 1B is weak; 4B is decent | Arch explicitly excluded (`model-descriptor.ts:161-166`) |
| **Llama 3.2 1B / 3B** | Llama 3.2 Community License (`license: llama3.2`). **`gated: manual`**. Copy at `l32gh.txt` in the repo root | Works for a game — §2's threshold is **700 million MAU** — but §1(b)(i) requires you to **provide a copy of the agreement** with any redistribution and **prominently display "Built with Llama"**, and to prefix any derived model's name with "Llama". Plus a binding Acceptable Use Policy | — | fast | 1B is weak for structured output | Loads (`llama` arch is supported) but the engine emits **ChatML, not the Llama-3 header template** — silent quality loss unless template work is done |
| Llama 4 | Llama 4 Community License (copy at `l4gh.txt` in the repo root) | Same 700M MAU structure, §2 | — | — | — | Too large |
| **Ministral 3 3B Instruct 2512** | **Apache-2.0**, ungated (verified) — official GGUF sibling also Apache-2.0 | None | — | fast | Plausible; untested here | Loads (`mistral3` is in `GGUF_ARCHS`, marked **experimental**) but it is a `Mistral3ForConditionalGeneration` multimodal wrapper **and the engine would feed it ChatML instead of `[INST]`** |
| Ministral 8B Instruct **2410** | **Mistral Research License 0.1** — `license: other`, `license_name: mrl`, [MRL-0.1](https://mistral.ai/licenses/MRL-0.1.md) | **Non-commercial.** Commercial use needs a paid licence from Mistral | — | — | — | Would load |
| Mistral 7B Instruct v0.3 | Apache-2.0 (verified) | None | — | slow | — | Would load; wrong prompt template |
| Phi-4-mini-instruct | MIT (verified, [LICENSE](https://huggingface.co/microsoft/Phi-4-mini-instruct/resolve/main/LICENSE)) | None | — | fast | Good | **Blocked** — Phi-3-style fused QKV, explicitly excluded |
| SmolLM3-3B | Apache-2.0 (verified) | None | — | fast | Below Qwen3-4B; no advantage at this size | Llama-arch, would load; wrong prompt template |
| OLMo 2 1B Instruct | Apache-2.0 (verified) | None | — | fast | Weaker than Qwen3-1.7B here | **Blocked** — `olmo2` is not in `GGUF_ARCHS` |
| Granite 4.0 (350M / small) | Apache-2.0 (verified) | None | — | very fast | Weak for the JSON verbs | **Blocked** — the `-h-` variants are Mamba2 hybrids |
| MiniCPM5-1B | Apache-2.0, ungated (verified) | None | ~0.69 GB (official GGUF) | ~2x | Unknown here | `LlamaForCausalLM`, vocab 130560 — would load via the `llama` arch, but prompt template needs checking |
| Nemotron 3 Nano 4B | NVIDIA Nemotron Open Model License (`license: other`, [terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/)) | Commercial OK, no thresholds — **but reported to auto-terminate if you circumvent or reduce the efficacy of safety guardrails.** Read it before relying on it; that clause is aimed at exactly what abliteration does | — | — | Persona-trained, NVIDIA markets it for game NPCs | **Blocked** — Mamba2 hybrid |
| EXAONE 4.0 1.2B | `license: other` / `exaone` (verified) | **Reported non-commercial.** Reject | — | — | — | — |
| Hunyuan 1.8B Instruct | **No licence declared on HF at all** (verified: `license: null`) | Reported to exclude the EU, UK and South Korea — fatal for a worldwide Steam release. Reject | — | — | — | — |
| Aya / Command (Cohere) | `cc-by-nc-4.0` | Non-commercial. Reject | — | — | — | — |
| LFM2 (Liquid AI) | **LFM Open License v1.0** — not Apache; a copy is in the repo root at `lfm25.txt` | **Revenue cap.** §5 conditions all commercial rights on not exceeding a "Threshold" defined in §1 as *"annual revenue of 10 million United States dollars ($10,000,000) or more"*; §5(b): commercial use above it *"is not licensed under this Agreement"*. A successful game can cross this — and the licence would lapse retroactively at the moment it did | — | very fast | Good for size | **Blocked** — hybrid conv/attention arch, dense-only guard |

**The conclusion the table drives:** the engine's dense-only, ChatML-only,
`qwen3`/`llama`/`gemma4`-only support surface knocks out almost every alternative
on *technical* grounds before licensing is even reached. Of the models that both
run today and are unencumbered, Qwen3 is the only family with a genuinely strong
sub-2B instruct model. Staying in the family is the right call for engineering
reasons and the licence happens to be the cleanest available.

### Three traps worth naming

1. **"Family X is Apache-2.0" is never true of a family — only of a checkpoint.**
   `Qwen/Qwen2.5-3B-Instruct` is `license: other` / **`qwen-research`**, sitting in
   an org whose other models are Apache-2.0. `mistralai/Ministral-8B-Instruct-2410`
   is the non-commercial MRL while `mistralai/Ministral-3-3B-Instruct-2512` is
   Apache-2.0. I got the Mistral generation wrong on a first pass and had to
   correct it. **Check the exact repo you will ship, every time, and re-check it
   the day you cut the build.**
2. **Community roleplay fine-tunes are the worst option, not the best.** The
   obvious move for a dialogue game is a purpose-built RP fine-tune. Almost every
   sub-4B one on Hugging Face carries **no licence field at all** — which is not
   "permissive by default", it is *no grant to redistribute*. There is no notable,
   permissively-licensed, purpose-built roleplay model under 4B; that scene lives
   at 8B–24B. Plan on a strong general instruct model plus your own persona
   conditioning, which is what the game already does.
3. **Territory carve-outs exist and they are fatal.** Some vendors exclude whole
   jurisdictions (Tencent's Hunyuan terms are reported to exclude the EU, UK and
   South Korea; Llama 3.2's EU-domicile restriction is real but applies only to
   the *multimodal* models and lives in the Acceptable Use Policy, not the LICENSE
   file). Steam sells worldwide. A territory-limited licence is not usable.

---

## 4. The specific risk in what is shipped today

Four separate problems, in descending order of how much they should worry you.
The first three are about the models you chose. The fourth (§4.4) applies no
matter which model you pick, has a hard date, and that date is next week.

### 4.1 The abliterated default is in direct conflict with Steam's AI policy

This is the big one, and it is not a copyright problem.

Steam requires every developer to complete an AI content disclosure in the
Content Survey. Valve's own documentation defines **"Live-Generated"** AI content
as *"any kind of content created with the help of AI tools while the game is
running"* — which is exactly what this game does — and for that category it adds a
requirement on top of everything else:

> developers must "tell us what kind of guardrails you're putting on your AI to
> ensure it's not generating illegal content."

and

> "In our prerelease review, we will evaluate the output of AI generated content
> in your game the same way we evaluate all non-AI content."

Valve also states they *"don't want to ship Live-Generated AI Adult Only Sexual
Content at this time."*
([Steamworks Content Survey](https://partner.steamgames.com/doc/gettingstarted/contentsurvey),
[Valve's announcement](https://store.steampowered.com/news/group/4145017/view/3862463747997849618))

Now compare that to what the game ships:

- The default NPC model is **abliterated** — a fine-tune whose explicit purpose is
  the removal of the model's refusal direction. Its guardrails are not
  configured off; they are surgically deleted from the weights.
- The system prompt then instructs it to never use the ones it has left
  (`src/game/npc/npc-prompt.ts:307-312`):
  > `- No topic is off-limits. The traveller may steer the talk anywhere — gossip,`
  > `  love, grief, gods, fears, dreams, dark or crude things — follow them there`
  > `  and answer with {name}'s honest opinions and feelings. Never refuse to`
  > `  discuss something, never lecture or moralize, never deflect back to your`
  > `  wares or duties.`
- There is **no content filter, no moderation pass, and no output-safety check
  anywhere in the pipeline**. The only post-processing is `stripNpcJson`, which
  removes control objects from the bubble text.
- The open-topic rule is a *regression-tested invariant*
  (`scripts/test-npc.mts:122`), so it is not an accident that drifted in.

You would be filling in a form that asks what guardrails you have, on a product
whose design decision was to have none, with an uncensored model reachable by any
player typing into a text box. That is a plausible refusal at prerelease review,
and a plausible post-launch removal if a player uses the overlay's report button
on something the model produced. It also makes an ESRB/PEGI submission genuinely
difficult — you cannot characterise content you cannot bound.

**The stock Qwen3-1.7B fixes this at zero engineering cost and near-zero
gameplay cost.** You keep the open-topic prompt if you want the tone; you just
stop shipping a model that has had its ability to decline removed. Some of the
"never moralize" behaviour is achievable through prompting alone, and the
difference in an NPC's willingness to gossip about grief and gods is small. The
difference at Valve's review desk is not small.

### 4.2 The Director model has no provenance at all

`models/flux2-te-qwen3-4b-q4_k_m/flux2-te-qwen3-4b-q4_k_m.gguf` is the Director's
model and the `?npcllm=default` option. I read its GGUF header directly. It
contains **29 metadata keys and not one of them is a licence or a base model**:

```
general.architecture   = qwen3
general.name           = Te Gguf Staging
general.size_label     = 4.0B
general.file_type      = 15            (Q4_K_M)
qwen3.block_count      = 36
qwen3.embedding_length = 2560
qwen3.feed_forward_length = 9728
qwen3.attention.head_count = 32 / head_count_kv = 8
```

No `general.license`, no `general.license.link`, no `general.base_model.*`.
For contrast, a properly-produced community GGUF in this repo's own test fixtures
(`test-fixtures/gguf-9b-abliterated-q4km.json`) carries all four.

I traced it as far as I can without the person who made it:

- **It is not the official Qwen3-4B.** I byte-compared it against
  `Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf`. The tensor table is *identical* — all
  398 tensors, same names, dims, types and offsets — and the file is exactly 64
  bytes larger, which is entirely accounted for by the metadata difference. But
  the tensor *payloads* differ: I sampled 256 KB at four offsets into the weight
  data; the first matched and the three others did not. Same architecture and
  same quantisation recipe, **different weights**.
- **It is almost certainly the FLUX.2 text encoder, as `GAME_PLAN.md:34` claims.**
  [`black-forest-labs/FLUX.2-klein-4B`](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)
  ships a `text_encoder/` whose `config.json` is `Qwen3ForCausalLM` with
  `hidden_size: 2560`, `intermediate_size: 9728`, `head_dim: 128`,
  `eos_token_id: 151645`, `bos_token_id: 151643` — matching the GGUF field for
  field — and a `Qwen2Tokenizer` with `model_max_length: 131072`, matching the
  `tokenizer_config.json` sitting next to the GGUF.
- **That repo is Apache-2.0.** Its `LICENSE.md` is the Apache 2.0 text, the HF
  metadata says `apache-2.0`, and it is not gated.

**And here is why that is a near miss rather than a reassurance.** Its sibling
repos are not Apache-2.0. I checked both: `black-forest-labs/FLUX.2-klein-9B` and
`black-forest-labs/FLUX.2-dev` are `gated: auto` and carry
`license_name: flux-non-commercial-license`. Had this text encoder been pulled
from the 9B or from FLUX.2 [dev] instead of from klein-4B, the Director model
would be **flatly unshippable in a paid product** — and nothing in the file would
have told you. An artefact with the weights stripped of every licence field, named
"Te Gguf Staging", is one wrong download away from a non-commercial licence and
you would have no way to know which.

So the likely answer is "this particular one is fine". But **you cannot prove it from the
artefact**, and "probably Apache-2.0, we think, based on matching hyperparameters"
is not a position to be in at commercial release. It is also a checkpoint that was
trained to be a text encoder for an image model and pressed into service as a
chat model — a use its producer never validated.

**Replace it.** If you want to keep a 4B Director, use
`Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf` (2,497,280,256 bytes, sha256
`7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`) — official,
Apache-2.0, and hash-verifiable in CI. Better: fold the Director onto the same
1.7B as the NPCs and ship one model.

### 4.3 The `?npcllm=abliterated` path ships a GGUF with no declared licence

`bartowski/mlabonne_Qwen3-4B-abliterated-GGUF` — the `?npcllm=abliterated` option
— has **no licence field at all** in its Hugging Face metadata: no `license`, no
`license_name`, no `license_link`. I checked via the HF API. Its base
(`mlabonne/Qwen3-4B-abliterated`) does declare `apache-2.0`, and Apache-2.0
permits redistribution, so an argument exists — but the artefact you would
actually ship carries no grant of its own.

By contrast the **shipped default is in better shape than you might fear**:
`mradermacher/Qwen3-1.7B-abliterated-GGUF` declares `apache-2.0` with a
`license_link` pointing at the Qwen3-1.7B LICENSE, and its base
`mlabonne/Qwen3-1.7B-abliterated` also declares `apache-2.0` over Apache-2.0
`Qwen/Qwen3-1.7B`. **The copyright chain on today's default looks defensible.**
The reason to move off it is §4.1, not §4.2-style provenance rot.

Two smaller notes on the chain that a lawyer should be told about:

- **None of the derivative repos ship a licence file.** `unsloth/…`,
  `mradermacher/…` and `mlabonne/…` all return 404 for both `LICENSE` and
  `NOTICE`; only the HF metadata tag asserts Apache-2.0. Whatever you ship, you
  must include the Apache-2.0 text and the attribution yourself — see §6.
- **Abliteration is an unusual derivative.** It works by orthogonalising the
  refusal direction out of the weights. mlabonne's card describes the work as *"a
  research project to understand how refusals work in LLMs"* and *"fairly
  experimental"*. huihui-ai's card for the equivalent model goes further and
  says it is *"recommended for controlled environments, not production or
  public-facing commercial applications"* — that is advisory language on a model
  card, not a licence term, but it is the author of the thing you are shipping
  telling you not to ship it.

### 4.4 EU AI Act Article 50 starts applying on 2 August 2026 — next week

This is not a licensing issue and it does not go away by changing model. It
attaches to you as the *provider of the AI system*, whoever owns the weights.
Two obligations, both quoted from the regulation:

> **Art. 50(1):** "Providers shall ensure that AI systems intended to interact
> directly with natural persons are designed and developed in such a way that the
> natural persons concerned are informed that they are interacting with an AI
> system, unless this is obvious from the point of view of a natural person who is
> reasonably well-informed, observant and circumspect, taking into account the
> circumstances and the context of use."

> **Art. 50(2):** "Providers of AI systems, including general-purpose AI systems,
> generating synthetic audio, image, video or text content, shall ensure that the
> outputs of the AI system are marked in a machine-readable format and detectable
> as artificially generated or manipulated."

The transparency obligations in Article 50 apply from **2 August 2026** under
Article 113. ([Article 50](https://artificialintelligenceact.eu/article/50/),
[Commission FAQ](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act))

What this means concretely for a game whose selling point is talking to AI NPCs:

- **50(1) is probably satisfiable cheaply.** There is an "obvious from context"
  carve-out, and a game marketed as *"living NPCs powered by a local AI"* plausibly
  falls inside it. But "probably" is doing work there, and the fix is trivial —
  a line on the store page and a first-run notice. Do it rather than argue it.
- **50(2) is the harder one.** Machine-readable marking of synthetic *text* is an
  unsettled area with no established technique for in-game dialogue. There are
  exemptions for assistive/editing functions and where the AI does not
  substantially alter the input — **neither of which describes generating NPC
  dialogue from scratch.** Whether and how 50(2) binds a game rendering AI text
  into a speech bubble is exactly the question to put to a lawyer, and it is worth
  putting to them now rather than after launch.

I am flagging this because the date is eight days away and nothing in the repo
addresses it. It is independent of Steam's disclosure requirement in §4.1 — you
would need to satisfy both.

---

## 5. Migration notes — what changing the model means for this codebase

**If you stay inside Qwen3 (the recommendation), this is a two-string change and
nothing else.** That is the entire reason to stay inside Qwen3.

### What does not change

- **Architecture.** `qwen3` is a verified arch in `GGUF_ARCHS`
  (`src/model/model-descriptor.ts:152-170`). GQA, RoPE base, SwiGLU, RMSNorm and
  tied embeddings are all read from the GGUF KV block, not hardcoded.
- **Tokeniser.** Identical — 151936-token Qwen2 BPE, `gpt2` GGUF tokeniser model,
  `qwen2` pretokeniser. The vocab-mismatch guard
  (`src/engine/gguf-session.ts:191-195`, hard-fails above a 1024 delta) will pass.
- **Chat template.** The engine deliberately **ignores the model's own template**
  and emits its own ChatML from `applyChatTemplate`
  (`src/model/tokenizer.ts:226-325`). Qwen3 is ChatML, so this is already correct.
- **Output parsing.** Both parsers are tolerant and already handle a weaker model:
  the Director takes the *last* fenced block, tolerates a missing closing fence,
  falls back to a balanced-brace scan, validates, and feeds errors back for up to
  3 attempts before returning `FALLBACK_SPEC`. The NPC parser scans every balanced
  `{…}`, `JSON.parse`es each in a try/catch, takes last-valid-wins, and treats a
  parse failure as a no-op. Nothing needs changing.
- **Fallback behaviour.** The 20 s TTFT watchdog → `stubReply` path, the
  KV-fork repair, the anti-parrot re-roll, the Director's fixture-first
  `specFor()` and session-disable on chat error — all model-agnostic.

### What to change

1. `src/game/ui/npc-chat-panel.ts:696-709` — the `NPC_MODELS` table.
2. `src/game/director/director.ts:32-33` — `DIRECTOR_MODEL_ID` and
   `DIRECTOR_GGUF_FILE`.
3. Place the GGUF plus `tokenizer.json` and `tokenizer_config.json` where the
   local-cache resolver finds them (the game loads the tokeniser from JSON next to
   the GGUF, not from inside it — `src/model/tokenizer.ts:87-96`).
4. Fix the stale comment at `npc-chat-panel.ts:681` naming the wrong author.

### What to re-measure after the swap

- **Director JSON compliance.** A 1.7B will hit the schema less reliably than a
  4B. The retry loop and validator absorb this, but if attempt 3 fails often the
  player gets fixture dungeons. Measure the first-attempt success rate before and
  after; the existing scripts under `scripts/` are the place to do it.
- **The nine NPC action verbs.** Specifically the *negative* constraints — a
  smaller model emitting `{"action":"hostile"}` during civil conversation is a
  worse bug than failing to emit it when threatened. `npc-trade.ts` validation
  will reject malformed ones, but a well-formed wrong one goes straight through.
- **TTFT on a low-spec GPU.** The ~1,000-token system prompt is the cost driver:
  the repo records a *"full ~1000-token re-prefill (30-45 s measured)"* on the 4B
  (`npc-chat-panel.ts:738-741`), which is why the KV fork exists. Dropping to 1.7B
  should cut that by half or better, which *widens* your hardware support.

### If you ever leave the Qwen family

Two traps, both silent:

- **The prompt template.** There is no Llama-3 (`<|start_header_id|>`) and no
  Mistral (`[INST]`) template anywhere in the repo. A Llama-3 model will load,
  run, and produce quietly degraded output because it is being fed ChatML. This
  is the single most likely way a model swap goes wrong without erroring.
- **The dense-only guard.** `src/engine/gguf-session.ts:110-113` throws for
  MoE, Gemma-PLE and hybrid models. This is what rules out Qwen3.5-2B (hybrid
  linear attention), Gemma 4 E2B/E4B (PLE), and LFM2 (hybrid conv) — all of which
  would otherwise be attractive. `model-descriptor.ts:187` throws outright for
  Phi-3, DeepSeek and Gemma 2/3.

---

## 6. Shipping weights in a Steam depot

**Size.** Steam's build documentation states no maximum depot or build size, and
multi-gigabyte games are routine; a 1.1 GB model is unremarkable next to the
game's own assets. The 2 GB figure that circulates applies to the browser-based
depot upload in the partner site — use SteamPipe/`steamcmd` and it does not apply.
([Steamworks: Builds](https://partner.steamgames.com/doc/store/application/builds))
The real cost is player-side: an extra 1.1 GB of download and ~1.1 GB of VRAM held
resident alongside a renderer targeting 60 fps. The 1.7B is the right side of that
trade; the 4B is marginal on 8 GB cards.

**Redistribution.** Apache-2.0 explicitly permits redistribution in object form,
which is what shipping weights in a depot is. There is no separate permission
needed and no royalty. Note that you are currently *downloading* models from
Hugging Face at runtime — for a Steam release you should **bundle them in the
depot instead**. Runtime-fetching a third-party CDN means your game breaks when
someone renames a repo, and it moves the redistribution question onto Hugging
Face's terms of service rather than the model licence.

**Steam has its own licence-compatibility rule, and you clear it.** Valve's
documentation states: *"If your application contains third party open source code
that is incompatible with the Steamworks SDK, then YOU MUST NOT DISTRIBUTE YOUR
APPLICATION VIA STEAM."* It names MIT, BSD 3- and 4-clause, Apache 2.0 and WTFPL as
acceptable, and flags GPL and other copyleft licences as the problem case. **The
recommendation (Apache-2.0 weights, MIT game code) is explicitly on the compatible
list.** Nothing in this document is copyleft.
([Steamworks: distributing open source](https://partner.steamgames.com/doc/sdk/uploading/distributing_opensource))

**There is shipped precedent for bundling weights in a commercial game.** Krafton's
inZOI ships an on-device small language model for its NPC behaviour, and NVIDIA's
Game Agent SDK — which exists specifically to put local models in games — has
build scripts that produce a redistributable package with and without bundled
models. Worth noting for the recommendation: NVIDIA's own on-device picks for that
SDK are Apache-2.0 Qwen models shipped as local GGUF. You would be doing a
well-trodden thing, not an exotic one.

**Gating matters more than it looks.** Several otherwise-plausible candidates are
`gated: manual` on Hugging Face — every Gemma 3 checkpoint, every Llama 3.2
checkpoint, FLUX.2 [dev] and FLUX.2-klein-9B. Gating means *you* clicked through
and accepted terms to get the weights. Bundling those weights in a Steam depot
hands them to hundreds of thousands of people who never did. Whether that is
permitted depends entirely on the licence's redistribution clause, and it is a
question you do not have to answer at all if you pick an ungated Apache-2.0 model.
Every Qwen3 and Qwen3.5 repo I checked is `gated: false`, as is FLUX.2-klein-4B
and Gemma 4. **Prefer ungated.**

**Attribution you must actually ship.** Apache-2.0 §4 requires, when you
distribute: a copy of the licence, retention of copyright/attribution notices, and
— if the original had a NOTICE file — reproduction of its contents. Qwen's repo
has no NOTICE file (I checked; 404), which simplifies things. So for the
recommendation, put this in the game's credits and in a `THIRD_PARTY_NOTICES.txt`
in the install directory:

```
Qwen3-1.7B — Copyright 2024 Alibaba Cloud
Licensed under the Apache License, Version 2.0
https://www.apache.org/licenses/LICENSE-2.0
[full Apache-2.0 licence text]

@huggingface/transformers — Copyright Hugging Face
Licensed under the Apache License, Version 2.0
```

plus MIT/BSD notices for the transitive npm dependencies that ship in the bundle.
The repo has **no NOTICE or THIRD_PARTY file today** — only its own MIT `LICENSE`
— so this needs creating either way.

If you were to choose Llama instead, the obligations are materially heavier:
ship a copy of the Llama Community Licence, display **"Built with Llama"**
prominently, and comply with the Acceptable Use Policy. The 700 million MAU
threshold is not a practical concern for a game, but the naming and display
obligations are real work.

---

## 7. What I could not verify — confirm before release

1. **Whether a lawyer agrees the abliteration chain is validly licensed.** Every
   link declares Apache-2.0, which is coherent, but the question of whether a
   fine-tuner has authority to relicense weights they modified is unsettled law
   and I am not qualified to answer it. Moot if you take the recommendation.
2. **The true provenance of `flux2-te-qwen3-4b-q4_k_m.gguf`.** My identification
   as the FLUX.2-klein-4B text encoder is inference from matching hyperparameters,
   not proof. Whoever produced that file should confirm where it came from — or
   the file should be deleted and replaced, which is cheaper than proving it.
3. **The FLUX.2-klein-4B card's usage restrictions.** The repo's `LICENSE.md` is
   Apache-2.0, but its model card lists prohibited uses. Whether those are
   contractual additional terms or advisory needs a legal read. Also moot if the
   file is replaced.
4. **Whether Gemma 4's Prohibited Use Policy binds despite the Apache-2.0
   licence.** Gemma 4 moving to Apache-2.0 (verified: `license: apache-2.0`,
   ungated, on every checkpoint I checked) is a real change from Gemma 3. Under
   the *Gemma Terms*, §3.2 incorporates the PUP by reference; Apache-2.0 contains
   no such incorporation clause, and the Gemma 4 model card carries no
   prohibited-use text. That suggests the PUP is advisory for Gemma 4 and binding
   for Gemma 1–3 — **but this is an inference from licence structure, not
   something Google states.** Only matters if the engine ever gains PLE support.
5. *(Resolved — no confirmation needed.)* The LFM Open License v1.0 threshold is
   **$10,000,000 annual revenue**, read directly from §1 and §5 of the copy at
   `lfm25.txt`. This is the kind of clause the brief asked to watch for: a
   revenue cap a game could plausibly cross. LFM2 is ruled out on architecture
   anyway, but do not reach for it later without re-reading that clause.
6. **Real tokens/sec for these models in this engine.** The repo's measured
   figures are for a 27B IQ2_XXS on an RX 6700 XT (~11.5 tok/s) and are not
   transferable. The only in-repo numbers for the game models are relative
   ("2–2.5x faster") and one prefill measurement ("30-45 s" for ~1000 tokens on
   the 4B). **Benchmark the actual candidates on the actual minimum-spec GPU
   before committing** — this determines how often players get canned dialogue
   instead of the feature they bought the game for.
7. **How Valve responds to the AI disclosure for this specific game.** §4.1 is my
   reading of published policy applied to your design. Valve's prerelease review
   is discretionary. If shipping live LLM dialogue is the core of the product, it
   is worth getting the disclosure right the first time rather than discovering
   the answer at review.
8. **Age-rating implications.** Neither ESRB nor PEGI has settled guidance on
   unbounded generative dialogue. Worth asking your rating body directly.
9. **How EU AI Act Art. 50(2) applies to in-game dialogue (§4.4).** I verified the
   text and the 2 August 2026 date. I could not find established practice for
   machine-readable marking of generated *text* in a game, nor a regulator
   statement on whether rendering AI dialogue into a speech bubble triggers it.
   This needs a lawyer, and the date is next week.
10. **The exact NVIDIA Nemotron guardrail-circumvention clause.** Reported to
   auto-terminate the licence if you reduce the efficacy of safety guardrails —
   which would be pointed, given §4.1. I did not read the PDF myself. Nemotron is
   blocked on architecture anyway, but do not reach for it later without checking.

---

## 8. One-line answer, and what to do next

Ship **Qwen3-1.7B at Q4_K_M, Apache-2.0, ~1.11 GB, self-quantised, one model for
both the Director and the NPCs** — it is the same size and speed as what you ship
now, it is a two-string change, its licence is the cleanest available, and unlike
the current default it does not require you to tell Valve that your live-generated
AI has had its guardrails removed on purpose.

In rough order:

1. Delete `models/flux2-te-qwen3-4b-q4_k_m/` and stop shipping an unlabelled
   checkpoint (§4.2).
2. Point `NPC_MODELS` and `DIRECTOR_MODEL_ID` at one self-quantised Qwen3-1.7B,
   and record the sha256 so the build is reproducible (§5).
3. Benchmark Director JSON compliance and NPC action-verb accuracy before and
   after, on minimum-spec hardware (§5, §7.6).
4. Bundle the weights in the depot instead of fetching from Hugging Face at
   runtime (§6).
5. Write `THIRD_PARTY_NOTICES.txt` — none exists today (§6).
6. Decide the Steam AI content survey answer, and the EU AI Act Art. 50 disclosure,
   with a lawyer (§4.1, §4.4). The Art. 50 date is 2 August 2026.

**A lawyer should review this before release.** It is not a formality here: two of
the six items above are legal judgements, not engineering ones.
