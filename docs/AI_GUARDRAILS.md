# AI Guardrails

What this document is for: Steam's Content Survey asks developers shipping
**Live-Generated** AI content to describe *"what kind of guardrails you're
putting on your AI to ensure it's not generating illegal content."* This is the
factual answer, written so a reviewer or a lawyer can verify it against the
code rather than take it on trust.

Companion document: [`AI_MODEL_LICENSING.md`](./AI_MODEL_LICENSING.md) covers
which model to ship and under what licence.

---

## Scope, stated plainly

The game's NPCs are designed to talk like adults in a harsh medieval world.
They will discuss sex, violence, grief, blasphemy, crime and cruelty, and they
will not moralise at the player. **That is mature content, and it is
deliberate.** Steam publishes a great deal of mature content; the Content
Survey question is about *illegal* content, which is a different and much
narrower thing.

So the guardrail is scoped to content that is illegal essentially everywhere
the game would sell, which in a conversation engine reduces in practice to one
category:

| Category | Enforced | Rationale |
|---|---|---|
| Sexual content involving minors | Yes — hard block, both directions | Illegal in every target market. No legitimate use in this product. |
| Other mature content (sex, violence, drugs, crime, blasphemy) | Not blocked | Legal. Core to the product. Handled by store age-rating, not by filtering. |

A filter that blocked more than this would not make the game safer — it would
break the feature it is protecting, and quietly. Nobody files a bug report
saying "the blacksmith declined to discuss my divorce."

---

## The four layers

### 1. Model selection (strongest lever)

**Done — 2026-07-25.** The default is now stock **`Qwen3-1.7B` Q4_K_M**
(`unsloth/Qwen3-1.7B-GGUF`, Apache-2.0), replacing an **abliterated** build
whose refusal direction had been removed from the weights. While that shipped,
every layer below was the *only* thing standing between a crafted prompt and
its output; a stock instruction-tuned model puts trained refusal back
underneath them. The licensing case and the safety case were independent and
pointed the same way — see `AI_MODEL_LICENSING.md`.

The **Dungeon Director now runs the same model**, so there is one set of
weights, one licence to document, and no path in shipping code that reaches the
unlabelled `flux2-te-qwen3-4b-q4_k_m` checkpoint (which had no licence field at
all). `?npcllm=abliterated` still reaches an abliterated model for comparison;
under that flag layer 3 really is the only layer, and it must not become the
default again.

**Verified against the real model, not just typechecked**
(`scripts/test-npc-live.mts`, `scripts/test-npc-ingame.mts`):

- The model loads, the ChatML template matches the GGUF's own embedded
  template, and no `<think>` block or control JSON has leaked to the player in
  any measured turn.
- Under the guardrail probes the model **sometimes declines on its own** — the
  layer that abliteration had removed, observably back.
- The mature-content behaviour the game depends on did **not** regress: the
  stock model still discusses sex, war atrocity, grief and blasphemy in
  character without moralising. This was the main risk of the swap and it did
  not materialise.

### 2. System-prompt instruction

`src/game/npc/npc-prompt.ts` instructs the model that adult subjects are open
and it must not moralise, with exactly one carve-out: never write anything
sexual involving a child, refuse in character if steered there.

A prompt is a request, not a control — especially to an abliterated model.
This layer is real but it is not load-bearing on its own.

Regression-tested in `scripts/test-npc.mts`: both the open-adult rule and the
carve-out are asserted, so neither can be silently dropped. `NPC_PROMPT_VERSION`
is 10; the golden prompt hash pins the exact text.

### 3. Deterministic filter — the load-bearing layer

`src/game/npc/content-safety.ts`. A rule list, not a model:

- Runs on the **player's input** before it reaches the model, so prohibited
  content is never generated rather than caught afterwards. A blocked turn is
  kept out of conversation history entirely — leaving it in would feed it back
  as context on every later turn and steer the whole conversation.
- Runs on the **model's streaming output** as the buffer grows, not only on the
  finished reply, because streaming puts partial text on screen a second or two
  before generation completes.
- Runs again on the **assembled reply**. A blocked reply is discarded, not
  redacted, and never reaches history, memory or disposition.
- Runs on the **AI Director's dungeon names** — the one free-text field in a
  generated dungeon spec that is shown to the player verbatim. Reported as a
  validation error so the Director's existing retry path regenerates it.

Matching is co-occurrence based: an unambiguous minor-referent term near an
explicit sexual term, plus a short list of phrases with no innocent reading,
plus stated ages under 18. Words like "girl", "boy", "lad" and "lass" are
everyday medieval address for adults and only count when carrying an age
qualifier — without that distinction the filter misfires constantly on ordinary
tavern conversation. Input is normalised for accents, homoglyph substitution
(`ch1ld`) and letter-repetition (`chiiiild`).

Chosen over a classifier model deliberately: a second model would double the
memory budget, add latency to every line against a hard project rule that the
LLM must never block gameplay, and could itself be prompt-injected. A rule list
costs microseconds and can be read by a human.

**Honest limit:** term matching is not semantic and a determined user can work
around it. It is one layer of four, and layer 1 is the one that matters most.

### 4. Player-facing disclosure

Two disclosures, both in the game itself:

- A **first-run notice**, shown once per profile ahead of the first line any NPC
  speaks: the dialogue is AI-generated, it runs on the player's own machine so
  nothing they type is sent anywhere, it can be wrong or offensive, and it is
  not a person. `AI_DISCLOSURE_TEXT` in `src/game/ui/npc-chat-panel.ts`.
- A **persistent** `replies are AI-generated` line under the input box.

This addresses EU AI Act **Article 50(1)**, applicable from **2 August 2026**,
and it is *also* one of the five conjunctive conditions of the Article 50(2)
exemption route. Full analysis, including what is deliberately not claimed:
[`AI_TRANSPARENCY_GAP_ANALYSIS.md`](./AI_TRANSPARENCY_GAP_ANALYSIS.md).

---

## Verification

`scripts/test-content-safety.mts` — 65 assertions. The suite is deliberately
weighted toward **false positives**, because over-blocking is the failure mode
most likely to ship unnoticed. Every blocking rule is paired with the nearest
legitimate phrasing that must still get through: graphic violence, war
atrocity, adult sexual conversation, grief about a dead child, "that girl and I
were lovers", trade talk containing numbers, romance and marriage dialogue.

Also covered: hostile input never throws (a guardrail that throws is a
guardrail that fails open), and 20,000 words screen in under 250 ms.

Run: `npx tsx scripts/test-content-safety.mts`

---

## Verification against the real model

The filter is unit-tested (65 assertions), but term lists tested only against
themselves prove nothing about live behaviour. `scripts/test-npc-live.mts` runs
the probes through the **actual shipped model on the actual GPU** and reports
both directions. Latest run, stock Qwen3-1.7B:

| | Result |
|---|---|
| Prohibited prompts blocked | 3/3 (all caught on **input**, so nothing was generated) |
| Ordinary mature prompts allowed | 5/5 |
| Over-blocks on civil conversation | **0** |
| Control JSON or `<think>` visible to the player | **0** in 18 replies |

The five that must pass are the point of the exercise: adult sexual
conversation, war atrocity, grief about a dead child, "that girl and I were
lovers", and a trade question containing the numbers 14 and 12. All produced
full in-character replies. **Over-blocking remains the failure mode most likely
to ship unnoticed**, and it is the one this suite is weighted to catch.

---

## Known gaps — for human sign-off before release

1. ~~The abliterated model is the shipped default.~~ **Closed 2026-07-25** —
   layer 1 is in place; see above.
2. **EU AI Act Article 50(2).** No longer unaddressed, but not "solved" either:
   a documented exemption position is now recorded in
   [`AI_TRANSPARENCY_GAP_ANALYSIS.md`](./AI_TRANSPARENCY_GAP_ANALYSIS.md),
   resting on the Commission's ¶88 route and measured evidence that marking is
   not technically feasible at our output length (p50 64 tokens). Article 50(1)
   disclosure is implemented. **This still needs a lawyer** — the guidelines are
   non-binding and there is no case law.
3. **No age gate.** Reviewed and **deliberately not added.** An unauthenticated
   self-declared date box is trivially bypassed, stores no useful evidence, and
   would be the game's only personal-data prompt. Storefront age rating plus the
   first-run AI notice is the better control. **Confirm against the rating each
   target storefront actually applies** — if a rating body requires an in-app
   gate, this decision must be revisited.
4. **No telemetry on blocks.** Unchanged, and deliberate. Blocks are logged to
   the browser console only; nothing is transmitted. A privacy positive that
   costs us field data on filter efficacy.
5. The filter is **English-only**, as is the disclosure text. If the game
   localises, neither travels.
6. **Term matching is not semantic.** Unchanged and inherent. A determined user
   can work around it; it is one layer of four and layer 1 is the load-bearing
   one.

A lawyer should confirm the Steam Content Survey answer and the Article 50
position before release.
