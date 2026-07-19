# Gemma 4 WebGPU — Next Session Pickup

**Branch**: `feature/gemma-webgpu` (5 commits ahead of master)
**Date paused**: 2026-04-19
**Model on disk**: `C:/Artifex-Assistant-V5/models/gemma-4-e4b-it/` (BF16, 15.99 GB)

---

## Status at pause

### Committed this session (on `feature/gemma-webgpu`)

| SHA | Summary |
|---|---|
| `0e77d28` | `GEMMA4_ARCHITECTURE.md` — full intel doc (42 L, dual head_dim, PLE, softcap, SWA, etc.) |
| `28ec714` | `gemma4_text` model-config parsing — all new fields populated from config.json |
| `7504650` | Per-layer attention-kind helpers (`getLayerAttentionKind/HeadDim/Rope`) + forward-pass routing |
| `9f334f8` | Sliding-window mask in `attention.wgsl` (Params grows to 48 B, `slidingWindow` arg on dispatchAttention) |
| `f02d638` | Chat template routes by `modelType` — Gemma uses native `<bos><\|turn>` template |

### Not yet pushed to remote

All 5 commits are local only. Push when next session opens:

```bash
git push -u origin feature/gemma-webgpu
```

---

## Where to start next session

**Task list at pause** (use `TaskList` to refresh):

- **#22** — First forward pass + top-5 logit validation (blocked by #23–#28, #30)
- **#23** — (1+w) RMSNorm convention for Gemma
- **#24** — GELU-tanh activation variant for FFN
- **#25** — Per-Layer Embeddings (PLE) — biggest piece, blocks meaningful VRAM budget
- **#26** — Proportional RoPE + per-layer RoPE config wiring
- **#27** — Dual head_dim per attention layer type
- **#28** — Final logit softcapping (tanh(x/30)*30)
- **#29** — KV cache sharing (defer — not correctness-critical)
- **#30** — Quantize Gemma 4 E4B to INT4 for 8 GB VRAM

---

## Pre-quant survey (option A from last session)

Results of checking HF for pre-quantized Gemma 4 E4B:

| Repo | Format | Size | Usable? |
|---|---|---|---|
| `unsloth/gemma-4-E4B-it-GGUF` | GGUF Q4_K_M | 4.98 GB | ❌ llama.cpp format; our engine reads safetensors |
| `unsloth/gemma-4-E4B-it-UD-MLX-4bit` | MLX | — | ❌ Apple Silicon only |
| `cyankiwi/gemma-4-31B-it-AWQ-4bit` | AWQ | — | ❌ wrong size variant (31B, won't fit 8 GB) |
| (no GPTQ/AWQ/bnb for E4B) | — | — | — |

**Decision**: No drop-in pre-quant exists. Two realistic paths:

1. **GGUF → safetensors converter** (medium task) — unpack Unsloth's Q4_K_M into our INT4 layout. K-quants are well-documented (see `ggml/src/ggml-quants.c`). Avoids running a GPTQ pipeline.
2. **Run our own GPTQ pipeline on BF16** (task #30, harder) — we already have the GPTQ pipeline from Qwen3.5; the risks are PLE table handling (novel) and SSM-like precision issues (may not apply since Gemma has no SSM).

Path 1 is probably faster **if** we don't care about PLE quality differences (Unsloth's quant already handles PLE optimally for their format).

---

## Recommended order when resuming

### Option B — scaffolding knockouts (1–2 hours, feels productive)

Knock out the small, well-understood pieces to clear blockers on #22:

1. **#23 (1+w RMSNorm)** — check `rmsnorm.wgsl` for existing `use_residual_weight` flag; gate on `modelType.startsWith('gemma')` in forward-pass dispatch. ~30 min.
2. **#28 (Logit softcap)** — one-pass elementwise kernel (or inline in lm_head output); gate on `config.finalLogitSoftcapping`. ~20 min.
3. **#24 (GELU-tanh)** — new elementwise shader variant; route in FFN based on `config.hiddenAct`. ~45 min.
4. **#26 (Proportional RoPE)** — wire `getLayerRope(config, l)` into the RoPE dispatch; implement proportional scaling per `modeling_gemma4.py`. ~1 hour.

After these, we still can't run (PLE + dual head_dim + quant missing), but the diff to running shrinks significantly.

### Option C — tackle PLE (#25) head-on

The honest critical path. Novel kernel + significant memory. Plan a multi-session approach:

- Session 1: PLE table loader + memory layout (quantized? streamed?)
- Session 2: Per-layer embed lookup + projection kernel
- Session 3: Residual fusion + integration in forward-pass

Before starting, **get the exact PLE fusion code from `modeling_gemma4.py`** (transformers source). Open question from architecture doc:
> "Exact PLE fusion path — is the 256-dim input added to the residual stream, or concatenated, or projected into attention Q/K/V?"

---

## Critical facts to remember

- **16 GB BF16 does NOT fit 8 GB VRAM** — any validation needs INT4 first.
- **PLE table alone is 2.8 B params** (5.6 GB BF16, 1.4 GB INT4). Dominates memory budget.
- **Gemma 4 uses `hidden_activation`, not `hidden_act`** — config parser already handles this (28ec714).
- **Proportional RoPE** is a scaling variant we don't yet support — needs `modeling_gemma4.py` for exact formula.
- **KV cache sharing pattern** — unknown which neighbor each shared layer points to. Need to read the modeling code.
- **Chat template** — Gemma uses `<|turn>role\n...<turn|>\n` with `<bos>` prefix. Already routed by `modelType` in `tokenizer.ts`.

---

## Useful commands

```bash
# Refresh task state
# (use TaskList via harness)

# Typecheck
cd C:/Artifex-Assistant-V5/webgpu && ./node_modules/.bin/tsc --noEmit -p tsconfig.json

# View Gemma 4 config for reference while coding
cat C:/Artifex-Assistant-V5/models/gemma-4-e4b-it/config.json

# Reference implementation source (may need to pip install transformers==5.5.0.dev0)
# modeling_gemma4.py is what we MUST match bit-for-bit
```

---

## Sampler note

Per the preset system (see memory + LEARNING.md): when Gemma first produces output, **test with `deterministic` preset (temp=0)** before touching anything else. If greedy produces garbage, the bug is kernel/quant — not sampler.
