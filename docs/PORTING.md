# Porting *A Tale of Yarn* — Steam (Windows), Steam Deck, Xbox

**Date: 27 July 2026.** Platform facts in this area go stale in months; every claim below
carries a source and a date. Re-check anything older than ~6 months before acting on it.

## How to read this document

Claims are tagged so you can tell what is load-bearing:

| Tag | Meaning |
| --- | --- |
| **[VERIFIED]** | Documented in a primary source (URL + date), or measured on this machine today. |
| **[MEASURED-HERE]** | I ran it on the dev machine on 2026-07-27. Reproduction steps in Appendix A. |
| **[INFERRED]** | My reasoning from verified facts. The arithmetic is shown so you can check it. |
| **[MUST-TEST]** | Cannot be settled without hardware we do not have. The test is named. |
| **[UNVERIFIED]** | I looked and could not find a source. Stated as unknown, not smoothed over. |

A note on discipline, because this project has been burned by it: "Electron supports WebGPU"
is not a claim worth writing down. "Electron 43.2.0 ships Chromium 150 and reports
`webgpu: enabled` with no command-line flags on this machine" is. Where I could only get the
weaker version, it is tagged **[UNVERIFIED]** and treated as a risk, not a plan.

---

## 0. Verdict

| Platform | Verdict | Effort | The thing that actually decides it |
| --- | --- | --- | --- |
| **Steam / Windows** | **Yes.** Straightforward, with one input unknown to test in week one. | Weeks | WebGPU works in Electron unflagged, **and survives the Steam-overlay flags** **[MEASURED-HERE]**. Shipped precedent is abundant. The one live risk is that the browser Gamepad API is reportedly broken under Steam Input on Chromium 114+ (§2.5). |
| **Steam Deck** | **"Playable" plausible. "Verified" needs a gameplay redesign, not just optimisation.** | Weeks–months, gated on a hardware test | **AMD is still not in Chromium's Linux WebGPU rollout as of Chromium 150** (Intel at 144, NVIDIA at 147–148, AMD unannounced) — and the Deck is AMD; the game fails 5 Verified criteria; extrapolated rendering is 10–19 fps against a documented 30 fps bar; and because **WebGPU exposes only one queue**, generating dialogue while holding 30 fps works out at ~1–2 tok/s, i.e. **the headline feature cannot run concurrently with play**. |
| **Xbox** | **No, not as it stands.** Three independent blockers, and the worst is not technical. | Months for a native rebuild, **plus a redesign of what the game is** | (1) No browser path: Dawn explicitly does not support Xbox D3D12, WebView2-on-Xbox has no WebGPU adapter, consoles forbid JIT, and UWP games are no longer accepted. (2) A native rebuild is an AOT/rewrite job — the only proven route for JS on console. (3) **Store Policy §11.16 makes you liable for the AI's output meeting §11.5/11.7/11.9**, and the game's guardrail deliberately blocks only *illegal* content. That is a designed-in conflict. |

**The one-sentence version:** Steam-Windows is a packaging exercise; Steam Deck is an input and
performance project sitting on an unresolved driver question, with a gameplay-architecture
change underneath it; Xbox is a rewrite of both the engine *and* the content policy, and the
content policy is the harder half.

**The three biggest risks, in order:**

1. **Xbox: Store Policy §11.16** makes the developer answerable for the model's output complying
   with §11.5/11.7/11.9, and this game's guardrail is deliberately scoped to illegal content
   only. Not a porting problem — a product-definition problem (§4.5).
2. **Deck: WebGPU's single queue** means dialogue generation and 30 fps rendering cannot
   coexist; measured Deck inference data puts concurrent generation at ~1–2 tok/s (§3.5).
3. **Steam + Deck: the browser Gamepad API under Steam Input.** Reported dead on Chromium 114+,
   including on Deck's own buttons — and we are on Chromium 150 with zero gamepad code today
   (§2.5, §1.3).

---

## 1. What is actually being ported (measured, not assumed)

Everything in this section was measured in the working tree on 2026-07-27.

### 1.1 Size and shape of the codebase

| Thing | Measurement | How |
| --- | --- | --- |
| TypeScript in `src/` | **98,044 lines**, 216 files | `find src -name "*.ts" \| xargs wc -l` |
| — of which `src/game/` | **72,117 lines** (the game proper) | same, scoped |
| — of which `src/engine/` | 8,867 lines (LLM inference engine) | same |
| — of which `src/model/` | 5,908 lines (GGUF/HF loading) | same |
| WGSL shaders in `src/` | **10,392 lines**, 53 files | `find src -name "*.wgsl" \| xargs wc -l` |
| — of which `src/game/shaders/` | 3,560 lines, 20 files | same, scoped |

The brief's "~30–40k lines TS + WGSL" understates it. `src/game/` alone is 72k lines of
TypeScript, and the whole tree is ~98k TS + ~10k WGSL. This matters only for the Xbox
section, where every one of those lines needs either a JS runtime or a rewrite.

### 1.2 GPU surface — good news for portability

The game and the LLM share **one** `GPUDevice`, created in `src/engine/gpu-device.ts` and
called from `src/game/main.ts:784`. There is exactly one device in the process.

**The engine requests no optional WebGPU features except `timestamp-query`, and that one
degrades gracefully** (`gpu-device.ts:119-122` only pushes it if the adapter has it;
`forward-pass.ts:954` branches on `device.features.has('timestamp-query')`).

I grepped the whole tree for `shader-f16`, `float32-filterable`, `dual-source-blending`,
`subgroups`, `depth32float-stencil8`, `bgra8unorm-storage`, `texture-compression-*`,
`indirect-first-instance` and `rg11b10ufloat` as *requested features*: **no hits**. The
renderer and the inference kernels are core WebGPU, f32/u32 only.

**[INFERRED]** This is the single most encouraging fact in the whole report. A codebase that
sticks to core WebGPU with no optional features is about as portable as WebGPU content gets —
it should run on any conformant implementation (Dawn, wgpu, or another browser) without a
feature-negotiation matrix. It removes an entire class of porting risk from every tier.

The `requiredLimits` block (`gpu-device.ts:126-137`) is also well-behaved: every limit is
requested as `min(adapterLimit, cap)` rather than a hard floor, so the device request adapts
to weaker hardware instead of failing. `maxBufferSize` is capped at 2 GB.

**[MUST-TEST]** What is *not* proven is whether the shaders actually *run* within a weak
adapter's limits once granted. Requesting `maxStorageBuffersPerShaderStage:
adapterLimits.maxStorageBuffersPerShaderStage` succeeds on any adapter, but if a bind group
layout needs 12 storage buffers and the adapter reports 8, pipeline creation fails at runtime,
not device creation. This machine reports 16 **[MEASURED-HERE]**. Deck-class adapters must be
checked.

**And there is a specific, named trap here worth checking before anything else.** **[VERIFIED]**
WebGPU's *default* limits are `maxBufferSize` **256 MiB** and `maxStorageBufferBindingSize`
**128 MiB**, and a device created without `requiredLimits` enforces those defaults regardless of
what the adapter could offer. **Qwen3-1.7B ties its embeddings, so the 151936×2048
embedding/LM-head tensor is ~187 MiB at Q4_K — over the 128 MiB default binding limit.**

`gpu-device.ts` does request raised limits, so this *should* be fine. But the failure mode is
nasty: on this machine the request is granted because the adapter is generous
(`maxStorageBindingMB=2048` **[MEASURED-HERE]**), so a Deck-class adapter that grants less would
be the first place the problem ever appears. **[MUST-TEST]** assert the *granted*
`device.limits`, not the requested ones, and fail loudly on a shortfall. A Deck
`vulkaninfo` dump **[VERIFIED]** shows RADV VANGOGH offering `maxStorageBufferRange` ≈ 4 GiB and
a 5.96 GiB device-local heap, so the hardware is not the constraint — the API defaults are.

### 1.3 Input — confirmed zero gamepad support

```
grep -rn "getGamepads\|gamepadconnected" --include=*.ts --include=*.js --include=*.html \
     --exclude-dir=node_modules --exclude-dir=dist .
→ (no matches)
```

**[VERIFIED]** There is no Gamepad API usage anywhere in the repository. Input is keyboard
(`e.code`, `KeyW`/`KeyA`/… — `src/game/controller.ts:52-68`, `src/game/main.ts:4785`) plus
mouse with pointer lock (`canvas.requestPointerLock()` at `main.ts:1275`, `main.ts:1996`,
`main.ts:6988`, `ui/panel-manager.ts:121`).

### 1.4 NPC chat is a real DOM text input

`src/game/ui/npc-chat-panel.ts:1310` creates `document.createElement('input')` with
`type = 'text'`, id `npc-chat-input`. The player types free text; Enter sends
(`npc-chat-panel.ts:2021`).

**[INFERRED]** This is *fortunate* for the Deck. Steam's floating on-screen keyboard
"sends OS keyboard keys directly to the game" **[VERIFIED**, see §3.3**]** — a real focused
DOM `<input>` will receive those synthesised keystrokes natively. Had the chat field been
drawn into the canvas with custom hit-testing, we would have had to write our own text-entry
widget. We do not.

### 1.5 The model, and how it is fetched today

**[VERIFIED]** The shipped default is **stock `unsloth/Qwen3-1.7B-GGUF` /
`Qwen3-1.7B-Q4_K_M.gguf`, ~1.11 GB, Apache-2.0** — `NPC_MODELS.fast` and `.default` in
`ui/npc-chat-panel.ts:722-757`, and `DIRECTOR_MODEL_ID` in `director/director.ts:58-59`. One
model serves both the NPCs and the Dungeon Director; the session dedups on `repo::file`, so it
is one download and one resident copy.

**Correction to the brief.** The brief describes the game as having "experimented with an
abliterated/uncensored fine-tune" and asks me to flag what that means per platform. The
correction is that **abliteration is not the shipped configuration and has not been since
2026-07-25**. It survives only behind the `?npcllm=abliterated` URL flag as a comparison
path, pointing at `bartowski/mlabonne_Qwen3-4B-abliterated-GGUF`
(`npc-chat-panel.ts:765-769`). The code comments are explicit that it is "NOT shippable as a
default" and that "the upstream GGUF declares no licence". `npc/content-safety.ts:41-46` says
the same. I have written the platform sections against **stock Qwen3-1.7B + the four-layer
guardrail**, which is what would actually ship, and noted separately where the abliterated
path would change the answer (it changes it from "hard" to "impossible" on console).

**Loading mechanism — and a concrete porting trap.** `src/model/hf-hub.ts` fetches weights
from `https://huggingface.co` using **HTTP Range requests** (`fetchRange`, line 314-341,
`Range: bytes=${start}-${end - 1}`). For a Steam release the weights must come from the depot
instead. Two things make that non-trivial:

1. `fetch()` on a bare `file://` URL is blocked by Chromium. The wrapper needs a custom
   protocol handler or a loopback static server. The coordinator's probe
   (`scripts/_probe-electron-main.cjs`) already notes this.
2. **The silent-failure hazard:** `fetchRange` accepts a `200 OK` as well as a `206 Partial
   Content` (`if (!resp.ok && resp.status !== 206)` — line 331). A custom protocol handler that
   ignores the `Range` header and returns the whole file will therefore *appear to work* while
   materialising all 1.11 GB into an `ArrayBuffer` on every single range call. Whatever
   protocol handler is written **must** honour `Range` and return 206, and there should be a
   test that asserts the status is 206, not merely that loading succeeded.

### 1.6 What the game path actually ships

| Component | Size |
| --- | --- |
| `dist/` total | 24 MB |
| — of which `ort-wasm-simd-threaded.jsep-*.wasm` (ONNX runtime, **not** game path) | 21 MB |
| — of which eSpeak NG TTS (`espeak-*.wasm` + `tts-*.js`) | ~380 KB |
| Game-path JS, gzipped: `game-*.js` 314 KB + `forward-pass-*.js` 331 KB + small chunks | **~656 KB gz** |
| Electron 43.2.0 runtime, unpacked | 348 MB |
| Model weights (Q4_K_M 1.7B) | 1.11 GB |

**[INFERRED]** Depot estimate: **~1.5 GB installed, ~1.3–1.5 GB download.** Quantised weights
are close to incompressible, so Steam's depot compression buys almost nothing on the 1.11 GB;
the Electron runtime compresses well. This is unremarkable for Steam and comfortable for the
Deck's storage.

The 21 MB ONNX runtime and the eSpeak TTS chunk are on the `index.html` / Artifex-GUI path,
not `game.html`. **[VERIFIED]** The service worker is registered only from `src/main.ts:3350`,
also not the game path. A game depot can drop all three. Dropping eSpeak also drops the only
GPL-3.0 component, which matters — Valve's own rules say an application containing third-party
open-source code incompatible with the Steamworks SDK must not be distributed via Steam, and
they name GPL as the problem case (see `docs/AI_MODEL_LICENSING.md` §6, which already covers
this ground and should not be re-litigated here).

### 1.7 The dev machine, for scaling arithmetic

**[MEASURED-HERE]** `metrics.jsonl` and Electron's own GPU enumeration report two GPUs:
**AMD Radeon RX 6700 XT** (driver 32.0.21043.5001) and **NVIDIA GeForce RTX 5060 Ti**. The
game picks the AMD part via `powerPreference: 'high-performance'`; the runtime metric records
`vendor: amd, architecture: rdna-2`.

This is a genuinely useful accident: **the dev GPU is the same architecture family as the
Steam Deck.** RDNA2 is already proven to run this workload. The Deck question is purely one of
scale, which makes the extrapolation in §3.4 much more trustworthy than a cross-vendor guess
would be.

| | RX 6700 XT (dev) | Steam Deck (LCD) | Ratio |
| --- | --- | --- | --- |
| Architecture | RDNA2 (Navi 22) | RDNA2 (Van Gogh) | same |
| Compute units | 40 CU / 2560 SP | 8 CU / 512 SP | 5.0× |
| Boost clock | 2581 MHz | up to 1600 MHz | 1.6× |
| FP32 | ~13.2 TFLOPS | 1.0–1.6 TFLOPS | **~8.2×** |
| Memory bandwidth | 384 GB/s (GDDR6, 192-bit) | 88 GB/s (LPDDR5-5500) | **4.4×** |
| Deck OLED bandwidth | — | 102.4 GB/s (LPDDR5X-8533) | 3.75× |
| Power | 230 W TBP | 3–15 W APU | ~15× |

Sources: [Wikipedia — Radeon RX 6000 series](https://en.wikipedia.org/wiki/Radeon_RX_6000_series)
(accessed 2026-07-27); [Wikipedia — Steam Deck](https://en.wikipedia.org/wiki/Steam_Deck)
(accessed 2026-07-27).

**Note on one number.** The Wikipedia RX 6000 table returned "23,767 … 26,429 GFLOPS" for the
6700 XT, which is the *half-precision* column — 2560 shaders × 2 FLOP/clock × 2.581 GHz =
**13.2 TFLOPS FP32**, and 26.4 TFLOPS is exactly 2× that, i.e. packed FP16. I have used the
derived 13.2 TFLOPS. The Deck's quoted 1.0–1.6 TFLOPS is self-consistent with its own
specs (512 × 2 × 1.6 GHz = 1.638), which is a good sign the comparison is like-for-like.

---

## 2. Tier 1 — Steam on Windows

**Verdict: yes, and it is the easy one. Confirmed, not assumed.**

### 2.1 WebGPU in Electron — settled today, on this machine

The brief asked which Electron/Chromium version enables WebGPU by default on Windows D3D12,
and warned that "Electron supports WebGPU" is not the claim we need. So I measured it.

**[MEASURED-HERE]** `node_modules/electron` is **43.2.0**, which bundles:

```
ELECTRON=43.2.0   CHROME=150.0.7871.129   NODE=24.18.0   V8=15.0.1240245-electron.0
```

With **no command-line flags at all** — no `--enable-unsafe-webgpu`, no
`--enable-features=Vulkan` — a `BrowserWindow` loading a local page reports:

```
navigator.gpu = object
ADAPTER_OK  vendor=amd  arch=rdna-2
LIMITS      maxBufferMB=2048  maxStorageBindingMB=2048  maxStorageBuffersPerStage=16
DEVICE      ok
FEATURES    depth32float-stencil8, rg11b10ufloat-renderable, texture-formats-tier1,
            bgra8unorm-storage, texture-compression-bc, dual-source-blending,
            core-features-and-limits, float32-filterable, indirect-first-instance,
            float32-blendable, depth-clip-control, texture-compression-bc-sliced-3d,
            timestamp-query, clip-distances, shader-f16, texture-formats-tier2,
            primitive-index, texture-component-swizzle, subgroups
```

and Electron's own `app.getGPUFeatureStatus()` reports **`"webgpu": "enabled"`** (alongside
`webgl: enabled`, `gpu_compositing: enabled`).

Two practical conclusions:

1. **The `--enable-unsafe-webgpu` switch in `scripts/_probe-electron-main.cjs` is redundant.**
   Its own comment guessed as much; it is confirmed. Consider dropping it — passing an
   "unsafe" flag in a shipped product invites unnecessary questions and could in principle
   enable non-conformant behaviour you do not want.
2. **Adapter and device acquisition succeed on the real target GPU.** The full boot-to-
   `__gameReady` proof is the coordinator's, and is *local proof pending* — I have deliberately
   not duplicated it. What I add is the narrower, separable fact that **no flag is required**.

**Caveat, stated because it bit me:** if you query `app.getGPUFeatureStatus()` before any
`BrowserWindow` exists, Electron reports everything as `disabled_software` / `webgpu:
disabled_off`, because the GPU process has not started. That is an artefact of the probe, not
a real result. Query it *after* a window has loaded. Anyone re-running this check needs to know
that, or they will report a false negative.

### 2.2 Version mapping, and when WebGPU actually became free

**[VERIFIED]** From [releases.electronjs.org/schedule](https://releases.electronjs.org/schedule)
(accessed 2026-07-27):

| Electron | Chromium | Stable |
| --- | --- | --- |
| 24 | M112 | 2023-04-04 |
| **25** | **M114** | **2023-05-30** |
| 40 | M144 | 2026-01-13 |
| 41 | M146 | 2026-03-10 |
| **43** | **M150** | **2026-06-30** ← ours |
| 45 | M156 | 2026-10-20 |

Chrome shipped WebGPU in **113** — "available on ChromeOS, macOS, and Windows… Windows devices
with **Direct3D 12** support" ([developer.chrome.com/blog/webgpu-release](https://developer.chrome.com/blog/webgpu-release),
updated 2023-04-06). **[INFERRED]** Electron **25** (M114) is therefore the first Electron major
with WebGPU on by default on Windows/D3D12. The schedule table independently confirms my local
measurement that Electron 43 = Chromium 150.

**[VERIFIED]** There was never an Electron-specific WebGPU gate — the persistent rumour is
wrong. Electron maintainer nornagon, closing [electron#26944](https://github.com/electron/electron/issues/26944)
on 2021-04-01: *"there's nothing to do from our end. Either it works in Chromium or it doesn't.
**We don't do anything special to disallow or allow this feature.**"* The flag era was the
pre-113 origin-trial period, which applied to Chrome equally. Corroborated by
[electron#41763](https://github.com/electron/electron/issues/41763) (maintainer, 2024-04-11:
*"this feature has now been enabled by default"*).

**[VERIFIED]** Dawn's own support matrix names **D3D12 on Windows as the fully-supported,
preferred backend** ([dawn.googlesource.com/dawn/+/HEAD/docs/support.md](https://dawn.googlesource.com/dawn/+/HEAD/docs/support.md),
accessed 2026-07-27). Vulkan-on-Windows is "best effort"; the D3D11 backend is not production
ready. We are on the good path.

### 2.3 Shipping vehicle — Electron, and the evidence for it

**[VERIFIED]** Real web-tech games ship on Steam through three vehicles — Electron, NW.js, and
WebView2/CEF — with no single industry standard:

- **shapez** (shapez.io) — open-source Electron wrapper with `steam.js` / greenworks in
  [`electron/package.json`](https://github.com/tobspr-games/shapez.io/blob/main/electron/package.json),
  launched with `--disable-direct-composition --in-process-gpu` (repo pushed 2026-04-28).
- **Desktop Heroes** (Telazer, Steam release Oct 2025) — Phaser + Electron
  ([phaser.io](https://phaser.io/news/2026/04/desktop-heroes-phaser-electron-steam), 2026-05-08).
  Their verdict: *"There's no official JavaScript SDK for Steam"* — they wrote custom glue.
- **Game Dev Tycoon**, **CrossCode**, **The Curious Expedition**, **Screeps** — NW.js
  ([greenworks users wiki](https://github.com/greenheartgames/greenworks/wiki/Apps-games-using-greenworks),
  [NW.js apps list](https://github.com/nwjs/nw.js/wiki/List-of-apps-and-companies-using-nw.js)).
- **Wayward**, **CasinoRPG**, **Dull Grey**, **Along the Edge** — Electron (same greenworks wiki).
- **Moonstone Island**, **Astral Ascent**, **Pepper Grinder**, **Mosa Lina**, and (per Scirra's
  attribution) **Vampire Survivors**' original Steam release on Phaser — named in Scirra's
  Steam suggestion thread ([steamcommunity.com](https://steamcommunity.com/discussions/forum/10/591756872987476379/),
  2024-12-06). **[UNVERIFIED]** which wrapper Vampire Survivors used.
- **Construct 3**, a commercial engine, ships Steam integration for **WebView2 (Windows),
  WKWebView (macOS) and CEF (Linux)** ([Scirra/Construct-Plugin-Steamworks](https://github.com/Scirra/Construct-Plugin-Steamworks),
  pushed 2026-05-19) — so WebView2 and CEF are proven shipping targets too.

**[VERIFIED]** Two sources argue *against* naive optimism, and both deserve quoting.
Electron's own docs, [why-electron.md](https://github.com/electron/electron/blob/main/docs/why-electron.md)
(accessed 2026-07-27), under "When not to use Electron": *"**Games and Real-Time Graphics:** …
native frameworks like Unity, Unreal Engine, or DirectX/OpenGL will provide better
performance."* And a Construct developer shipping on Steam, 2025-06-04
([Construct-bugs#8625](https://github.com/Scirra/Construct-bugs/issues/8625)): *"I have to skip
both WV2 and CEF for my steam game as they have a multitude of issues. (steam input, steam
overlay, screen recording, no sound in steam remote play together, dual GPU systems using
integrated gpu…)… I am basically forced to use NWjs."*

**[INFERRED]** Electron remains the right choice here, for one reason above all: **it pins
Chromium into your depot.** WebView2 is Evergreen — Microsoft updates the engine under your
hand-written WGSL renderer and hand-written GGUF kernels, on the player's machine, after you
ship. For a project whose entire correctness surface is "does this exact Dawn/D3D12 build run
my shaders", that is an unacceptable trade for ~250 MB. Tauri's own maintainer agrees for this
use case: asked in [tauri#6381](https://github.com/tauri-apps/tauri/issues/6381) whether
Electron is better "for WebGPU across OS", FabianLars answered **"yes."** (2025-02-28).

### 2.4 The Steam overlay — the known blocker, and a measurement that unblocks it

**[VERIFIED]** Valve documents the incompatibility explicitly
([partner.steamgames.com/doc/features/overlay](https://partner.steamgames.com/doc/features/overlay),
accessed 2026-07-27):

> "**The Steam Overlay requires a game consistently render frames, not pausing rendering or
> rendering only part of the screen based on dirty rects. Unfortunately, web browsers do not
> support this model.**"

Plus: you must call `SteamAPI_Init` *before* the D3D/GL device is created, "otherwise it won't
be able to hook the device creation" — which a normal Chromium cannot satisfy, because the
device is created in a separate GPU process.

**The known workaround** is `--in-process-gpu` (collapsing the GPU process into the browser
process so the hook can see the device) plus `--disable-direct-composition`, plus forcing a
repaint every frame. This is exactly what shipped games do — shapez's launch line above — and
what `steamworks.js` does automatically in `electronEnableSteamOverlay()`: append both switches
and `setInterval(() => webContents.invalidate(), 1000/60)`.

**The open question everyone flagged and nobody had answered: does WebGPU still work under
`--in-process-gpu`?** No source states either way. It matters enormously — if the answer were
no, the choice would be "Steam overlay *or* your renderer," and the renderer would win, costing
you screenshots, Shift-Tab, and (per §3.3) the Deck on-screen keyboard.

**[MEASURED-HERE] The answer is yes.** Electron 43.2.0 with
`--in-process-gpu --disable-direct-composition`:

```
navigator.gpu = object
ADAPTER_OK  vendor=amd  arch=rdna-2
LIMITS      maxBufferMB=2048  maxStorageBuffersPerStage=16
DEVICE      ok
FEATURES    … timestamp-query, shader-f16, subgroups, dual-source-blending …
app.getGPUFeatureStatus() → "webgpu": "enabled"
```

Adapter acquired, device created, `timestamp-query` (the one optional feature the engine uses)
still present. **The overlay flags and WebGPU coexist on this machine.** That closes what was
the highest-risk unknown in Tier 1.

**[INFERRED]** What `--in-process-gpu` still costs, and what to budget for:

- **A GPU/driver crash now kills the whole app** instead of being recovered by Chromium's
  process isolation. For a game already running heavy compute, this is a real robustness
  regression — the existing `device.lost` handler (`gpu-device.ts:141`) becomes more important,
  not less.
- `--disable-direct-composition` loses the zero-copy presentation path; expect some
  presentation cost. Measure frame time with and without.
- The 60 Hz forced `invalidate()` is pure overhead for a game that already paints every frame —
  `steamworks.js` lets you disable it, and you should.
- **[VERIFIED]** `--in-process-gpu` is an *undocumented* Chromium switch — Electron's
  [command-line-switches](https://www.electronjs.org/docs/latest/api/command-line-switches) doc
  does not list it, and there is a Chromium bug titled "--in-process-gpu no longer works"
  ([issues.chromium.org/issues/40636773](https://issues.chromium.org/issues/40636773); body
  auth-gated, **status unverified**). It works on Chromium 150 today; it is not contractual.

**[VERIFIED]** What you lose if the overlay ultimately does not attach: **screenshots are a
documented hard dependency** — *"The Steam Overlay must be active in your game for the
Screenshots system to be available"*
([partner.steamgames.com/doc/features/screenshots](https://partner.steamgames.com/doc/features/screenshots))
— so F12 does nothing. Plus Shift-Tab (friends, chat, browser, invites) and any in-game
`overlay.activateDialog()` buttons.

**[VERIFIED]** The problem is unowned. Scirra's Dec-2024 thread asking Valve for web-runtime
overlay support ran to 64 comments with **no Valve reply**. Electron's maintainers declined:
*"I don't think you'll receive much support from maintainers… it is a niche use case… I'd
suggest reaching out to Steam"* ([electron#47662](https://github.com/electron/electron/issues/47662),
2025-07-04 — which was itself an overlay failure **on SteamOS/Steam Deck** with Electron 35).
`steamworks.js` has overlay issues open from 2022 through 2025-07-12 (#195), where a reporter
tried every documented workaround and none worked on Linux.

**Avoid one "solution".** `steamworks-ffi-node` works around the overlay by `capturePage()`-ing
the Electron window at 60 fps and pushing frames into a separate native GL window that Steam
can hook. For a 60 fps 3D WebGPU game that is a full framebuffer readback and re-upload every
frame — **[INFERRED]** almost certainly disqualifying on performance. Do not adopt it for this.

### 2.5 ⚠️ Steam Input and Chromium gamepads — the risk that spans Tier 1 and Tier 2

This is the most under-appreciated finding in the report, and it lands directly on the
gamepad work item that both Steam and the Deck depend on.

**[VERIFIED]** [electron#45989](https://github.com/electron/electron/issues/45989), "Gamepad not
detected when using Steam Input" (opened 2025-03-12, Electron 35.0.1, Win11): last known
working version **Electron 26.6.10**, with a public reproduction repo. Cross-confirmed on Deck
hardware by a Construct developer ([Construct-bugs#8625](https://github.com/Scirra/Construct-bugs/issues/8625),
2025-06-04): *"Steaminput is broken with chromium 114+… **no gamepads work at all — not even the
steamdeck's own buttons** … works fine with Chromium v113 (NWjs 0.76 and Electron 25)."*

Electron maintainers again declined it as a niche use case; the issue was closed 2025-09-21 and
**[UNVERIFIED]** whether by a fix or by staleness. Scirra's Ashley, 2025-06-10:
*"Electron/CEF/NW.js/WebView2 are in the same position as us really"* — i.e. this needs Valve
or Google, not a wrapper vendor.

**[INFERRED]** Read this against §1.3 (we have no gamepad code at all) and §3.2 (Deck Verified
requires full controller support). The plan "add Gamepad API support and let Steam Input map
it" may be broken on every Chromium after 113 — including our 150. **[MUST-TEST]** This is
not something I can settle without a controller and a running Steam client, and it is the
single most important thing to test early, because if the Gamepad API is dead under Steam
Input you need a different input path entirely (e.g. reading Steam Input actions natively
through `steamworks.js` in the main process and forwarding them over IPC, bypassing the
browser's Gamepad API). That is a design decision, not a bug fix, and you want to make it in
week one.

### 2.6 Steamworks libraries

**[VERIFIED]**, as of July 2026:

| Library | Status | Notes |
| --- | --- | --- |
| [`steamworks.js`](https://github.com/ceifa/steamworks.js) | Repo active (last push 2026-04-08, 620★) but **npm `latest` is 0.4.0 from 2024-08-06** | **Install from git, not npm.** Covers achievements, stats, cloud, full Steam Input, overlay activation, workshop, matchmaking, auth, `isSteamRunningOnSteamDeck`, gamepad text input. Needs `contextIsolation: false, nodeIntegration: true` to call from the renderer. |
| [`greenworks`](https://github.com/greenheartgames/greenworks) | **Not dead** — v0.22.0 tagged 2025-09-20, SDK v1.62, last commit 2025-11-23 | README: maintained "on a **best-effort basis**… active development is not a priority." The widespread "greenworks is abandoned" claim (repeated in steamworks.js's own README) is out of date. |
| [`steamworks-ffi-node`](https://github.com/ArtyProf/steamworks-ffi-node) | Newest and most active (created 2025-10-10, last commit 2026-06-22), SDK v1.64, Koffi FFI so no C++ build | Names 7 shipped Steam games. **Ignore its capture-based overlay module** (§2.4). |

`steamworks.js` exposes the on-screen-keyboard call this project needs for the Deck (§3.3), so
it is the natural default — installed from git.

### 2.7 Depot and the 1.1 GB of weights

`docs/AI_MODEL_LICENSING.md` §6 already covers this well and I will not repeat it. The short
version of what it establishes, which I have no reason to contradict:

- Steam documents no maximum depot or build size; the circulating 2 GB figure applies to the
  browser-based upload in the partner site, not SteamPipe.
- Apache-2.0 explicitly permits redistribution in object form. Bundling weights in the depot is
  the recommended course, and runtime-fetching HuggingFace is the thing to stop doing.
- Attribution obligations are Apache-2.0 §4: licence copy, retain notices, no NOTICE file
  exists upstream.

What this report adds is the **engineering** consequence, from §1.5: bundling the weights is
not just a build-script change, because the loader speaks HTTP Range. Budget real time for the
protocol handler, and test that it returns **206**.

**Correcting one assumption in the brief.** The brief says shipping weights in the depot is
required because Steam has "rules/expectations" about games downloading large third-party
content at first run. **[UNVERIFIED]** No such rule appears in Valve's published documentation.
The onboarding rules, depot docs, SteamPipe docs, build docs, install-script docs and review-process
docs were all checked and **none** prohibits, restricts or even mentions post-install downloads
of game content from third-party servers. The Steam Distribution Agreement is login-gated and
could not be read, so the possibility cannot be excluded — but as of today this is a documented
*absence*, not a documented rule, and the report should not assert otherwise.

**[VERIFIED]** There is even a direct precedent going the other way:
[**AI Roguelite**](https://store.steampowered.com/app/1889620/) (released 2023-10-25) ships a
small depot and states system requirements of "GPU capable of running local models OR basic
internet connection", storage "minimum 2 GB, recommended 15 GB" — i.e. the local model weights
are explicitly *not* in the depot. It carries a Steam AI disclosure and has remained on sale
since 2023. A game that runs local LLMs with out-of-depot weights has shipped and stayed
shipped.

**[INFERRED]** Bundle anyway, for four reasons that are stronger than the imagined rule:
Valve's review process does require the build to "start up properly" on a reviewer's machine of
unknown network quality; HuggingFace is a third-party availability dependency you do not
control (a repo rename breaks your shipped game); 1.1 GB is trivial by Steam standards; and on
Xbox it is affirmatively disallowed — Store Policy §10.2.5 requires products on Xbox consoles
to be "installed and updated only through the Microsoft Store". Bundling now is the portable
choice.

### 2.8 ⚠️ The real Steam gate is the AI Content Survey, not the depot

**[VERIFIED]** Valve's mandatory
[Content Survey](https://partner.steamgames.com/doc/gettingstarted/contentsurvey) (accessed
2026-07-27) has a Generative AI section splitting **Pre-Generated** from **Live-Generated**.
For Live-Generated, Valve requires you to describe *"guardrails you're putting on your AI to
ensure it's not generating illegal content"* — which `docs/AI_GUARDRAILS.md` and
`npc/content-safety.ts` are already written to answer, and answer well.

**One hard prohibition to be aware of:** Valve states verbatim that *"the legal and customer
risks are substantial enough that we don't want to ship **Live-Generated AI Adult Only Sexual
Content** at this time."* Live-generated non-sexual NPC dialogue is not prohibited.

**[VERIFIED]** Two pieces of context that make this less alarming than it reads. First, Valve
added an **in-overlay player-reporting tool** for suspected illegal live-generated content — so
the reporting mechanism Microsoft requires you to build (§4.5) is, on Steam, partly Valve's.
Second, disclosing AI is now thoroughly ordinary: **17,250+ Steam titles carried an AI
disclosure as of 2026-07-13**, up from ~7,800 in early 2025. You would not be an outlier. The
policy framework itself has not changed since Valve's 2024-01-10 announcement; claims of a 2026
"two-tier overhaul" could not be corroborated and appear to be false.

**[INFERRED]** This is worth a careful read against the game's design intent (§4.4 quotes it:
NPCs are meant to discuss "dark, crude, violent, grieving, blasphemous and sexual subjects like
adults"). The prohibition is on the *Adult Only sexual content* category — the AO tier — not on
mature content generally, and Steam publishes a great deal of mature material. **[INFERRED]** a
system-prompt-driven mature-but-not-pornographic tone with the existing illegal-content filter
is very likely fine; a build that a reviewer could steer into generating AO sexual content is
not. This is the one place where the shipped model choice matters commercially as well as
legally: stock Qwen3-1.7B retains trained refusal underneath the rule list, and the
`?npcllm=abliterated` path removes exactly that (§7).

### 2.9 Tier 1 work items

| # | Item | Notes |
| --- | --- | --- |
| 1 | **Input, and decide the path early** | Nothing exists (§1.3). But see §2.5 — the browser Gamepad API may be broken under Steam Input on Chromium 114+. Test before designing. |
| 2 | **Offline weights** | Custom protocol or loopback server with **honest Range/206** support (§1.5). |
| 3 | **Steamworks integration** | `steamworks.js` **from git, not npm** (§2.6). |
| 4 | **Overlay** | Ship with `--in-process-gpu --disable-direct-composition`; WebGPU survives them **[MEASURED-HERE]**. Disable the 60 Hz forced invalidate. Re-measure frame time. |
| 5 | **Add `--force-high-performance-gpu`** | On dual-GPU laptops Chromium ignores `powerPreference` and runs on the iGPU — a documented cause of "poor reviews from players". Fixed in Chromium 145+, so Electron 41+; we are on 43. |
| 6 | **Drop non-game chunks** | ONNX runtime (21 MB), eSpeak/TTS (GPL-3.0), service worker. Reduces size *and* licence surface. |
| 7 | **AI Content Survey answer** | §2.8. Largely already written in `docs/AI_GUARDRAILS.md`. |
| 8 | **Graphics settings** | Not needed for Windows, but see §3.4 — you will need it for the Deck, and retrofitting later is worse. |

---

## 3. Tier 2 — Steam Deck

**Verdict: "Playable" is plausible; "Verified" is not close today — and the hardest problem is
not performance tuning, it is that WebGPU's single queue makes generate-while-playing
structurally impossible on a 15 W part.**

**Four** independent problems, addressed in §3.1–§3.5. Any one of them is enough to miss
Verified; they need different teams and different weeks, so they do not overlap. In rough order
of how much they cost to fix:

1. **§3.1** — WebGPU may not initialise at all on Deck's AMD GPU. A driver/rollout question.
2. **§3.2** — five failed Verified criteria. Input, glyphs, text entry, legibility, seamlessness.
3. **§3.4** — rendering is an extrapolated 10–19 fps against a 30 fps bar, and the game has no
   graphics-settings system to turn down.
4. **§3.5** — **the deep one.** Dialogue generation and rendering cannot share the GPU
   concurrently. This is a gameplay-architecture change, not an optimisation.

### 3.1 Problem one — WebGPU on Linux for AMD may simply not be enabled

This is the finding that most changes the plan, and it is the one I would chase first.

**[VERIFIED]** Chrome's own WebGPU release notes for **Chrome 144, published 7 January 2026**:

> "The Chrome team is carefully rolling out WebGPU for Linux, starting with support for **Intel
> Gen12+ GPUs** but with a tentative plan to expand it to more devices (AMD, NVIDIA). This
> implementation uses an architecture where WebGPU uses Vulkan and the rest of Chromium stays
> on OpenGL, exercising existing well known good code paths."

— [developer.chrome.com/blog/new-in-webgpu-144](https://developer.chrome.com/blog/new-in-webgpu-144), 2026-01-07.

**The Steam Deck is AMD RDNA2.** As of that announcement, AMD on Linux was explicitly *not* in
the rollout — it was a "tentative plan".

**And it still is not, six months and three Chrome releases later.** **[VERIFIED]** Tracing the
subsequent WebGPU release notes:

| Chrome | Date | Linux WebGPU status |
| --- | --- | --- |
| 144 | 2026-01-07 | Rollout begins — **Intel Gen12+ only**; AMD/NVIDIA a "tentative plan" |
| [147–148](https://developer.chrome.com/blog/new-in-webgpu-147-148) | 2026-04-22 | "support is expanding to include modern **NVIDIA** drivers (2024-05) on Wayland" |
| [149–150](https://developer.chrome.com/blog/new-in-webgpu-149-150) | 2026-06-17 | **No AMD-on-Linux support mentioned** |

**[INFERRED]** Chromium **150 is exactly the version inside our Electron 43.2.0**
**[MEASURED-HERE]**. So on the current evidence, **the one GPU vendor still missing from
Chromium's Linux WebGPU rollout is the one the Steam Deck uses.** NVIDIA got added; AMD has not
been announced. That is not silence — it is three consecutive release notes that mention Linux
GPU vendors and do not mention AMD.

**[MUST-TEST]** This is not the same as proving `requestAdapter()` returns null on a Deck. A
staged rollout can be forced with flags (`--enable-unsafe-webgpu`, `--enable-features=Vulkan`),
SteamOS ships a mature Mesa/RADV Vulkan driver, and Chrome's own troubleshooting page still
lists "enable experimental flags for Linux/Vulkan" as the remedy for a null adapter. It is
entirely plausible that flags make it work. But **shipping a game on an explicitly-not-yet-rolled-out
driver path, forced on with an "unsafe" flag, is a materially different risk posture** from
shipping on Windows where it is default-on and I have measured it working.

**[INFERRED]** The consequences fork sharply:

- **If flags make it work on RADV**: a native Linux Electron build is the path, and §3.2/§3.4
  become the whole problem. **[VERIFIED]** Electron controls its own command line, so unlike a
  browser you are not waiting on a rollout — and the flag recipe is proven to work on AMD
  RDNA2 iGPUs on Linux generally, if not on a Deck specifically.
- **If nothing makes it work**: the fallback would be shipping the *Windows* build under Proton
  — and that route looks like a **dead end**, for a reason unrelated to WebGPU. **[VERIFIED]**
  the Gamepad API is broken Deck-specifically under Proton (Proton issue #8154, still open),
  WebGPU-via-vkd3d-proton is entirely unevidenced, and you cannot force Proton if a Linux depot
  exists. Valve's own criteria warn that blocking Proton issues earn an *Unsupported* badge
  (§3.2).

**[VERIFIED]** Two more data points that sharpen the risk. MDN's browser-compat data (updated
2026-07-10) records Chrome WebGPU on Linux as **"Intel Gen12+ GPUs only"**, and Firefox 141 as
partial with *"Does not support Linux"* — so this is not a Chrome-only gap. And a field report
from December 2025 ([bevy#22044](https://github.com/bevyengine/bevy/issues/22044)) describes
Linux + AMD RDNA2 iGPU under stock Chrome returning **a blank adapter or silently falling back
to SwiftShader**; flags made it run, but badly.

**[INFERRED]** The silent SwiftShader fallback is the detail to design against. A software
rasteriser will "work" — it will initialise, render, and produce a correct image at
single-digit frame rates — which means a naïve Deck test could come back green and be
completely misleading. **Any Deck bring-up must assert `adapter.info` shows a real AMD device,
not just that `requestAdapter()` returned something.**

This unknown is worth an afternoon and a Deck. See §6.2.

### 3.2 Problem two — the game fails five Verified criteria today

Valve's compatibility review criteria, quoted from
[partner.steamgames.com/doc/steamdeck/compat](https://partner.steamgames.com/doc/steamdeck/compat)
(accessed 2026-07-27). Each row pairs the rule with the measured state of this codebase.

| Criterion | Valve's requirement (verbatim) | This game today | Status |
| --- | --- | --- | --- |
| **Controller** | "your game must support Steam Deck's physical controls… The default controller configuration must provide users with the ability to access all content… Players must not need to adjust any in-game settings in order to enable controller support" | Zero Gamepad API usage (§1.3) — **and the obvious fix may not work**, see §2.5: a Construct dev reports that under Steam Input on Chromium 114+ "no gamepads work at all — not even the steamdeck's own buttons" | **Fails Verified**, and the remedy is itself at risk. |
| **Glyphs** | "On-screen glyphs must match the inputs being used… Mouse and keyboard glyphs should not be shown if they are not the active input." Recommends the Steam Input API for automatic glyphs. | Keyboard prompts only, hard-coded | **Fails Verified.** |
| **Text input** | "if your game requires text input… you must **either** use a Steamworks API for text entry to open the on-screen keyboard for players using a controller, **or** have your own built-in entry that allows users to enter text in their language using only a controller." | Free-text NPC chat via DOM `<input>` (§1.4), no OSK call | **Fails Verified.** |
| **Text legibility** | "the smallest on-screen font character should never fall below **9 pixels in height** at 1280x800… We recommend aiming for 12px whenever possible." | 5 declarations at **10px**, 12 at **11px** across `ui/*.ts` | **Likely fails** — see below. |
| **Default config performance** | "the game must ship with a default configuration that results in a playable framerate. On Steam Deck, this is **30fps at 800p**" | Extrapolated 10–19 fps (§3.4) | **Fails Verified.** |
| **Seamlessness** | "the app must not present the user with information that the Deck/Machine software… or hardware… is unsupported." | `gpu-device.ts:86` throws *"WebGPU is not supported in this browser. Use Chrome 113+ or Edge 113+."* | **Fails if WebGPU init fails** — and §3.1 makes that a live possibility. |
| **Launcher** | "we recommend strongly against requiring the user to navigate a launcher" | None planned | Pass |

On legibility: Valve's "9 pixels in height" refers to rendered *character* height, not CSS
`font-size`. For a typical sans-serif, cap height ≈ 0.7 em, so `font-size: 10px` yields roughly
a 7 px capital and a ~5 px x-height. **[INFERRED]** the 10px and 11px declarations are below
the floor and the 12px ones sit exactly at Valve's recommendation. **[MUST-TEST]** measure
rendered glyph height on-device rather than trusting my ratio. Either way the fix is the same:
a UI scale factor, which the codebase has no concept of today.

Note the seamlessness row carefully — it is a nasty interaction. The game's honest error
message ("WebGPU is not supported… use Chrome 113+") is exactly the class of message Valve
prohibits, and §3.1 means it is the message a Deck user would actually see if the AMD-Linux
question resolves badly. The fix is not to hide the failure but to not *have* the failure.

### 3.3 The on-screen keyboard — and why it is coupled to the Steam overlay

Steam has the right API for this, and the game's DOM `<input>` (§1.4) is the right shape to
receive it.

**[VERIFIED]**, from [partner.steamgames.com/doc/api/ISteamUtils](https://partner.steamgames.com/doc/api/ISteamUtils)
(accessed 2026-07-27):

- `ShowFloatingGamepadTextInput(eKeyboardMode, nTextFieldXPosition, nTextFieldYPosition,
  nTextFieldWidth, nTextFieldHeight)` — "Opens a floating keyboard over the game content and
  **sends OS keyboard keys directly to the game**." The text-field rectangle is given "in
  pixels relative the origin of the game window and is used to position the floating keyboard
  in a way that doesn't cover the text field." Callback: `FloatingGamepadTextInputDismissed_t`.
- `ShowGamepadTextInput(...)` — "Activates the **Big Picture text input dialog**", a modal
  whose result you retrieve afterwards via `GetEnteredGamepadTextInput()`. Returns `false` if
  the Big Picture overlay is not running.

**The floating variant is the one we want**: it types into whatever has focus, which is our
`<input>`, and it is documented as intended for games that render their own text field.

**[VERIFIED]** Both APIs "require Big Picture overlay to be running and enabled."

**[INFERRED] — and this is the non-obvious risk in the whole Deck tier:** the overlay is a
documented problem for browser-based games (§2.4 — Valve's own words: *"web browsers do not
support this model"*). If the overlay does not attach to our Electron window, then **the
on-screen keyboard does not work either** — and free-text NPC dialogue is not a nice-to-have
here, it is the product. The "cosmetic" overlay bug and the Verified-blocking text-input
requirement are **the same bug**.

The news is better than it was when I first wrote this section. §2.4 establishes that the
standard overlay workaround (`--in-process-gpu --disable-direct-composition`) is what shipped
games use, and **[MEASURED-HERE]** that WebGPU keeps working under those flags. So the
mitigation is available and does not cost us the renderer.

Better still, the floating OSK specifically is **reported to work**: **[VERIFIED]**
`ShowFloatingGamepadTextInput` has been observed delivering keystrokes into a Chromium `<input>`
on real Deck hardware. Combined with §1.4 (our chat field *is* a real DOM `<input>`), the
mechanism is sound. **[INFERRED]** the two OSK APIs also differ in their overlay dependency:
`ShowGamepadTextInput` is the Big Picture *modal* and plainly needs the overlay, whereas the
*floating* variant sends OS-level keys — so it is the more likely of the two to survive a
partly-broken overlay. Call `ShowFloatingGamepadTextInput` on `focusin` of the chat field.

What remains **[MUST-TEST]** is whether the overlay attaches on a Deck at all, and whether the
floating OSK works when it does not. There is a specific reason not to assume:
[electron#47662](https://github.com/electron/electron/issues/47662) (2025-07-04) reports the
Steam overlay on **SteamOS/Steam Deck** with Electron 35 flashing and then disappearing,
"remains disabled until a full system reboot", last known good Electron 34; the issue was closed
2025-08-04 for lack of information, not fixed. Deck overlay behaviour is its own case and needs
its own test.

**[INFERRED]** Note also which criterion is actually hardest here. Controller *support* is
largely solved by a Steam Input default configuration mapping the Deck's controls to the
keyboard and mouse the game already reads. **Glyphs are the harder problem**: Valve requires
on-screen prompts to match the active input device, our prompts are hard-coded keyboard text,
and the cheap Steam Input path gives you no handles to query which device is live. Budget the
glyph work separately from the input work.

### 3.4 Problem three — performance, and the arithmetic that says 30 fps is not close

**[INFERRED]** From the reported dev-machine figure of **60 fps with castle-scene p95 ≈ 11 ms at
1280×720** on the RX 6700 XT, scaled by the §1.7 ratios:

```
Pixel ratio       1280×800 / 1280×720            = 1.11×
Compute-bound     11 ms × 8.2 × 1.11             ≈ 100 ms/frame  ≈ 10 fps
Bandwidth-bound   11 ms × 4.4 × 1.11             ≈  54 ms/frame  ≈ 19 fps
Deck OLED (BW)    11 ms × 3.75 × 1.11            ≈  46 ms/frame  ≈ 22 fps
```

Real frame time lands between the two bounds. **Even the optimistic bandwidth-bound estimate
is ~19 fps against Valve's 30 fps @ 800p requirement — and that is before the LLM takes a
single millisecond of GPU time.** To reach 30 fps needs a 1.6–3× reduction; 60 fps needs 3–6×.

This is not a catastrophe — it is a normal console-settings pass — but the codebase has
**nothing to pass with**:

- `renderer.ts:193` fixes render resolution at `Math.min(window.devicePixelRatio || 1, 2)`.
  **There is no render-scale setting.**
- Three shadow cascades are unconditional (`renderer.ts:5`, `:631`).
- The post chain — SSAO, bloom, godrays, FXAA, composite (`src/game/shaders/`) — has no
  quality tiers.
- A repo-wide grep for `renderScale`, `resolutionScale`, quality presets or `LOW`/`MEDIUM`
  found nothing.

**[INFERRED]** Deck work item: build a graphics-settings layer (internal render scale with
upscale-to-native, cascade count, post-effect toggles, grass density) *before* trying to hit
30 fps. Doing it in the Windows tier is cheaper than retrofitting.

### 3.5 The LLM on the Deck — and the finding that reframes the whole tier

There is real measured data for Deck-class LLM inference, and one structural fact about WebGPU
that matters more than any of the arithmetic.

**The structural fact: WebGPU v1 exposes exactly one queue.** **[VERIFIED]** A Steam Deck
`vulkaninfo` dump (RADV VANGOGH, Mesa 24.1-devel, published by a llama.cpp maintainer,
2025-04-22) shows Van Gogh exposing 1 graphics+compute queue **plus 4 dedicated async-compute
queues**. But WebGPU v1 gives you a single `GPUDevice.queue`; multi-queue was deferred out of
the spec. **[INFERRED]** So the hardware mechanism that would let LLM compute soak idle ALU
behind a raster-bound frame is **unreachable from WebGPU**. The renderer and the LLM timeshare
one queue, serially. **That — not memory bandwidth — is the primary contention mechanism**, and
it is a property of the API, not of the Deck.

**The measured baseline.** **[VERIFIED]** The one published Steam Deck llama.cpp Vulkan
benchmark ([llama.cpp discussion #10879](https://github.com/ggml-org/llama.cpp/discussions/10879),
2025-04-22):

```
RADV VANGOGH | uma: 1 | fp16: 1 | int dot: 0 | matrix cores: none
gemma3 4B Q4_0 (2.93 GiB):  pp512 156.14 t/s  |  tg128 18.39 t/s
```

Note `int dot: 0` and `matrix cores: none` — **Van Gogh has neither integer dot-product nor
cooperative-matrix instructions**, which is exactly why its prefill is weak, and that applies
equally to WGSL. Scaling the measured 18.39 tok/s to our smaller model: 18.39 × (3.146/1.1)
≈ 53 tok/s, discounted for Q4_K_M dequant cost → **[INFERRED] ~35–50 tok/s native decode**.
Through a WebGPU stack (dispatch overhead measured at 24–36 µs on Vulkan; ~400–450 dispatches
per token for 28 non-fused layers) → **[INFERRED] 8–25 tok/s decode, LLM alone**.

**Now combine it with the single queue, and the picture changes.** **[INFERRED]** At ~20 tok/s,
one decode step takes ~50 ms — *longer than an entire 33 ms frame*. Holding 30 fps leaves only
~2–4 ms per frame for LLM work, so each token's dispatches slice across 15–25 frames:

```
Effective generation while holding 30 fps:  ~1.2–2 tok/s
A 60-token NPC line:                        30–50 seconds
```

Against the project's **20 s watchdog** (`game/main.ts:2135`), **every NPC conversation on a
Deck would fall back to canned replies while the player is moving.** The game would boot, run,
and silently stop being the thing it is — worse than a crash, because it passes QA.

**The power budget compounds it.** **[VERIFIED]** A field measurement of LLM inference on a Deck
found *"The Deck's GPU uses around 10-11W when generating responses"* — out of a 15 W APU
budget shared zero-sum between CPU and GPU. **[INFERRED]** so while generating, the renderer is
running on a ~4–5 W remainder with the GPU pushed toward its 1.0 GHz floor (a 37.5% compute
haircut from the 1.6 GHz boost figure §3.4 assumes). **The LLM does not merely steal queue
time; it structurally downclocks the renderer while active.**

**[INFERRED] The conclusion is a design conclusion, not a tuning one: concurrent
generate-while-playing is not viable on the Deck.** No amount of kernel optimisation fixes a
single-queue API on a 15 W part. What fixes it is decoupling generation from the render loop —
generate during a dialogue overlay or pause, pre-generate during travel or loading — plus
chunking dispatches to stay clear of the GPU-process watchdog. That is a gameplay-architecture
change and it should be costed as one.

**One correction to this project's own baseline, and it is embarrassing in a useful way.**
**[INFERRED]** The dev machine's reported **68–100 tok/s prefill is *slower than llama.cpp's
prefill on a Steam Deck*** (156 tok/s pp512, on a model 2.3× larger, on hardware 8× weaker).
A gap that size is not a hardware story. It strongly suggests the engine's prefill processes
the prompt token-by-token as matrix-vector products instead of batching it into matrix-matrix
multiplies. If so, **the largest available win in this entire report is on the dev machine
today, in `src/engine/forward-pass.ts`** — and fixing it improves the Deck extrapolation
substantially, because batched prefill is FLOP-bound rather than dispatch-bound. I have raised
this from "hypothesis" to "well-supported" on the strength of the comparison, but it is still an
inference from two numbers, and the way to settle it is to profile a prefill on the desktop.

**[MUST-TEST]** Everything in §3.4 and §3.5 is arithmetic on measured inputs, not a benchmark of
*this* engine on *this* hardware. See §6.2.

### 3.6 Power, thermals and battery

**[VERIFIED]** The Deck's 15 W ceiling is an **APU** budget — CPU and GPU are zero-sum on one
die. Valve's own guidance: *"In order to increase the CPU more, it's necessary to decrease the
GPU, and vice versa."* GPU clock is a **1.0–1.6 GHz range**, with 1.6 the boost figure Valve
quotes. There is no plugged-in escape hatch: Valve's FAQ states performance is *"the same across
the board"* on AC versus battery.

**[INFERRED]** §3.4's frame-time estimates assume the 1.6 GHz boost clock, so they are
**optimistic, not pessimistic** — under the sustained combined load of renderer plus LLM the
part will sit nearer 1.0 GHz, i.e. ~1.0 TFLOPS.

**[VERIFIED]** Battery is **not** a Deck Verified criterion — the word appears once on Valve's
compatibility page, incidentally, and nowhere in the checklist. **[INFERRED]** at the measured
20–25 W system draw under combined load, runtime would be roughly **1.5–1.8 h (LCD)** and
**1.9–2.3 h (OLED)** — at or below the bottom of Valve's published ranges. Not a certification
problem; a review-score problem.

**[VERIFIED]** Valve's own recommendations doc advises targeting **Vulkan** as the primary API
"for best performance and battery life" and implementing an FPS limiter. Both point the same
way as §3.4's graphics-settings work item.

---

## 4. Tier 3 — Xbox

**Verdict: no supported browser-runtime path, a months-long native rebuild if you want it
anyway, and — the part that actually decides it — a content policy the game is currently
designed to conflict with.**

### 4.1 Is there a browser-runtime path?

**[VERIFIED]** WebView2 *is* documented as supported on Xbox. From
[learn.microsoft.com/microsoft-edge/webview2/](https://learn.microsoft.com/en-us/microsoft-edge/webview2/)
(page updated 2026-06-12):

> "In addition to Windows devices, WebView2 is also supported on the following devices:
> - Xbox
> - HoloLens 2"

Existence is not a path, and the follow-up question settles it. **[VERIFIED]** WebView2 is Edge
Chromium, Edge Chromium's WebGPU is Dawn, and **Dawn does not support Xbox D3D12** (§4.2). This
has been tested and filed: **Ashley Gullen of Scirra** — who had every commercial reason to want
it to work, having just built Construct 3's Xbox export — reported on 2023-11-07 that on Xbox
the WebGPU API surface appears present but **no adapter is available**
([WebView2Feedback discussion #4138](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/4138)),
escalated to [feature request #4150](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4150)
on 2023-11-09. As of July 2026 that request is **still open, labelled "feature request", with no
Microsoft commitment or timeline.**

**[INFERRED]** So the chain is complete and negative: **WebView2 exists on Xbox, but there is no
WebGPU underneath it, because the implementation it would use has no Xbox backend.** For a game
with no WebGL fallback and no intention of building one, that closes the browser-runtime route
on Xbox — not on a prior, but on the same document that grades Dawn's desktop backends.

**[UNVERIFIED]** I could not reach the GDK-specific WebView2 documentation (the
`learn.microsoft.com/gaming/gdk/...` and `webview2/concepts/gaming` URLs both 404 for
unauthenticated access — much GDK documentation sits behind the developer portal), so I have no
source on whether WebView2 is *permitted* as a title's primary rendering surface at all, as
opposed to a login/store/UI panel. Given the WebGPU finding above, that question is now moot
for this game.

**The JIT question — answered, and it is the second nail.** **[VERIFIED]** Consoles do not
permit runtime code generation. MP2 Games, who build console JavaScript runtimes for a living
([mp2.dk/techblog/chowjs](https://mp2.dk/techblog/chowjs/), 2021-09-15):

> Game consoles "don't allow user applications to create executable code at runtime, effectively
> removing the possibility of using a JIT."

and, quantifying the fallback, *"V8 with JIT disabled can be **5x or even 17x slower** than V8
with JIT enabled."* Independently corroborated by CrossCode's developer, who tried the
interpreter route and reported it "turns out to not be fast enough" (§5.1).

**[INFERRED]** So an embedded V8 in `--jitless` mode is not a viable host for a 72k-line game
running a real-time renderer *and* an inference engine. The AOT route (§5.1) is the only
demonstrated path for JavaScript on console.

**And the one web-runtime-on-Xbox path that did exist has been closed.** **[VERIFIED]** Construct
3 shipped an "Xbox UWP (WebView2)" export in r371 (2023-12-12) — genuinely the only public
web-runtime-on-console route. But Microsoft Learn now carries a banner (page metadata updated
2026-01-14) on both the [UWP gaming getting-started](https://learn.microsoft.com/en-us/windows/uwp/gaming/getting-started)
and [Xbox UWP FAQ](https://learn.microsoft.com/en-us/windows/uwp/xbox-apps/frequently-asked-questions)
pages:

> "Before investing time developing a game based on the UWP framework, please note that **UWP
> based games are no longer accepted in the Xbox Store**. Please use the ID@XBOX program."

Corroborated by [MonoGame#8406](https://github.com/MonoGame/MonoGame/issues/8406) (2024-07-03).
Note Microsoft's own docs are internally inconsistent — a stale paragraph further down the FAQ
still points at the Creators Program — but the banner is newer and authoritative. Guidance
elsewhere on the web still describing Xbox as reachable via UWP or Hosted Web Apps **is out of
date**.

**[UNVERIFIED]** Whether Chromium/Electron/CEF could ship via the GDK by some other route. Given
the JIT prohibition and the Dawn/Xbox finding in §4.2, the question is academic.

### 4.2 The native route, honestly costed

If the runtime path is dead, the port is a rewrite. Three separable pieces:

**Graphics — the easiest third.** WebGPU-as-an-API exists natively via **Dawn** (C++, Google's
implementation, the same one inside Chromium) or **wgpu** (Rust). Our shaders are core WebGPU
with no optional features (§1.2), which is the best possible starting position — the WGSL
should port with minimal change, compiled to DXIL through Tint or Naga.

**[VERIFIED] — and this is decisive. Dawn's own support document states that Xbox D3D12 is
explicitly *not* supported** ([dawn.googlesource.com/dawn/+/HEAD/docs/support.md](https://dawn.googlesource.com/dawn/+/HEAD/docs/support.md),
accessed 2026-07-27). Not "untested", not "best effort" — the same document that grades desktop
D3D12 as the fully-supported preferred backend calls out Xbox as unsupported.

**[VERIFIED]** wgpu is no better: its supported-platform table lists Vulkan, Metal, DX12,
OpenGL and WebGPU across Windows, Linux/Android, macOS/iOS and Web, and makes **no mention of
Xbox, PlayStation or Switch** ([github.com/gfx-rs/wgpu](https://github.com/gfx-rs/wgpu),
accessed 2026-07-27).

**[INFERRED]** So **both** available WebGPU implementations decline Xbox — one explicitly, one
by silence. This is the expected shape (console graphics backends are under NDA and maintained
privately or by porting houses, and Xbox's D3D12 is a platform-specific variant, not stock
desktop D3D12), but it means the cheerful syllogism "Dawn supports D3D12, Xbox is D3D12,
therefore Dawn on Xbox" is **false on the record**, not merely unproven. A native port would
have to port or write a WebGPU implementation against the GDK — that is engine work, not
integration work, and it is the reason the estimate is months rather than weeks.

**The game code — the expensive third.** 72,117 lines of TypeScript in `src/game/` alone, plus
~15k more in the engine and model layers (§1.1). Either embed a JS runtime — gated on the JIT
question in §4.1 — or rewrite. **[UNVERIFIED]** I could not confirm any shipped console title
embedding V8/QuickJS/Hermes.

**The inference engine — the specialist third.** `src/engine` is a hand-written GGUF inference
engine expressed as WebGPU compute. Porting it means porting the compute kernels *and*
re-tuning them for a different GPU, different limits and a different memory system. The
existing kernels are tuned for RDNA2 desktop; Series S is RDNA2 too, which helps.

**[INFERRED]** Months, not weeks, for a team that has shipped on Xbox before — and this project
has no console experience, no devkit, and no C++/Rust engine.

### 4.3 Series S memory and silicon — *not* the blocker, and the silicon is actually friendly

**[VERIFIED]** Hardware: Series S is 10 GB GDDR6 (8 GB @ 224 GB/s + 2 GB @ 56 GB/s), GPU 4.006
TFLOPS, 20 CUs @ 1.565 GHz. Series X is 16 GB GDDR6 (12 GB @ 336 GB/s + 4 GB @ 224 GB/s), GPU
12.155 TFLOPS, 52 CUs @ 1.825 GHz
([Wikipedia](https://en.wikipedia.org/wiki/Xbox_Series_X_and_Series_S), accessed 2026-07-27 —
note its memory-split table is garbled in places; prefer the primary sources below).

**[VERIFIED]** Memory available *to titles*, from Xbox system architect **Andrew Goossen** via
Digital Foundry: **Series S — 8 GB** ("We feel good about the 8GB that we make available",
2020-11-10); **Series X — 13.5 GB**, with 2.5 GB reserved "from the slower pool for the
operating system and the front-end shell" (2020-03-16). Microsoft has never printed 13.5 GB in
a first-party public document — the authoritative page is NDA-gated — but the architect's
on-record statements are as good as public sourcing gets here. Note also that the commonly
repeated "7.5 GB" Series S figure is a **June 2020 pre-launch 'Lockhart' devkit leak, not the
shipped spec**. Microsoft later added more: the June 2022 GDK announcement states *"**Hundreds
of additional megabytes** of memory are now available to Xbox Series S developers"*
([developer.microsoft.com](https://developer.microsoft.com/en-us/games/articles/2022/08/the-june-game-development-kit-gdk-is-available-now/),
2022-08-04); the exact figure is **[UNVERIFIED]**.

**[INFERRED]** 1.11 GB of resident weights plus KV cache is roughly **14–15% of the Series S
title budget** — tight alongside a renderer, but genuinely feasible. Model load is a non-issue:
GGUF Q4 weights are already entropy-coded, so the console's compressed-streaming path does not
apply, and 1.1 GB ÷ ~2.4 GB/s raw ≈ **0.46 s**, once, at boot. And Series S at 4.0 TFLOPS is
**~2.5× the Steam Deck's compute**, so anything made to hit 30 fps on a Deck has headroom here.

**A genuinely encouraging finding for the native route.** **[VERIFIED]** Both consoles have
RDNA2 dot-product instructions built for exactly this workload — AMD's RDNA2 ISA reference
documents `V_DOT4_I32_I8` (INT8) and `V_DOT8_I32_I4` (packed INT4), and Goossen states Series X
offers *"49 TOPS for 8-bit integer operations and 97 TOPS for 4-bit"* (Series S scales to
roughly 16 / 32 TOPS). A Q4_K_M model maps onto that silicon directly.

**[VERIFIED]** But there is **no ML API on console**: the GDK's public console-features index
has no DirectML section, the public Xbox-GDK-Samples repo has no ML sample, and DirectML itself
is in "sustained engineering" with new work moved to Windows ML, which is Windows-only.

**[INFERRED]** — and this is the one place the Xbox estimate improves rather than worsens — the
consequence is that a native port would hand-write HLSL compute kernels against D3D12 using
those dot-product instructions. **That is almost exactly what `src/engine` already is.** The
WGSL compute inference engine ports conceptually 1:1; the *architecture* survives, and only the
shading language and the API binding change. Of the three thirds of the native port in §4.2,
the inference engine is the one whose design does not have to be reinvented.

### 4.4 One more cert requirement worth knowing: Series X|S parity

**[VERIFIED]** Xbox certification requirement **XR-130**, enforced by test case **130-04
"Featured Game Modes"**, tests that identical game modes exist on both consoles. The precedent
is well documented: Larian could not ship *Baldur's Gate 3* at all without Series S split-screen
until a negotiated exception in December 2023, and Phil Spencer reaffirmed on 2025-01-27 that
the Series S requirement *"isn't going anywhere"*
([VGC](https://www.videogameschronicle.com/news/xbox-boss-spencer-says-series-s-compatibility-requirement-isnt-going-anywhere/)).

**[INFERRED]** The open question this raises for *this* game is genuinely unresolved: **is
"NPCs converse with you via a live LLM" a feature difference (allowed, like resolution or frame
rate) or a game mode (parity-required)?** Given that it is the core of the product, the nearest
analogy says parity-required — you could not ship generative dialogue on Series X and canned
lines on Series S. Waivers are negotiated case by case at concept review. Add it to the list of
things to ask ID@Xbox up front (§6.3).

### 4.5 What actually stops it: Microsoft Store Policy §11.16

This is the most important finding in the report, and it is verified from the primary source.

**[VERIFIED]** **Microsoft Store Policies version 7.19**, published 2025-09-10, effective
2025-10-14, contains **§11.16 "Live Generative AI Content"**
([learn.microsoft.com/windows/apps/publish/store-policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies),
accessed 2026-07-27). The document defines "Store" to include "the Microsoft Store, the Windows
Store, and **the Xbox Store**." Verbatim:

> **11.16 Live Generative AI Content**
> Products that contain dynamic content created by generative AI models in response to user
> inputs must:
> - Disclose the use of live generative AI in the metadata.
> - Note the use of live generative AI in Partner Center during the submission process.
> - **Ensure that dynamic content created by generative AI models complies with all applicable
>   Store Policies.**
> - Provide a means for users to report inappropriate content to the developer. You must take
>   appropriate actions based on those reported concerns.

The first, second and fourth bullets are ordinary work — disclosure already exists in-game
(`AI_DISCLOSURE_TEXT`, `npc-chat-panel.ts:790`), Partner Center notation is a form field, and a
report mechanism is a day's UI work the game does not have yet.

**The third bullet is the problem**, because "all applicable Store Policies" includes:

> **11.7 Adult Content** — "Your product must not contain or display content that a reasonable
> person would consider pornographic or sexually explicit."
>
> **11.9 Excessive Profanity and Inappropriate Content** — "Your product must not contain
> excessive or gratuitous profanity. Your product must not contain or display content that a
> reasonable person would consider to be obscene."
>
> **11.5 Offensive Content** — "…must not contain content that advocates discrimination, hatred,
> or violence based on considerations of race, ethnicity, national origin, language, gender,
> age, disability, religion, sexual orientation, status as a veteran, or membership in any
> other social group."

Now put that against the game's own stated design, from `src/game/npc/content-safety.ts:12-25`:

> "This is not a general 'safety' or politeness filter, and it must never become one. The
> game's NPCs are meant to talk about dark, crude, violent, grieving, blasphemous and sexual
> subjects like adults in a harsh medieval world — that is the point of the game… So the scope
> here is narrow on purpose: content that is outright illegal… In a medieval-fantasy
> conversation engine that reduces in practice to one category — sexual content involving
> minors. Everything else an adult NPC might say is mature content, not illegal content, and is
> left alone."

**[INFERRED]** These two positions are irreconcilable as written. Steam is the right home for
that design — Valve publishes plenty of mature content, and the guardrail's illegal-content-only
scope is a coherent answer to Valve's survey. The Microsoft Store policies quoted above contain
no visible mature-content carve-out of the kind Steam offers, and §11.16 explicitly transfers
responsibility for the *model's* output onto the developer.

So the Xbox blocker is not the renderer, the language, or the memory. **It is that the game is
deliberately designed to generate content that §11.7 and §11.9 prohibit, and §11.16 makes you
answerable for it.** Shipping on Xbox would require the guardrail to become exactly the
"general safety and politeness filter" the codebase says it must never become — which is a
product decision, not an engineering one, and it should be made by the people who decided the
game's tone, not by a porting plan.

The `?npcllm=abliterated` path is categorically out: a model with its refusal direction
surgically removed cannot be reconciled with a policy requiring its output to comply with
§11.5/§11.7/§11.9. That path must not exist in any console build, and arguably should be
compiled out of any shipping build (see §7).

**[INFERRED]** A certifiable shape probably exists, and it looks like: bounded generation
(retrieval or template-constrained rather than open-ended), a *much* broader classifier-based
filter on both input and output, a user-reporting mechanism per §11.16, plus a rating strategy
per §4.5. That is a different game.

### 4.6 Ratings, ID@Xbox, and the process

**[VERIFIED]** Store Policy §11.11 requires an age rating obtained by completing "the
International Age Rate Coalition (**IARC**) rating questionnaire" during Partner Center
submission. §11.11.3 adds: if a product provides content "(such as user-generated, retail or
other web-based content) that might be appropriate for a higher age rating than its assigned
rating, you must enable users to opt in to receiving such content by using a content filter or
by signing in with a pre-existing account."

**[INFERRED]** §11.11.3 is interesting and possibly the most useful sentence for this game. It
contemplates content that may exceed the assigned rating and prescribes a remedy — an opt-in
content filter. A generative NPC system is arguably closer to "user-generated content" than to
authored content, and an opt-in mature-content toggle is a mechanism the policy itself names.
That is a thread worth pulling with a rating body, though it does not dissolve §11.16's
requirement that output comply with §11.7 regardless.

**[VERIFIED]** §11.12 (User Generated Content) requires published content guidelines, a means to
report inappropriate content, and removal on Microsoft's request. §10.13.1 sets the console
route: "Game products that target Xbox consoles… must use Xbox network services through the
**ID@Xbox** program. Optionally, you may publish your game product to console without
integration of Xbox network Services through the **Xbox Creators** program." The Creators
programme is the lighter path.

**[UNVERIFIED]** ID@Xbox onboarding requirements, devkit cost and timelines in 2026; whether any
developer has publicly shipped an on-device LLM in a certified console title; and how ESRB/PEGI
specifically treat unbounded generated text (`docs/AI_MODEL_LICENSING.md` §7.8 already records
that neither body has settled guidance, and recommends asking them directly — I found nothing
that changes that).

---

## 5. Cross-cutting

### 5.1 Precedents

**On Steam, the precedent is strong.** §2.3 names shipped Steam titles on Electron (shapez,
Desktop Heroes, Wayward, CasinoRPG, Dull Grey), on NW.js (Game Dev Tycoon, CrossCode, The
Curious Expedition, Screeps), and on WebView2/CEF via Construct 3 (Moonstone Island, Astral
Ascent, Pepper Grinder, Mosa Lina). A commercial engine maintains Steamworks bindings for three
different web runtimes. **Shipping a web game on Steam is a well-trodden path, and this project
would not be doing anything exotic.**

**On console, the precedent is clear, consistent, and not what anyone hopes for.** Every web
game that reached console did so by **compiling the JavaScript to native code ahead of time, or
by rewriting the game outright.** There is no shipping web runtime on any console.

**Vampire Survivors is the closest analogue, and it is a *negative* precedent.** The usual
telling — "a web game that made it to console" — inverts what actually happened:

- **[VERIFIED]** The pre-1.6 Steam build was **Phaser 3 + Electron 15.3.0** (PCGamingWiki
  records the Electron version as confirmed through `process.versions.electron`).
- **[VERIFIED]** The Xbox release (10 November 2022) was **not** that build. Xbox Wire,
  2023-04-13 ([news.xbox.com](https://news.xbox.com/en-us/2023/04/13/vampire-survivors-dlc-2-launch/)):
  the original build "wasn't running very well on platforms different to PC," and poncle spent
  months "maintaining level parity between different versions of the game in parallel — **the
  new engine on Xbox and the original Javascript version on PC**." Tech director Sam McGarry:
  "The overall goal was for players not to notice."
- **[VERIFIED]** Steam only migrated to Unity at **v1.6, 17 August 2023** — nine months *after*
  the Unity build shipped on Xbox.

**So poncle rewrote the game in Unity in order to reach console, and ran two engines in
parallel for roughly nine months.** That is the precedent: not a port, a rewrite.

**CrossCode is the positive precedent, and it shows the actual mechanism.** JavaScript/HTML5
(ImpactJS), shipped on Switch, PS4 and Xbox One. Radical Fish's Felix Klein, interviewed
2020-07-02 ([Siliconera](https://www.siliconera.com/crosscode-interview-radical-fish-games-on-console-ports-and-whats-next/)):
*"CrossCode is written in JavaScript and runs on HTML5, which is difficult to port to
consoles."* Their original plan depended on **Nintendo Web Framework** — Nintendo's WebKit-based
HTML5/JS SDK — which "was discontinued for the Nintendo Switch." They then tried interpreting
the JavaScript, which "turns out to not be fast enough." What worked: *"Deck13 found a way to
**compile the JavaScript code base into C++ ahead-of-time** and the result is fast enough to run
the game with 60fps on the Switch."*

**And there is real middleware for exactly this.** **[VERIFIED]** MP2 Games' **ChowJS** is "an
AOT JavaScript engine for game consoles," built on QuickJS, compiling JS to machine code offline
([mp2.dk/techblog/chowjs](https://mp2.dk/techblog/chowjs/), 2021-09-15). Their **Chowdren**
runtime — which explicitly targets **Construct**, an HTML5/JS engine — compiles to C++ for
Switch, PS4, PS5, Xbox One and Xbox Series, and has shipped **OMORI** (built in the
JavaScript-based RPG Maker MV), Baba Is You, Iconoclasts, Cyber Shadow and others
([mp2.dk/chowdren](https://mp2.dk/chowdren/)). It is sold as a **service**, not a licensable
product. **[INFERRED]** ChowJS is very likely the mechanism behind OMORI's console ports — the
chain is strong (JS engine, timing, MP2 lists the title) but I found no single sentence saying
so outright.

**[VERIFIED]** For contrast, **Cookie Clicker** ships on Steam as an Electron wrapper and has
**never** shipped on console — the clean illustration of the whole pattern: web tech reaches
Steam trivially and console not at all.

**On WebGPU-native titles specifically, the record is thin and the flagship example cuts against
the idea.** **[VERIFIED]** Tiny Glade — the most-cited Rust graphics success of 2024 —
**outgrew wgpu and moved to raw Vulkan**. Pounce Light, interviewed 2024-05-30
([80.lv](https://80.lv/articles/exclusive-tiny-glade-developers-discuss-bevy-proceduralism-publishers-cozy-games)):
*"Initially, Anastasia's prototype was using Bevy for everything, including rendering, but
eventually, our needs outscaled what Bevy could provide at the time."* Its Steam page lists
Vulkan 1.2. wgpu's own [commercial users list](https://github.com/gfx-rs/wgpu/wiki/Users)
contains three entries, **none of them games**. A shipped Bevy title does exist — **Toroban**,
released 2025-12-01, per [Bevy's own blog](https://bevy.org/news/bevy-0-18/) — but no
wgpu/Dawn/Bevy game has shipped on **any** console.

**[VERIFIED]** And the structural reason is documented: wgpu's `wgpu-hal/src` contains only
`dx12, gles, metal, vulkan, noop` — no console backends — and its `Api` trait is not
object-safe, so a proprietary backend must be *compiled into* the crate rather than added from
outside. [rust-gamedev/wg#90 "Rust on Consoles"](https://github.com/rust-gamedev/wg/issues/90)
has been open since 2020-02-13, with Embark (a well-resourced, console-experienced Rust shop)
noting console work "can't be done in public." [bevyengine/bevy#8161](https://github.com/bevyengine/bevy/issues/8161)
has been open since 2023 and the Bevy Cheatbook states console "support is still mostly
nonexistent."

**The one part that *is* solved: shader translation.** **[VERIFIED]** Naga compiles
`wgsl-in → hlsl-out / spv-out / msl-out`, and Tint has `hlsl, msl, glsl, spirv` backends. **Our
10,392 lines of WGSL are the least of the problem** — WGSL→HLSL is an everyday shipping
feature. What is unsolved and NDA-blocked is the runtime/API binding layer beneath it.

### 5.2 The AI policy landscape, compared

Worth seeing the two platform regimes side by side, because they are closer in *shape* than
expected and much further apart in *effect*:

| | Steam | Microsoft Store / Xbox |
| --- | --- | --- |
| Policy exists? | Yes — AI content survey, "Live-Generated" category | Yes — **Store Policies §11.16**, effective 2025-10-14 **[VERIFIED]** |
| Disclosure required | Yes, on the store page | Yes, "in the metadata" and in Partner Center |
| Guardrail statement | Yes — what prevents *illegal* content | Output must comply with **all** Store Policies |
| Report mechanism | — | **Required** — the game has none today |
| Mature content | Broadly permitted | §11.7 / §11.9 prohibit explicit/obscene content with no visible carve-out |
| Net effect for this game | Shippable with the current design | **Not shippable with the current design** |

The game's existing work — `docs/AI_GUARDRAILS.md`, `docs/AI_MODEL_LICENSING.md`,
`docs/AI_TRANSPARENCY_GAP_ANALYSIS.md`, the in-game disclosure, the four-layer guardrail — is
genuinely strong preparation for Steam and covers three of §11.16's four bullets for Microsoft
too. The gap is the fourth bullet and the content scope, not the paperwork.

### 5.3 Licensing

Deliberately not re-litigated. `docs/AI_MODEL_LICENSING.md` covers Qwen3's Apache-2.0 status,
attribution obligations, depot redistribution, gating, and the Steamworks open-source
compatibility rule. Independent re-verification for this report confirms its conclusions and
adds a few points:

**[VERIFIED]** [Qwen3-1.7B's LICENSE](https://huggingface.co/Qwen/Qwen3-1.7B/raw/main/LICENSE)
is the literal canonical Apache-2.0 text, sections 1–9 unmodified, Appendix filled in as
"Copyright 2024 Alibaba Cloud" — not a lookalike. `NOTICE` returns **HTTP 404**, so Apache-2.0
§4(d)'s passthrough obligation is not triggered (its own precondition is unmet). There is **no
Qwen-specific use policy, naming requirement, or attribution badge** — no "Built with Qwen"
rule, unlike Llama 3 (which mandates prominent display of "Built with Meta Llama 3" plus an
Acceptable Use Policy) or Gemma (which mandates a NOTICE string and folds its Prohibited Use
Policy in as "an enforceable provision"). The old 100 M-MAU clause belongs to the *Tongyi
Qianwen* licence used by Qwen2 and earlier; **no Qwen3 checkpoint carries it.** The specific
GGUF this game ships, `unsloth/Qwen3-1.7B-GGUF`, declares `apache-2.0` and is ungated. (Worth
noting for the record: `bartowski/Qwen_Qwen3-1.7B-GGUF` has **no licence field at all** — an
omission rather than a restriction, but a reason to prefer the repo you already use.)

Three additions from this report:

1. Dropping the eSpeak/TTS chunk from the game depot removes the only GPL-3.0 component
   (§1.6) — worth doing for licence hygiene independent of size.
2. Store Policy §10.2.5 requires Xbox products to be installed and updated only through the
   Microsoft Store **[VERIFIED]**, which independently forces the bundle-the-weights decision
   that §6 of the licensing doc already recommends for Steam.
3. **On the abliterated path** (§7): the technique is from *"Refusal in Language Models Is
   Mediated by a Single Direction"* ([arXiv:2406.11717](https://arxiv.org/abs/2406.11717),
   NeurIPS 2024) — erasing a one-dimensional refusal direction from the residual stream, baked
   into the weights. **[VERIFIED]** The most prominent abliterated Qwen3-1.7B distributor,
   `huihui-ai`, writes on its own model card: *"It is recommended to use this model for
   research, testing, or controlled environments, **avoiding direct use in production or
   public-facing commercial applications**."* That is not a licence restriction — Apache-2.0
   imposes no commercial limit — but it is the distributor's explicit written advisory against
   precisely the use a shipped game would make of it. Worth quoting to whoever signs off.

### 5.4 One deadline that is not a porting item but is imminent

**[VERIFIED]** The EU AI Act's **Article 50 transparency obligations still apply from 2 August
2026** — days away. The Digital Omnibus was formally adopted 2026-07-01 and **entered into force
2026-07-27** ([European Commission](https://digital-strategy.ec.europa.eu/en/news/ai-omnibus-enters-force)),
and it did push high-risk deadlines out substantially (Annex III standalone from 2026-08-02 to
**2027-12-02**) — but **it did not move Article 50.**

`docs/AI_TRANSPARENCY_GAP_ANALYSIS.md` already holds this project's position and I am not going
to duplicate it. One point from this research worth adding there: **[VERIFIED]** the "evidently
creative, satirical, artistic or fictional" carve-out is textually scoped to **Art. 50(4)**, not
to Art. 50(2)'s machine-readable-marking duty — so the fiction exemption people reach for does
not exempt Article 50 as a whole. **[INFERRED]** that reading strengthens rather than weakens
the existing gap analysis, which claims its exemption under the guidelines' ¶88 route rather
than the fiction route. Flagging it so the distinction is not lost.

---

## 6. Staged plan, and the cheapest experiment that would falsify each tier

### 6.1 Tier 1 — Steam on Windows (weeks)

**De-risk first, in this order:**

1. **The one-day Steam integration spike — it settles three unknowns at once** (§2.4, §2.5,
   §3.3). Package the Electron build with `--in-process-gpu --disable-direct-composition`,
   launch it through Steam with the overlay enabled, then check, in order:
   - (a) Does Shift-Tab draw the overlay over the game?
   - (b) With a controller connected and Steam Input active, **does `navigator.getGamepads()`
     see it?** If not, you need the native-Steam-Input-over-IPC architecture instead of the
     browser Gamepad API — a design decision, and you want it in week one.
   - (c) Does `ShowFloatingGamepadTextInput` deliver keystrokes into `#npc-chat-input`?

   **(b) and (c) are the ones that can change the plan.** If (c) fails, the entire Deck
   free-text-chat approach fails. Cost: ~1 day with `steamworks.js` (installed from git — §2.6)
   and a Steam partner account.
2. **Range-serving weights** (§1.5) — with a test asserting HTTP **206**, not merely that
   loading works.
3. **Frame-time A/B with and without `--in-process-gpu`**, so you know what the overlay costs
   before you commit to it.

**Cheapest falsifier for the whole tier:** the coordinator's boot proof plus experiment 1.
WebGPU itself is no longer a risk — it runs unflagged **and** under the overlay flags
**[MEASURED-HERE]**. What remains is input and overlay behaviour, and one day settles both.

### 6.2 Tier 2 — Steam Deck (weeks–months, gated)

**De-risk first — and this is genuinely one afternoon with one Deck:**

1. **The AMD-Linux WebGPU test** (§3.1). Boot the Deck to desktop mode, run a current Chromium
   or an Electron build, open the console, and evaluate:
   ```js
   await navigator.gpu.requestAdapter()
   ```
   Run it **twice**: once with no flags (does the default rollout include AMD yet?), and once
   with `--enable-unsafe-webgpu --enable-features=Vulkan` (can it be forced on RADV?). The
   published rollout notes say AMD is not in the default path through Chromium 150 (§3.1), so
   expect the first to fail; **the second is the one that decides the tier.** If both return
   `null`, the native-Linux plan is dead and the fallback is Proton with the Windows build,
   which needs its own separate proving. This is the highest-value experiment in this document.
   **Assert it is a real adapter.** Check `adapter.info` reports an AMD device — Chromium on
   Linux/AMD has been observed silently falling back to **SwiftShader**, which will render
   correctly at single-digit frame rates and make a broken configuration look green (§3.1).

2. **Check the granted limits, not the requested ones** (§1.2). Log `device.limits` and confirm
   `maxStorageBufferBindingSize` clears the ~187 MiB tied-embedding tensor. This is five minutes
   and prevents a confusing failure later.
3. **If a real adapter comes back:** run the production build at 1280×800 and read the actual
   frame time against §3.4's 10–19 fps prediction. Then measure generation throughput **while
   rendering**, against §3.5's ~1–2 tok/s prediction. Those two numbers decide the tier.
4. **Then** — and only then — the input, glyphs, OSK, UI-scale and graphics-settings work.

**Cheapest falsifier:** step 1. Thirty minutes, one Deck, one line of code.

**Do the prefill investigation first, though — it is free.** §3.5 shows this engine's prefill is
slower than llama.cpp's *on a Deck*. Profiling that on the desktop costs no hardware, may yield
the largest single win in the report, and changes the Deck arithmetic before you ever buy a
device.

**Realistic target:** aim for **"Playable"**, not "Verified", in the first Deck release, and
expect the real work to be a **gameplay change** — moving generation out of the render loop
(§3.5) — rather than renderer tuning. Verified needs all of §3.2 fixed *plus* 30 fps; Playable
is achievable much sooner, and Valve's criteria treat it as a legitimate outcome.

### 6.3 Tier 3 — Xbox (months, and a product decision first)

**De-risk first — and the first item is not technical:**

1. **Ask before you build.** Take §4.5 to ID@Xbox and ask two questions directly: (a) can a title
   whose NPC dialogue is generated live by an on-device model, with a guardrail scoped to
   illegal content only, be certified under Store Policy §11.16 — and if not, what scope would
   be? (b) Under XR-130 / test 130-04, is generative NPC dialogue a *feature difference* or a
   *game mode* requiring Series S parity (§4.4)? **The answers determine whether any engineering
   is worth starting.** Cost: an email. This is the cheapest falsifying experiment in the entire
   report and it should happen before a single line of C++ is written.
2. **Do not spend time re-checking the runtime path.** It is closed on the record, three
   independent ways: Dawn does not support Xbox D3D12 (§4.2); WebView2-on-Xbox returns no WebGPU
   adapter and the request has sat open since 2023 (§4.1); consoles forbid JIT, and UWP games —
   the one web-runtime route that ever existed — are no longer accepted in the Xbox Store
   (§4.1). The only genuinely open technical question is whether Dawn's D3D12 backend is
   *adaptable* to GDK D3D12 under NDA, which only a devkit holder can answer.
3. **If you proceed anyway, price the AOT route, not a rewrite-from-scratch.** §5.1 shows the
   demonstrated path for JavaScript on console is ahead-of-time compilation — and there is a
   vendor who does exactly this for HTML5/JS engines and has shipped multiple titles on Xbox
   Series (MP2 Games / ChowJS / Chowdren). A conversation with them is cheaper than a year of
   in-house C++. Note the encouraging half of §4.3: the inference engine's architecture ports
   roughly 1:1 to hand-written HLSL compute, because that is already what it is.

**Cheapest falsifier:** experiment 1, an email, before anything else.

---

## 7. What I could not verify — read this before acting

Listed plainly, because a gap presented as a finding is worse than a gap.

1. **Whether AMD-on-Linux WebGPU can be forced to work on a Deck.** The rollout status is now
   well sourced — Intel only at Chrome 144, NVIDIA added at 147–148, **AMD still unannounced
   through 150** — but "not in the default rollout" is not the same as "cannot be flag-enabled
   on RADV". **This is the number-one open question for the Deck** and it needs the hardware
   (§3.1, §6.2).
2. **Whether `--in-process-gpu` and WebGPU coexist *on Linux/RADV*.** I proved they do on
   Windows/D3D12 **[MEASURED-HERE]**, which is a strong signal but not the same backend. If they
   conflict on Deck, the overlay and the renderer become mutually exclusive there.
3. **Whether the browser Gamepad API works under Steam Input on current Chromium** (§2.5).
   Reported broken on 114+; last known good Electron 25/26. The issue was closed 2025-09-21 and
   I could not determine whether by a fix or by staleness. **This is the number-one open
   question for Tier 1** and it shapes the input architecture.
4. **Whether the Steam overlay actually attaches** to an Electron window on Windows and on Deck
   (§2.4, §3.3). I proved WebGPU survives the required flags; I could not prove the overlay
   then works. Deck specifically has its own reported failure (electron#47662).
5. **Whether `--in-process-gpu` costs frame time** in this renderer. Measure with and without.
6. **Whether Valve's Distribution Agreement contains a rule about runtime downloads** (§2.7).
   The published documentation does not; the agreement is login-gated.
7. **ID@Xbox devkit cost and onboarding timeline in 2026**, and any precedent for a certified
   console title shipping an on-device LLM (§4.6). A sub-agent was still researching this when
   the report was written.
8. **Whether ChowJS specifically powered OMORI's console ports** (§5.1) — strong circumstantial
   chain, no single confirming sentence. Relevant only if you pursue the AOT route.
9. **Whether Dawn's D3D12 backend could be adapted to Xbox's GDK-flavoured D3D12.** Dawn says
   Xbox is unsupported; whether it is *adaptable* under NDA is unknown in both directions.
10. **Rendered glyph height** of the 10px/11px UI text against Valve's 9px floor — my cap-height
    ratio is an estimate; measure on-device (§3.2).
11. **Whether prefill is engine-limited rather than hardware-limited** (§3.5). Now
    well-supported — this engine's prefill is slower than llama.cpp's *on a Steam Deck* — but
    still an inference from two numbers rather than a profile. **Settle it on the desktop; it
    costs nothing and may be the largest win in the report.**
12. **Everything in §3.4 and §3.5** is arithmetic on measured inputs, not a benchmark of this
    engine on this hardware. RDNA2-to-RDNA2 makes it more trustworthy than most such estimates,
    but no one has run this game on a Deck.
13. **Whether any WebGPU application has ever run on a Steam Deck**, in either direction. I
    found **zero public reports**. That absence is itself worth noting: you would be first, and
    first means no one has hit the bugs ahead of you.
14. **Whether XR-130 mode parity treats generative NPC dialogue as a "game mode"** (§4.4).
    Genuinely unresolved; ask at concept review.

One recommendation that is not a porting item but follows from §4.5, §5.3 and §1.5: **consider
compiling the `?npcllm=abliterated` path out of shipping builds entirely.** It currently
resolves a URL parameter to an abliterated model on any build a player can run. On Steam that is
an AI-survey exposure the project has already documented — and note that Valve's one hard
prohibition is on live-generated AO sexual content (§2.8), which is exactly what removing a
model's refusal direction makes reachable. On any console it would be disqualifying. The
upstream distributor of the most prominent abliterated Qwen3 explicitly advises against
"production or public-facing commercial applications" (§5.3). It costs nothing to gate behind a
dev-only build flag.

---

## Appendix A — reproducing the local measurements

All of these ran on the dev machine on 2026-07-27. Nothing here modifies the repository.

**Electron's bundled Chromium** (writes only to the scratch dir):
```js
// ver.cjs — run: ./node_modules/.bin/electron ver.cjs
const { app } = require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  console.log(process.versions.electron, process.versions.chrome, process.versions.v8);
  app.exit(0);
});
```
→ `43.2.0  150.0.7871.129  15.0.1240245-electron.0`

**WebGPU with no flags** — load a local HTML file in a `BrowserWindow` (no
`appendSwitch` calls at all) that runs `navigator.gpu.requestAdapter()` then
`adapter.requestDevice()`, and log the result. → adapter `amd / rdna-2`, device OK,
`maxStorageBuffersPerShaderStage = 16`, `maxBufferSize = 2048 MB`.

**WebGPU under the Steam-overlay flags** — the same probe, with these two lines added before
`app.whenReady()`:
```js
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-direct-composition');
```
→ adapter `amd / rdna-2`, device OK, `timestamp-query` present, `webgpu: enabled`. **WebGPU and
the Steam overlay flags coexist.**

**Electron GPU feature status** — must be queried *after* a window has loaded, or it falsely
reports everything disabled:
```js
const win = new BrowserWindow({ show: true });
await win.loadFile('gpu.html');
await new Promise(r => setTimeout(r, 6000));
console.log(app.getGPUFeatureStatus());   // → { ..., "webgpu": "enabled", ... }
```

**Code size:** `find src -name "*.ts" | xargs wc -l` and the same for `*.wgsl`.

**Gamepad audit:**
`grep -rn "getGamepads\|gamepadconnected" --include=*.ts --include=*.js --include=*.html --exclude-dir=node_modules --exclude-dir=dist .`
→ no matches.

**Font sizes:** `grep -rhno "font-size: *[0-9.]*px" src/game/ui/*.ts src/game/map/*.ts game.html`
→ 10px ×5, 11px ×12, 12px ×6, 13px ×1, 14px ×1, 15px ×1, 18px ×1.

---

## Appendix B — sources

**Valve / Steam**

| Source | Used for | Date |
| --- | --- | --- |
| [Steam Deck compatibility review criteria](https://partner.steamgames.com/doc/steamdeck/compat) | All Verified criteria in §3.2, quoted verbatim | accessed 2026-07-27 |
| [Steamworks ISteamUtils](https://partner.steamgames.com/doc/api/ISteamUtils) | `ShowFloatingGamepadTextInput` / `ShowGamepadTextInput` semantics, §3.3 | accessed 2026-07-27 |
| [Steam Overlay documentation](https://partner.steamgames.com/doc/features/overlay) | "web browsers do not support this model"; hook-before-device-creation, §2.4 | accessed 2026-07-27 |
| [Steam Screenshots](https://partner.steamgames.com/doc/features/screenshots) | Overlay is a hard dependency for screenshots, §2.4 | accessed 2026-07-27 |
| [Steam Content Survey](https://partner.steamgames.com/doc/gettingstarted/contentsurvey) | Pre-Generated vs Live-Generated definitions; AO sexual content prohibition, §2.8 | accessed 2026-07-27 |
| [Valve, "AI Content on Steam"](https://store.steampowered.com/news/group/4145017/view/3862463747997849618) | Original AI disclosure policy, §2.8 | 2024-01-10 |
| [AI Roguelite store page](https://store.steampowered.com/app/1889620/) | Precedent: local-LLM game with out-of-depot weights, §2.7 | released 2023-10-25 |

**Chromium / Electron / WebGPU**

| Source | Used for | Date |
| --- | --- | --- |
| [Electron release schedule](https://releases.electronjs.org/schedule) | Electron↔Chromium version table, §2.2 | accessed 2026-07-27 |
| [Chrome WebGPU release blog](https://developer.chrome.com/blog/webgpu-release) | WebGPU shipped in Chrome 113, Windows/D3D12, §2.2 | updated 2023-04-06 |
| [New in WebGPU — Chrome 144](https://developer.chrome.com/blog/new-in-webgpu-144) | Linux WebGPU rollout, **Intel Gen12+ only**, §3.1 | published 2026-01-07 |
| [New in WebGPU — Chrome 147–148](https://developer.chrome.com/blog/new-in-webgpu-147-148) | Linux expands to NVIDIA on Wayland — **still no AMD**, §3.1 | 2026-04-22 |
| [New in WebGPU — Chrome 149–150](https://developer.chrome.com/blog/new-in-webgpu-149-150) | No AMD-on-Linux support mentioned, §3.1 | 2026-06-17 |
| [electron#26944](https://github.com/electron/electron/issues/26944) | "We don't do anything special to disallow or allow this feature", §2.2 | 2021-04-01 |
| [electron#45989](https://github.com/electron/electron/issues/45989) | Gamepad not detected under Steam Input, §2.5 | opened 2025-03-12 |
| [electron#47662](https://github.com/electron/electron/issues/47662) | Steam overlay failure on SteamOS/Deck, §3.3 | 2025-07-04 |
| [Construct-bugs#8625](https://github.com/Scirra/Construct-bugs/issues/8625) | "no gamepads work at all — not even the steamdeck's own buttons" on Chromium 114+, §2.5 | 2025-06-04 |
| [Dawn support matrix](https://dawn.googlesource.com/dawn/+/HEAD/docs/support.md) | D3D12 preferred on Windows; **Xbox not supported**, §2.2 / §4.2 | accessed 2026-07-27 |
| [shapez electron/package.json](https://github.com/tobspr-games/shapez.io/blob/main/electron/package.json) | Shipped game using `--in-process-gpu --disable-direct-composition`, §2.4 | repo pushed 2026-04-28 |
| [electron why-electron.md](https://github.com/electron/electron/blob/main/docs/why-electron.md) | "When not to use Electron: Games and Real-Time Graphics", §2.3 | accessed 2026-07-27 |
| [tauri#6381](https://github.com/tauri-apps/tauri/issues/6381) | Tauri maintainer: use Electron for cross-OS WebGPU, §2.3 | 2025-02-28 |

**Console / Xbox**

| Source | Used for | Date |
| --- | --- | --- |
| [Microsoft Store Policies v7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) | §11.16 Live Generative AI; §11.5/11.7/11.9/11.11/11.12; §10.2.5; §10.13.1 — §4.5, §4.6 | published 2025-09-10, effective 2025-10-14 |
| [UWP gaming getting-started](https://learn.microsoft.com/en-us/windows/uwp/gaming/getting-started) | **"UWP based games are no longer accepted in the Xbox Store"**, §4.1 | page updated 2026-01-14 |
| [WebView2Feedback#4138](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/4138) / [#4150](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4150) | No WebGPU adapter on Xbox; still open with no commitment, §4.1 | filed 2023-11-07/09 |
| [Microsoft Edge WebView2 introduction](https://learn.microsoft.com/en-us/microsoft-edge/webview2/) | WebView2 listed as supported on Xbox, §4.1 | page updated 2026-06-12 |
| [gfx-rs/wgpu](https://github.com/gfx-rs/wgpu) + [wgpu users wiki](https://github.com/gfx-rs/wgpu/wiki/Users) | No console backends; commercial users list has no games, §4.2 / §5.1 | accessed 2026-07-27 |
| [rust-gamedev/wg#90](https://github.com/rust-gamedev/wg/issues/90), [bevy#8161](https://github.com/bevyengine/bevy/issues/8161) | Rust/Bevy console support open for years, §5.1 | 2020-02-13 / 2023-03-22 |
| Digital Foundry interviews with Andrew Goossen | Series S **8 GB** to titles; Series X **13.5 GB**; INT8/INT4 TOPS, §4.3 | 2020-03-16, 2020-11-10 |
| [June 2022 GDK announcement](https://developer.microsoft.com/en-us/games/articles/2022/08/the-june-game-development-kit-gdk-is-available-now/) | "Hundreds of additional megabytes" for Series S, §4.3 | 2022-08-04 |
| [VGC — Spencer on Series S parity](https://www.videogameschronicle.com/news/xbox-boss-spencer-says-series-s-compatibility-requirement-isnt-going-anywhere/) | XR-130 parity requirement reaffirmed, §4.4 | 2025-01-27 |
| [Wikipedia — Xbox Series X and Series S](https://en.wikipedia.org/wiki/Xbox_Series_X_and_Series_S) | Console hardware specs, §4.3 (memory-split table is garbled; prefer DF) | accessed 2026-07-27 |

**Steam Deck hardware and LLM performance**

| Source | Used for | Date |
| --- | --- | --- |
| [steamdeck.com — LCD](https://www.steamdeck.com/en/tech/deck) / [OLED](https://www.steamdeck.com/en/tech) | Valve's own APU, RAM, TDP figures; 1.0–1.6 GHz clock range, §3.4 / §3.6 | accessed 2026-07-27 |
| [Wikipedia — Steam Deck](https://en.wikipedia.org/wiki/Steam_Deck) | Deck CUs, TFLOPS, LPDDR5 bandwidth, LCD vs OLED, §1.7 | accessed 2026-07-27 |
| [Wikipedia — Radeon RX 6000 series](https://en.wikipedia.org/wiki/Radeon_RX_6000_series) | RX 6700 XT specs for the scaling baseline, §1.7 | accessed 2026-07-27 |
| [llama.cpp Vulkan scoreboard #10879](https://github.com/ggml-org/llama.cpp/discussions/10879) | **The** measured Deck benchmark: pp512 156 t/s, tg128 18.39 t/s; `int dot: 0`, no matrix cores, §3.5 | 2025-04-22 |
| [Deck `vulkaninfo` dump](https://gist.github.com/rgerganov/ed8f00a38cd42696d1baadcc86b8e9e6) | RADV VANGOGH queue topology and memory limits, §1.2 / §3.5 | 2025-04-22 |
| [MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits), [GPUDevice.queue](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/queue) | WebGPU default limits (256/128 MiB); single-queue design, §1.2 / §3.5 | accessed 2026-07-27 |
| [MDN browser-compat-data `api/GPU.json`](https://github.com/mdn/browser-compat-data/blob/main/api/GPU.json) | Chrome Linux WebGPU "Intel Gen12+ only"; Firefox "Does not support Linux", §3.1 | updated 2026-07-10 |
| [bevy#22044](https://github.com/bevyengine/bevy/issues/22044) | Linux + AMD RDNA2: blank adapter / silent SwiftShader fallback, §3.1 | 2025-12 |
| [Running LLMs on Steam Deck](https://bilawal.net/running-llms-on-steam-deck) | 10–11 W GPU draw during generation, §3.6 | 2025-09-09 |
| [WebGPU dispatch overhead](https://arxiv.org/html/2604.02344v1) | 24–36 µs per dispatch on Vulkan, §3.5 | 2026-02-09 |
| [Valve Deck recommendations](https://partner.steamgames.com/doc/steamdeck/recommendations), [Deck FAQ](https://partner.steamgames.com/doc/steamdeck/faq) | Vulkan guidance, FPS limiter, AC-vs-battery parity, §3.6 | accessed 2026-07-27 |

**Precedents**

| Source | Used for | Date |
| --- | --- | --- |
| [Xbox Wire — Vampire Survivors](https://news.xbox.com/en-us/2023/04/13/vampire-survivors-dlc-2-launch/) | Unity rebuild for console; two engines in parallel, §5.1 | 2023-04-13 |
| [Siliconera — CrossCode interview (Felix Klein)](https://www.siliconera.com/crosscode-interview-radical-fish-games-on-console-ports-and-whats-next/) | JS→C++ AOT; Nintendo Web Framework discontinued, §5.1 | 2020-07-02 |
| [MP2 Games — ChowJS](https://mp2.dk/techblog/chowjs/) | **No JIT on consoles**; V8 jitless 5–17× slower, §4.2 / §5.1 | 2021-09-15 |
| [MP2 Games — Chowdren](https://mp2.dk/chowdren/) | AOT runtime targeting Construct; shipped OMORI etc. on Xbox Series, §5.1 | accessed 2026-07-27 |
| [80.lv — Tiny Glade interview](https://80.lv/articles/exclusive-tiny-glade-developers-discuss-bevy-proceduralism-publishers-cozy-games) | Outgrew wgpu → raw Vulkan, §5.1 | 2024-05-30 |
| [Bevy 0.18 blog](https://bevy.org/news/bevy-0-18/) | Toroban — a shipped Bevy title, §5.1 | 2026-01-13 |
| [Phaser — Desktop Heroes postmortem](https://phaser.io/news/2026/04/desktop-heroes-phaser-electron-steam) | Phaser+Electron on Steam; "no official JavaScript SDK for Steam", §2.3 | 2026-05-08 |
| [greenworks users wiki](https://github.com/greenheartgames/greenworks/wiki/Apps-games-using-greenworks), [NW.js apps list](https://github.com/nwjs/nw.js/wiki/List-of-apps-and-companies-using-nw.js) | Named shipped Steam titles per runtime, §2.3 | accessed 2026-07-27 |

**Licensing / AI policy**

| Source | Used for | Date |
| --- | --- | --- |
| [Qwen3-1.7B LICENSE](https://huggingface.co/Qwen/Qwen3-1.7B/raw/main/LICENSE) | Verbatim Apache-2.0, "Copyright 2024 Alibaba Cloud"; NOTICE 404, §5.3 | accessed 2026-07-27 |
| [arXiv:2406.11717](https://arxiv.org/abs/2406.11717) | Refusal-direction paper underlying abliteration, §5.3 | NeurIPS 2024 |
| [huihui-ai/Qwen3-1.7B-abliterated](https://huggingface.co/huihui-ai/Qwen3-1.7B-abliterated) | Distributor advisory against commercial/public-facing use, §5.3 | accessed 2026-07-27 |
| [EC — AI Omnibus enters into force](https://digital-strategy.ec.europa.eu/en/news/ai-omnibus-enters-force) | Art. 50 deadline unchanged at 2026-08-02, §5.4 | 2026-07-27 |
| In-repo: `docs/AI_MODEL_LICENSING.md`, `docs/AI_GUARDRAILS.md`, `docs/AI_TRANSPARENCY_GAP_ANALYSIS.md` | Licensing, guardrail design, EU AI Act position — cross-referenced, not duplicated | 2026-07 |
| Local measurement (Appendix A) | Electron 43.2.0 / Chromium 150; WebGPU unflagged **and** under overlay flags; code size; gamepad audit; font sizes; depot sizing | 2026-07-27 |
