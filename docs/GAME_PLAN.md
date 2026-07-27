# Game Plan — *A Tale of Yarn*, from measured-correct to actually launched

**Date: 27 July 2026.** This is a go-to-market and polish plan, not an engineering plan.
`docs/PORTING.md` covers the platform engineering and is not re-litigated here.

## How to read this document

| Tag | Meaning |
| --- | --- |
| **[VERIFIED]** | Primary source, quoted, with URL and the date I read it. |
| **[ANALYST]** | A named industry analyst's number. Real data, one methodology, not peer-reviewed. |
| **[INFERRED]** | My reasoning from verified facts. The reasoning is shown so you can check it. |
| **[CRAFT]** | Widely-held practice with no number behind it. Treated as opinion, labelled as opinion. |
| **[DISPUTED]** | Sources conflict. Both sides given. |
| **[UNVERIFIED]** | I looked and could not find it. Stated as unknown, not smoothed over. |

**Method limitation, stated up front.** The WebSearch budget for this session was exhausted
before research began, so everything below came from *direct fetches of primary URLs* plus a
small number of named analyst pages. That biases the evidence toward Valve's own documentation
(good) and away from forum/Reddit/community sentiment (a real gap). **"Not found" in this
document means "not reachable by direct fetch on 2026-07-27", not "does not exist."** Several
gaps in §7 are worth a second pass when search is available.

---

## 0. The decision, in one page

**The brief's central assumption is wrong, and I have the quote.** The plan was built on
"a free release burns the app ID, because free games cannot become paid." Valve's own pricing
FAQ says the opposite:

> **Q: What if I want to change my game from free to paid?**
> A: **You're welcome to change your game from free to paid**, so please use the support form
> here to contact us to change from a Free to Play game to a paid package. Treating customers
> fairly is the most important thing to us, so we ask that you give your customers at least one
> week notice via a News Event before removing any in-game purchasing (if applicable) and
> switching your app from free to paid. This gives customers fair warning to acquire the free
> license and/or use up any remaining in-game currency or items before your business model
> changes. **Users that have the free license for your game in their account will continue to
> own and be able to play the game after it switches from free to paid.**

— [partner.steamgames.com/doc/store/pricing](https://partner.steamgames.com/doc/store/pricing),
FAQ section, read 2026-07-27. **[VERIFIED]** — confirmed by a literal-string re-check of the
same page after an earlier automated read of this URL returned a hallucinated answer. The
strings `free to paid` and `Free to Play game to a paid package` are both literally present.

**This does not rescue the free-first plan — it just changes why it fails.** The app ID is not
burned. Four *other* things are, and each is independently verified:

1. **Next Fest is one-shot and requires "unreleased."** *"Will not be released before the
   applicable Next Fest edition concludes"* and *"titles may only participate in **ONE** Next
   Fest."* Valve's own FAQ closes the loophole explicitly: *"If you plan on entering Early
   Access or launching your game for free, that's fine, but the game must not yet be released
   to remain eligible for Next Fest."*
   ([nextfest doc](https://partner.steamgames.com/doc/marketing/upcoming_events/nextfest),
   read 2026-07-27) **[VERIFIED]**. Releasing free on Steam forfeits your single Next Fest
   permanently. Eligibility keys off the **Released** state transition, not the price.
2. **Everyone who takes it free keeps it forever** — Valve's own sentence, quoted above. A
   free-first release converts your most enthusiastic early audience, precisely the people
   most likely to have paid, into permanent non-customers.
3. **The launch-day wishlist notification fires once.** *"When your game releases, either in
   Early Access or as Full Release, any user that has the game on their wishlist at that time
   will receive an e-mail and/or mobile push notification"*
   ([wishlist doc](https://partner.steamgames.com/doc/marketing/wishlist), read 2026-07-27)
   **[VERIFIED]**. Spend it on the free build and it is spent.
4. **Reviews are permanent and the early pool is tiny.** Steam shows no score until 10 reviews;
   a handful of negatives from an unpolished free build sits on the app you later want to sell.
   One [ANALYST] claim says the reviews are wiped on the free→paid switch, which would be
   *good* news here — see §1.4, it is unsourced and I could not confirm it.

**The recommended funnel gives you every benefit free-first was for, and costs none of the
four.** In one paragraph:

> Keep the main app **paid and unreleased ("Coming Soon")** the entire time. Run the private
> rounds through **Steam Playtest** — a child app that generates *no reviews* and has *no
> wishlist impact*, so a rough build cannot leave a mark. Then ship a **free Demo app** — a
> separate App ID linked to the base game, with its own store page, which Valve says *"can
> appear anywhere in Steam that a free game could appear… including lists such as the 'New &
> Trending'"* and can release before the base game. That is a free Steam release in everything
> but app state: zero price friction, real players, store-list exposure, wishlists accruing to
> the paid app via the automatic link back. Then spend your one **Next Fest** — **February or
> June 2027, not October 2026** — on a demo that has already survived three playtest rounds.
> Then decide the price from evidence. Because free→paid *is* permitted on the same app ID, a
> later "actually, make it free" is still available as a fallback; the reverse is not. **Take
> the option that keeps both doors open.**

**Top-5 polish priorities** (full evidence in §3): (1) the first 20 minutes free of visible
brokenness — the dry rivers and the 11-second dialogue cold start, both of which land inside a
14-minute median session; (2) performance plus a graphics-settings tier, because 23% of Steam
is on ≤6 GB VRAM and you are asking one GPU to run a renderer *and* an LLM; (3) LLM-NPC
never-blocks behaviour, the one failure mode that has provably sunk a comp; (4) the "expected
features" floor — controller, remapping, options, an icon; (5) art-direction coherence, ranked
fifth for *reviews* but first for *marketing*, and therefore gating the trailer.

**Do not lead the store page with the AI.** Evidence in §5.

---

## 1. The funnel

### 1.1 The rules, verified

| Rule | Status | Source (all read 2026-07-27) |
| --- | --- | --- |
| Free → paid on the same App ID is **permitted**, with ≥1 week News Event notice | **[VERIFIED]** quote in §0 | [doc/store/pricing](https://partner.steamgames.com/doc/store/pricing) |
| Paid → free is permitted, ≥1 week notice, via support form | **[VERIFIED]** | [doc/store/freetoplay](https://partner.steamgames.com/doc/store/freetoplay) |
| Free-license holders keep the game after a switch to paid | **[VERIFIED]** quote in §0 | doc/store/pricing |
| "Free" is set at app creation — *"select 'This is a free product' under Options"* | **[VERIFIED]** | doc/store/freetoplay |
| Next Fest: unreleased only; **ONE** per title; playable demo required at start | **[VERIFIED]** | [nextfest](https://partner.steamgames.com/doc/marketing/upcoming_events/nextfest) |
| Next Fest: free/EA plans are fine — *"the game must not yet be released"* | **[VERIFIED]** | nextfest FAQ |
| Next Fest demo submission: 4 weeks prior (before Press Preview) or 2 weeks prior | **[VERIFIED]** | nextfest |
| Next Fest excludes *"a prologue, preview, or short-form version of an existing game already released on Steam"* | **[VERIFIED]** | nextfest |
| Next Fest says **nothing** about prior release on itch/Epic/console — criteria reference Steam only | **[VERIFIED]** (as an absence) | nextfest |
| Demo = separate App ID linked to base game, own depots/builds | **[VERIFIED]** | [doc/store/application/demos](https://partner.steamgames.com/doc/store/application/demos) |
| Demo can appear *"anywhere in Steam that a free game could appear… 'New & Trending'"* | **[VERIFIED]** | demos |
| Demo store page can go up **before** the demo itself, to appear on the upcoming-demos list | **[VERIFIED]** | demos |
| *"Your demo will let players of the demo leave user reviews."* | **[VERIFIED]** | demos |
| Steam auto-links the demo page back to the full game *"making it easy for players to wishlist or purchase"* | **[VERIFIED]** | demos |
| Playtest: *"A customer who has only participated in the Playtest cannot review your actual game."* | **[VERIFIED]** | [doc/features/playtest](https://partner.steamgames.com/doc/features/playtest) |
| Playtest: *"A customer's wishlist for your game won't be impacted when they join or leave your playtest."* | **[VERIFIED]** | playtest |
| Playtest works without a public store page (key distribution); limited or open signup | **[VERIFIED]** | playtest |
| Steam Direct: **$100 per app**, *"not refundable, but… recoupable"* after **$1,000 Adjusted Gross Revenue** | **[VERIFIED]** | [doc/gettingstarted/appfee](https://partner.steamgames.com/doc/gettingstarted/appfee) |
| Store page must sit at "Coming Soon" **≥2 weeks** before release | **[VERIFIED]** | [doc/store/releasing](https://partner.steamgames.com/doc/store/releasing) |
| Store page review 3–5 business days; *"submit… at least 7 days before you want it live"*; build review likewise | **[VERIFIED]** | [doc/store/review_process](https://partner.steamgames.com/doc/store/review_process) |
| Review score **is not an algorithmic-visibility factor at Mixed (40%) or above**; below 40% *"less likely to be featured"* | **[VERIFIED]** | [doc/store/reviews](https://partner.steamgames.com/doc/store/reviews) |
| A "30-day rule" between paying the Direct fee and releasing | **[UNVERIFIED]** — checked appfee and releasing docs; no such rule found. Do not plan around it | — |
| Whether a Demo or Playtest child app needs its own $100 fee | **[UNVERIFIED]** — appfee doc does not mention demos or playtests at all | — |

### 1.2 Why the Demo app beats a free release, item by item

| What free-first was supposed to buy | Demo app delivers it? |
| --- | --- |
| Zero price friction, anyone can try it | **Yes** — a demo is free |
| Appears in Steam's free/new lists | **Yes** — *"anywhere… a free game could appear"* **[VERIFIED]** |
| Real players, real feedback | **Yes**, and demos take reviews too (a risk — see below) |
| Wishlists accumulating | **Yes**, and they accrue to the *paid* app via the automatic link-back |
| Preserves the one Next Fest | **Yes** — base game stays unreleased |
| Preserves the launch-day wishlist email | **Yes** — release event is still ahead of you |
| Preserves the paying audience | **Yes** — nobody is granted a permanent free license to the full game |

The one real cost: **demo store pages carry user reviews [VERIFIED]**. That is exactly why
Steam Playtest — which explicitly cannot produce reviews — goes *first*, and the demo goes up
only after the rough edges are gone.

### 1.3 Where itch.io fits

**[VERIFIED, as an absence]** Next Fest's criteria reference Steam release state only; a prior
itch release is not named as disqualifying. **[UNVERIFIED, flagged as a real risk]** one
research pass surfaced a secondhand reference to a Steam Distribution Agreement clause about
not releasing earlier on another platform after your Steam page is up. The agreement is
login-gated and could not be read. **Check this in the actual agreement before publishing
anything on itch after your Steam page goes live.**

**[ANALYST]** itch.io's own numbers argue against treating it as an audience channel: median
**1,582 lifetime views** and **113 downloads** per game; 30th percentile 397 views / 33
downloads (Zukowski, *Benchmark: Itch.io traffic*,
[howtomarketagame.com](https://howtomarketagame.com/2025/05/12/benchmark-itch-io-traffic/),
2025-05-12).

**Use itch as free plumbing, not marketing:** restricted pages with per-tester revocable
Download Keys and an optional page password
([itch.io/docs/creators/access-control](https://itch.io/docs/creators/access-control))
**[VERIFIED]** are the cheapest way to hand a 1.5 GB build to five strangers before you have
paid the $100 for a Steam app.

### 1.4 The one claim I could not settle

**[UNVERIFIED / ANALYST]** Chris Zukowski, *Don't make your game free*
([howtomarketagame.com](https://howtomarketagame.com/2025/07/29/dont-make-your-game-free/),
2025-07-29), asserts that on a free→paid switch *"every review that you got when it was free is
zapped by Valve."* He cites no Valve documentation and I could not find any. It cuts **for**
free-first if true (a bad free-era review record would be wiped) — which is precisely why it
should not be relied on. His own recommendation, notably, is *"If you really really want to put
it up for free, put it on itch.io. Then launch paid on Steam."*

### 1.5 Next Fest timing — the concrete call

**[VERIFIED]** The October 2026 edition runs **19–26 October 2026**, registration deadline
**31 August 2026**. February 2027 and June 2027 editions exist in the Steamworks navigation;
their exact dates were not published on the pages I could reach **[UNVERIFIED]**.

**Do not register for October 2026.** Five weeks from today the game has no trailer, no
capsules, no controller support, no graphics settings, and has never been played for twenty
consecutive minutes by a stranger. You get exactly one Next Fest per title, forever. **[ANALYST]**
pre-fest wishlist momentum predicts Next Fest outcome far more strongly (r=0.825) than in-fest
demo conversion does (r=0.457) — meaning the fest amplifies what you already have rather than
creating it (Zukowski, 2025-03-26). Spending your one shot before you have anything to amplify
is the single most expensive mistake available in this plan.

---

## 2. Comparables

All figures read **2026-07-27**. Sales figures are third-party estimates unless marked
dev-stated. SteamDB was unreachable (403), so historical launch prices are thinner than
current prices.

| Game | Bucket | Launch → current price | Steam reviews | Sales | Demo → launch | EA? | Team / time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Stardew Valley** | solo survival-craft | $14.99 → $14.99 (never changed) | 1,027,417 / **98%** | 26M PC **[est]** | none | No | Solo, ~5 yr |
| **Dinkum** | solo survival-craft | ? → $19.99 | 29,008 / **92%** | 1M+ **dev-stated** | not found | Yes, Jul'22→Apr'25 | Solo, 8 yr to 1.0 |
| **Core Keeper** | small-team survival | ? → $19.99 | 65,735 / **94%** | ~2.0M **[est]** | **Next Fest Feb'22 → EA Mar'22 (~1 mo)** | Yes, →Aug'24 | ~6 → ~35 |
| **Death's Door** | 2-person Zelda-like | $19.99 → $19.99 | 21,810 / **93%** | 690K–1.1M **[est]** | not found | No | 2 + 2, ~6 yr |
| **Tunic** | solo-start Zelda-like | $29.99 → $29.99 | 18,083 / **91%** | 562K–891K **[est]** | **Next Fest Oct'21 → launch Mar'22 (~5.5 mo)** | No | 1 → ~6, ~7 yr |
| **CrossCode** | **JS web-tech** action-RPG | ? → $19.99 | 18,321 / **92%** | 500K–1M **[est]** | free browser build from Dec'14 | Yes, '15→'18 | ~7, ~7 yr |
| **shapez** | **JS + Electron** | $9.99 → $0.99 | 15,723 / **96%** | 200K–500K **[est]** | free browser game pre-dated Steam | Yes (2 wks) | Solo/small |
| **Unravel** | yarn aesthetic | $19.99 → $19.99 | 1,673 / **87%** | 200K–500K **[est]** | none | No | Small studio |
| **AI Roguelite** | live-LLM (cloud) | ? → $14.99 | 585 / **83%** | 100K–200K **[est]** | not found | Yes, '22→'23 | Solo |
| **Suck Up!** | live-LLM (cloud) | ? → — | 194 / **61% Mixed** | — | — | — | — |
| **Whispers from the Star** | live-LLM (cloud) | ? → — | 1,642 / 80%; **recent 30d 30%** | — | ~5 wks demo→launch | — | — |
| **inZOI** | **on-device LLM** | $39.99 EA | ~32,000 / **76%** | — | — | Yes | KRAFTON (large) |
| **Len's Island** | cautionary comp | ? → — | **82% all-time, 73% recent** | — | — | Yes, 1.0 Jun'25 | Small |

### What the data says

**Price.** Median launch price across the solo/small-team survival-craft and action-adventure
set is **$19.99** (range $10.99–$29.99); the 2024–26 launches specifically cluster
**$19.99–$24.99**. **No comp in the set shows a price being *too low* triggering distrust** —
shapez launched at $9.99 and sits at 96%. The failure mode at low prices is *scope mismatch*:
Desktop Heroes at $5.99 sits at 69% because *"conceptually it is a cool idea. In reality it's a
very barebones idler."* **[INFERRED]** Given this game's scope — open world, combat system,
NPCs, procedural score, world map — the brief's "≥$4.99 if ever charging" floor is roughly
**four times too low** and would actively signal a smaller game than you built. $19.99 is the
evidence-backed number; Tunic's $29.99 tier is backed by 7 years and 6 people by the end.

**Demo → launch gap.** Two patterns, both real: a discrete Next Fest push close to launch
(Core Keeper ~1 month, Tunic ~5.5 months) or a long-running free browser build predating Steam
by years (shapez, CrossCode — the closest structural precedents for web tech). Worth noting
honestly: **most of the successful solo comps had no discoverable public demo at all**
(Stardew, Dinkum, Necesse, Death's Door, Ocean's Heart). A demo helps; it is not a
precondition.

**Who launched free first.** Only the web-tech-origin ones — **Vampire Survivors** (itch free →
Steam EA ~$3–4 → 250,290 reviews / 98%), **shapez**, **CrossCode**. All three later charged
money with no visible backlash. **[INFERRED]** This is a web-tech *habit*, not a genre norm,
and all three did it on **itch or their own site**, not as a released free Steam app — which is
exactly the funnel recommended in §1.

**Is the yarn aesthetic a hook?** For press and awards, yes: Tearaway won Edge's Best Visual
Design plus 3 BAFTAs; Kirby's Epic Yarn and Yoshi's Woolly World reviews lead with the art.
Unravel's pull-quotes led with the *story*, not the material — the aesthetic sells the trailer
harder than it dominates final review copy. **The sharp risk:** both Yoshi's Woolly World and
Yoshi's Crafted World drew *"cute, but dull"* / too-easy criticism — **critics read a soft
craft aesthetic as a promise of low challenge.** This game has a parry/stamina system and a
boss. **[INFERRED]** the trailer and the first ten minutes must show *stakes*, or the aesthetic
will set an expectation the combat then violates. Separately: a direct search found **no live
yarn/wool/felt-aesthetic competitor on Steam** — open positioning space.

**Unpolished-despite-good-systems, the cautionary set.** Len's Island: *"the backbones of Len's
Island are fantastic, some of the best I have ever seen on a launch game"* undercut by *"the
game stutters horrendously… raw, unfinished, extremely unoptimized… the world feels extremely
empty"* — 73% recent against 82% all-time. Mist Survival, 8 years in EA, 64%: *"It has
potential, but it's massively unrealized."* **This is the exact shape of the risk this project
is in: correct systems, unfinished surface.**

**The LLM comps are the most useful rows in the table.** Suck Up! sits at **61% Mixed** not
because players disliked talking to AI but because of **cloud failure**: *"when i talk to
someone it tells me the servers are down, and it has STILL not been fixed."* Whispers from the
Star draws *"The guardrails really ruin the experience."* The only confirmed **on-device** comp,
inZOI, draws little review attention to the AI either way — bugs and performance dominate its
reviews instead. **[INFERRED]** Your fully-local architecture is structurally immune to the one
failure that demonstrably sank a comp. That is a genuine, defensible advantage — *and it
evaporates if an 11-second cold start reproduces "the AI is broken" from the player's side.*

---

## 3. The polish bar, ranked and scored against this game

### The mechanic that should set the whole strategy

> *"As long as your game's reviews are Mixed or above (40%+), review score is **not a factor**
> in algorithmic visibility. If your game dips below 40% into Mostly Negative, your game will
> be less likely to be featured."*
> — [partner.steamgames.com/doc/store/reviews](https://partner.steamgames.com/doc/store/reviews),
> read 2026-07-27 **[VERIFIED]**

Combined with two structural facts — Steam displays no score until **10 reviews**, and a small
game's early pool is thin enough that a handful of bug-driven negatives flips the aggregate —
the target is not "maximise review score." It is **"do not fall below 40% while accumulating
the first 500 reviews."** [ANALYST] benchmarks: a weak launch is <150 reviews in 30 days, and
of the games that launched weak in 2024, **only 28 recovered to 500+ reviews within a year**
(Zukowski citing VG Insights,
[howtomarketagame.com](https://howtomarketagame.com/2026/02/12/only-28-games-recovered-from-a-bad-launch-in-2024-what-do-they-have-in-common/),
2026-02-12). **You do not get a second launch.**

### The ranking

**1 — The first 20 minutes must contain nothing visibly broken. `[Ship-blocking]`**

Evidence: **[ANALYST]** median demo/session playtime is **14 minutes**, corroborated across two
independent Zukowski surveys three years apart (130 games, 2022-10-26; 26 games, 2021-11-08).
**[VERIFIED]** Rust's disclosed refund data shows the dominant self-reported refund reason was
literally *"Not Fun"* (~6% refund rate on 5M+ sales, Game Developer, 2017-06-28); No More
Robots' portfolio baseline is 5–8% units / 6.5–11% dollars with first-impression mismatch named
as the driver of variance (Carless, Game Developer, 2020-08-20).

Scored against this game: **rivers dry 96% of the time** and an **11-second cold start on the
first NPC conversation** both land inside the 14-minute window, and both sit on the two systems
the game is *sold* on — the world and the talking. Len's Island is the comp that shows what
this costs.

*Counter-evidence, stated:* in the one detailed case study found (Pathway's Mixed launch),
"technical difficulties" was the *least*-cited of five complaint reasons, behind grind and thin
content **[anecdote]**. Bugs are not guaranteed to be the top complaint by volume — but the
mechanism that hurts you (small-pool flip below 40%) does not require them to be.

**2 — Performance, and a graphics-settings tier that does not exist yet. `[Ship-blocking]`**

**[VERIFIED]** Steam Hardware Survey, June 2026
([store.steampowered.com/hwsurvey](https://store.steampowered.com/hwsurvey)): **≤4 GB VRAM
≈16.6%**, **≤6 GB ≈23.0%**, 8 GB is the single largest bucket at 25.6%, only ~33.7% have 16 GB+.
**DX12-capable is 91.74%** — the closest available proxy for WebGPU-capable, meaning roughly
**1 in 12 Steam machines may not clear your baseline API requirement** before any VRAM is
budgeted for a 1.1 GB model. **[ANALYST]** the median rig is getting *older*: the RTX 3060
retook the #1 GPU slot by March 2026 amid GPU/RAM price spikes (PCGamesN, 2026-04-02).

Scored against this game: `renderer.ts` fixes render resolution, three shadow cascades are
unconditional, and the post chain has no quality tiers (`PORTING.md` §3.4). **This is the same
work item the Deck tier already requires, and `PORTING.md` says explicitly it is cheaper to
build now than retrofit.** Do it once, bank it twice.

**3 — The LLM must never block, and must never look broken. `[Ship-blocking]`**

This is ranked third by general evidence and would be ranked first on comp-specific evidence:
**Suck Up! sits at 61% Mixed purely from infrastructure failure**, the single clearest
cause-and-effect in the comp set. **[VERIFIED, journalism]** Aftermath's hands-on with
Nvidia/Convai/Inworld AI NPCs documents the failure modes to design against: NPCs agreeing
verbally while the game state does nothing (*"continued to stand in one place, forever"*),
tone-deafness to hostile input, and the fact that every shipping demo sat on *heavy hand-authored
constraint* underneath the free-text illusion
([aftermath.site](https://aftermath.site/ai-npcs-nvidia-unity-ubisoft-convai-inworld/),
2024-03-28, updated 2025-10-27).

Concretely: pre-warm the session at world load rather than on first dialogue trigger; show an
immediate in-fiction "thinking" affordance so latency reads as character, not as a hang;
suggested topic chips so the text box is never blank (the blank-page problem — **[CRAFT]**, no
games-specific citation found); and keep the existing watchdog/fallback discipline this
project already established. **[INFERRED]** the 11 seconds may not need to *become* fast to stop
costing you reviews — it needs to stop being *dead air*.

**4 — The "expected features" floor: controller, remapping, options, icon. `[Cheap, do anyway]`**

**[CRAFT]** Missing standard features — control remapping, graphics options, controller support
— reliably generate specific, citable negative-review sentences, and *"just a few negative
reviews can turn you into the 'Mixed' or worse category"* for a small game (Zukowski,
2021-09-28). **Honest caveat:** the popular claim that most Steam players use a controller
**could not be verified** — Valve's Hardware Survey has no controller category at all
**[VERIFIED absence]**, and the only figures found were a 2020 relative-change statement and an
unsourced aggregate. Do not over-weight this on assumed controller share; do it because it is
cheap and its absence is quotable in a review.

**Sequencing warning from `PORTING.md` §2.5:** the browser Gamepad API may be **dead under Steam
Input on Chromium 114+**, and you are on 150. That makes controller support a *design decision
to test in week one*, not a late polish item — if it is broken you need native Steam Input over
IPC instead, which is architecture, not a patch.

**5 — Art-direction coherence (the castle reading as masonry, not craft). `[Gates the trailer]`**

Ranked fifth for *review impact* and first for *marketing*. **[CRAFT]** No review-mining study
isolates "art reads as generic" as a complaint category; the nearest evidence is Zukowski's
"jank" pattern in Mostly-Positive-but-doesn't-sell games (2024-07-23) and a small filmed study
where a participant wishlisted a game *because the capsule was "cute"* after ~13 seconds of
trailer **[anecdote]**. But §2 shows the craft aesthetic is what press leads with for every
comp in that bucket, and no competitor holds the ground. **[INFERRED]** the practical
consequence is a *sequencing* one: this must be fixed **before trailer capture**, because the
trailer is cut from the build, and a trailer that shows generic masonry is a trailer that
throws away your only unclaimed differentiator.

### Below the line — and why, honestly

- **Audio cohesion.** The **weakest-evidenced** category researched. No review-mining study,
  post-mortem, or GDC talk from 2023–26 was found isolating audio as a measured driver of
  perceived polish. **[CRAFT]** only. It is being fixed now anyway, which is fine — just do not
  believe it is buying review points.
- **Game feel / juice.** Evidence came back **weaker than the folklore**. No 2023–26 indie
  post-mortem quantifies it. The best-positioned analyst attributes BALL x PIT's jump from 477
  to 15,000+ reviews mainly to **genre/aesthetic fit with Steam's algorithm, not the juice**
  (Zukowski, 2025-12-01) — a direct counter-example. Cheap per hour, uncertain return; do it,
  do not let it displace 1–3.
- **Store assets / capsule optimisation.** You need a trailer, icon and capsule to *exist*. Do
  not optimise them: **[ANALYST]** capsule click-through-rate is a **weak-to-inverse** predictor
  of success — lower-traffic games in Zukowski's sample had *higher* CTR, and his explicit
  advice is to stop optimising for it (2022-09-14). This contradicts the brief's assumption
  that CTR data would show how much capsule quality matters.
- **Content depth.** Real and well-evidenced as a failure pattern, but open-ended and
  unbounded. Sequence after 1–4.

---

## 4. Playtest methodology — the protocol, not the theory

**Group size.** **[VERIFIED]** Nielsen's "5 users find ~85% of problems"
([nngroup.com](https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/), 2000)
with its own caveats: quantitative work needs ~20 (NN/g 2006), and a survey of 217 UX
professionals shows real practice averages **11** (NN/g 2012). The standard rebuttal (Sauro,
[measuringu.com](https://measuringu.com/five-users/), 2010) is that the *math* is fine but the
31% problem-frequency input is optimistic for a mature product; his fix is **several small
rounds**, not one big one. Games-specific **[VERIFIED]**: **6 players** to find problems (the
6th absorbs a no-show), 12 to define player types, 100 for a survey question
([gamesuserresearch.com](https://gamesuserresearch.com/how-many-players-do-i-need-for-a-playtest/)).
Valve's own cadence was weekly, from week one, with 100+ testers per Half-Life 2 level, under
the maxim *"it's not their fault, it's ours."*

**Recruiting, $0.** itch.io restricted build with revocable per-tester Download Keys + page
password **[VERIFIED]**; r/DestroyMyGame and r/playmygame for cold strangers; genre Discords;
your own Discord **only for round 2+** because *"your Discord community is not representative —
they're self-selected for liking your game already"* **[VERIFIED]**, good for bugs, useless for
"is this fun to a stranger." **Friends and family are the worst first testers** and should be
used only to catch total blockers before a stranger sees it **[CRAFT]**. Paid options you are
skipping, for reference **[VERIFIED pricing]**: PlaytestCloud €1,025+/month (but a **free trial
with 2 tokens** exists), User Interviews $49/session, Prolific ~$6–12 all-in per 20-minute
tester.

**The session (20–30 min, one at a time, Discord screenshare + local OBS):**

1. 1 min — consent: what is recorded, what is kept, how long. **This matters more than usual
   here** because your game logs free-text chat with an LLM; say explicitly whether transcripts
   are saved and why.
2. 1 min — concurrent think-aloud instructions: *"narrate what you're thinking; I won't help or
   answer questions until the end."* **[VERIFIED]** concurrent and retrospective think-aloud
   surface comparable problem counts (ACM meta-analysis,
   [dl.acm.org/doi/full/10.1145/3665327](https://dl.acm.org/doi/full/10.1145/3665327), 2024);
   concurrent is simpler solo.
3. 20 min — **do not help. Do not confirm or deny.** When asked, bounce it: *"What would you do
   if I wasn't here?"* Never ask a question that leaks the answer — the canonical bad question
   is *"How did you know that was the right way to go?"*, which tells them it was
   **[VERIFIED]**. **Treat silence as the signal**: a talkative player going quiet is the moment
   to timestamp.
4. 5 min — survey. The single most useful question **[VERIFIED]**: *"On a scale of 0–10, how
   likely are you to recommend this game to a friend?"* then *"why that score?"* — 9–10 promoter,
   6–8 **ignored** (*"a 7 or 8 is not promoting"*), 0–5 detractor. Rationale: *"People are nice
   and they will lie to you."* Optionally the 10-item SUS, where the cross-study average is
   **68** ([measuringu.com/sus](https://measuringu.com/sus/)).

**The watch-list [VERIFIED]** ([gamesuserresearch.com](https://gamesuserresearch.com/find-usability-issues-in-games-with-playtests/)):
did they do something you did not design for; did you have to intervene (any intervention is a
logged defect by definition); is it *blocking*; and **did they learn from it** — a repeat failure
on the same thing is a far stronger signal than a one-off stumble.

**The real pass/fail is revealed preference, not the survey:** if a tester asks to keep playing
past the 20 minutes, or returns unprompted the next day, that is your answer.

**LLM-specific instrumentation.** Log two things every session: **how long they stare at the
chat box before typing the first time**, and **how many jailbreak / break-character attempts they
make**. Expect the latter to be nonzero — that is not a bad tester, it is the most realistic
stress test you will get for free.

**Rounds.** **[CRAFT]** Three minimum before a public demo, with **fresh testers each round**
(a returning tester has already learned your UI and cannot tell you if the fix worked). Gate to
advance: no repeated-failure issue survives a round, and no 0–5 recommend score is given for a
*blocking* reason.

**Honest note on the evidence:** no controlled study links "amount of playtesting" to "review
score achieved" — I looked. The justification is the *player-behaviour* chain (unfixed confusion
in the first 20 minutes → the 14-minute median → the refund window → the 40% floor), which is
evidenced, rather than a direct correlation, which is not.

---

## 5. The LLM-NPC hook as positioning

### The verdict: do not lead with it

**[ANALYST, the strongest single study found]** An analysis of **53,597 Steam releases**
(mid-2023 → mid-2026) by Sulka Haro
([fragwyz.substack.com/p/three-years-of-ai-on-steam](https://fragwyz.substack.com/p/three-years-of-ai-on-steam),
2026-07-20): AI-disclosed games hit Steam's usual success benchmarks at **55% the rate** of
non-AI games; **87% of AI-disclosed games flop**, and of those, 72% use AI mainly for visuals
with terse disclosures (median **13 words**). Among the successful minority: **59% use
minimising language** ("supplementary", "assist"), **21% explicitly emphasise human oversight**,
and voice/localisation disclosures are *over*-represented versus the flop cohort.

**[VERIFIED by direct reads of live store pages, 2026-07-27]** Every successful AI-feature
comp's store copy follows the same pattern — AI is a *tool or a collaborator*, never the
headline. ARC Raiders does not mention AI in its description at all, confining it to the
disclosure: *"we may use procedural- and AI-based tools to assist with content creation. In all
such cases, the final product reflects the creativity and expression of our own development
team."* Book of Infinity: *"technology serves as a creative collaborator rather than a
replacement for human imagination."* Whispers from the Star pairs the claim with a human:
*"AI-powered conversations and performances created **in collaboration with an actor**."* The
sole exception is AI Roguelite (*"100% determined by artificial intelligence"*) — and only
because generative AI *is* its genre premise, which is not your case.

### The risk, sized honestly

- **Disclosure is mandatory and public.** You are **Live-Generated** — runtime generation,
  local or not. **[VERIFIED]** Valve requires you to describe *"guardrails you're putting on
  your AI to ensure it's not generating illegal content"*, the text appears on the public store
  page pre-purchase in a section titled "AI Generated Content Disclosure", **you write your own
  wording**, and Valve added an in-overlay player-reporting tool specifically for suspected
  illegal live-generated content
  ([contentsurvey](https://partner.steamgames.com/doc/gettingstarted/contentsurvey); Game
  Developer, 2024-01-10). Live-Generated **Adult Only sexual content is prohibited outright**.
- **Disclosure is now ordinary.** **[VERIFIED, live snapshot 2026-07-27]** **18,088** Steam
  products carry an AI disclosure (aitransparencyindex.com/stats), up from ~7,818 in mid-2025
  and ~1,000 in April 2024 — an ~18× rise in two years. **[ANALYST]** AI-disclosed titles are
  **30.8%** of 2026 releases. You would not be an outlier.
- **But your specific hook is genuinely rare.** Of those 18,088, only **621 (3.4%)** have live,
  runtime AI features at all — and **every** one I could identify is **cloud-based** (AI
  Roguelite → Gemini; Suck Up! → OpenAI; Whispers → cloud voice; Fortnite's Darth Vader → Google
  Cloud + Convai). A search for shipped commercial Steam games running a **local, offline,
  no-server** NPC LLM returned **zero** matches — only hobby repos. **[INFERRED, absence of
  evidence not proof of absence]** "No server, runs on your GPU, works offline forever" is
  unclaimed ground.
- **Players can filter you out — via a third party, not Valve.** **[VERIFIED]** SteamDB added an
  "AI Content Disclosed" tag (`tagid=-1368160`) letting users exclude AI-disclosed games
  (GamingOnLinux, 2025-02-25). **Valve has never shipped a native filter.** The Steam curators
  flagging AI content are small: "No AI" **1,057 followers**, "NO AI #HumanArtists" **256**
  (read 2026-07-27). Real, vocal, and not a distribution threat at that scale.
- **The backlash is about labour, not the technology.** **[VERIFIED]** GDC State of the Industry
  2026: **52% of developers** now say generative AI is bad for the industry, up from 30% — but
  **81% are fine with it for research/brainstorming** and opposition concentrates on **art,
  character design and narrative**, i.e. where it displaces a paid creative. The Fortnite Darth
  Vader precedent drew a **SAG-AFTRA labour complaint**, not a player-quality revolt. **[INFERRED]**
  A solo dev was never going to hire a cast to make every background villager freely
  conversable; that gameplay did not previously exist, so there is no displaced worker to point
  at. **Do not raise the labour question yourself** — you have no need to, and doing so invites
  precisely the hostility that is otherwise not aimed at you.
- **False-accusation risk exists regardless.** Blizzard was accused of AI art on Overwatch 2
  sprays it says were not AI **[VERIFIED]**. Your local architecture is a defence here: "no
  network calls" is a *checkable* claim in a way a cloud pipeline's provenance is not.
- **[ANALYST, weakly sourced — flagged]** A GameDiscoverCo-attributed figure claims the Steam AI
  tag correlates with **19% lower wishlist-to-sale conversion** alongside **68.6%** of surveyed
  players saying they "accept" AI content. I could not reach the primary newsletter; treat both
  as directionally suggestive only. If both are real they describe a **say/do gap** — and the
  behavioural number should outweigh the survey number.

### Store copy: use and avoid

**Use** — lead with the player-facing outcome: *"Every villager will actually talk back — about
anything."* Then, one line down, the mechanism *as a benefit*: *"Runs entirely on your own PC.
No server, no internet, nothing you say leaves your machine, no subscription — and it keeps
working if we disappear."* **[INFERRED]** this answers the two documented player fears (privacy;
dependency on a company's servers staying up) rather than boasting about technology, and it is
the one claim no cloud competitor can honestly make. In the disclosure itself, be **specific and
full** — name Qwen3-1.7B, Apache-2.0, on-device, and describe the actual guardrail — because the
data ties **terse** disclosures to the flop cohort.

**Avoid** — "AI-powered NPCs" as the first thing a browsing player sees; "chatbot"; any framing
that raises replacement-of-artists; and a one-line disclosure.

**One caveat I will not paper over:** the local/offline framing is **[UNVERIFIED]** as a
marketing tactic. I searched for audience reaction to privacy-positive local-AI framing and
found **nothing either way** — because essentially nobody has shipped and marketed this. You
would not be contradicting a known-bad pattern, but you cannot cite proof it works. It is a
hypothesis to test on the demo page, not an established win.

---

## 6. Month-by-month, with the cheapest experiment that falsifies each stage

Feature freeze is assumed in force from the start of M1.

| | Month | Goal | Cheapest falsifier |
| --- | --- | --- | --- |
| **M1** | **Aug 2026** | Fix the first 20 minutes: rivers, LLM pre-warm + thinking affordance + topic chips. Build the graphics-settings layer (render scale, cascades, post toggles) — banks the Deck work too. Run `PORTING.md` §6.1's **one-day Steam integration spike** (gamepad under Steam Input / overlay / floating OSK) because the answer changes the input architecture. **Decline Oct 2026 Next Fest** (deadline 31 Aug). | **One stranger, 20 minutes, think-aloud.** If they quit at minute 6, nothing else on this plan matters and you have learned it for $0. |
| **M2** | **Sep 2026** | Playtest **round 1** (5–6 cold strangers, itch restricted build) → fix → **round 2** (fresh testers). Controller path implemented per whatever the M1 spike proved. | Round 2 finds *different* problems than round 1. If it finds the *same* ones, your fixes do not work and rounds 3–n are wasted. |
| **M3** | **Oct 2026** | Playtest **round 3**. Expected-features floor: remapping, options, icon. **Art-coherence pass** on the castle/material language — this gates trailer capture. | A tester asks to keep playing past 20 minutes, unprompted. Zero out of six across three rounds = the loop is not there yet and the demo must wait. |
| **M4** | **Nov 2026** | Pay the **$100 Direct fee**, create the main app **paid + Coming Soon**. Store page: capsules, trailer cut from the now-coherent build, and the **full, specific AI disclosure**. Submit for review ≥7 days early. | Show the trailer and capsule to 10 strangers cold and ask what kind of game it is. If nobody says "handmade/craft/wool," the differentiator is not landing and the trailer is wrong, not the game. |
| **M5–M6** | **Dec 2026 – Jan 2027** | **Free Demo app live** (own store page, own App ID, links back to wishlist the paid game). This is where the free-first instinct gets satisfied — legitimately, and without spending the release event. Accumulate wishlists. | **Demo median playtime vs the 14-minute benchmark.** Below it, the demo is not ready for Next Fest and you roll to June 2027 rather than burn the one shot. |
| **M7** | **Feb 2027** | **Next Fest — only if the M5–M6 gate passed.** Otherwise June 2027. Leave the demo up afterwards (Valve encourages it). | The gate itself *is* the experiment. Refusing to enter is a valid, cheap outcome. |
| **M8–M9** | **Mar – Apr 2027** | **Paid launch decision, from evidence.** Default $19.99 per §2. Store page ≥2 weeks at Coming Soon; build review 3–5 business days. | Wishlist count at end of Next Fest + demo→wishlist rate. If the number is small, the correct move is another content/polish cycle, not a cheaper price. |

**The fallback that the corrected rule buys you.** Because **free→paid is explicitly permitted
on the same App ID**, and paid→free likewise, launching paid preserves *both* options. If the
paid launch underperforms, converting to free later is a supported, documented move requiring
one week's notice. **Starting free forecloses Next Fest permanently and converts your early
audience into permanent non-payers. Starting paid forecloses nothing.** That asymmetry, not the
app-ID folklore, is the actual argument.

---

## 7. What I could not verify — read before acting

1. **Whether a Demo or Playtest child app requires its own $100 Direct fee.** The fee doc does
   not mention demos or playtests at all. Check in Steamworks admin before budgeting. Materially
   affects M4.
2. **The Steam Distribution Agreement clause on releasing earlier on another platform.** Surfaced
   secondhand, agreement is login-gated. **Verify before publishing anything public on itch after
   the Steam page is live.**
3. **Whether reviews are wiped on a free→paid switch** (§1.4). Unsourced analyst claim. Cuts
   *for* free-first if true, which is why it must not be relied on.
4. **Whether demo wishlists count toward the base game's total.** [INFERRED] separate, from the
   per-App-ID cooldown language; no Valve sentence found either way.
5. **Popular Upcoming thresholds.** [ANALYST] Zukowski reports Valve raised it from ~7,000 to
   ~100,000 wishlists around June 2026 alongside a new "Personal Calendar" feature; the Valve
   announcement exists but its body could not be retrieved. **The folklore "7,000 wishlists"
   target may be ~10× stale.** Re-verify before setting a wishlist goal.
6. **February / June 2027 Next Fest dates.** Editions confirmed to exist in Steamworks
   navigation; dates not published on reachable pages. Check before committing M7.
7. **Current Steam controller-usage share.** Valve's Hardware Survey has no controller category.
   No trustworthy percentage exists. Do not justify controller work with an assumed share.
8. **No ranked breakdown of negative-review complaint categories exists** in anything reachable
   (GameDiscoverCo, VG Insights, howtomarketagame, academic review-mining). The §3 ranking is
   assembled from mechanism + adjacent data, not from a single authoritative study. Said plainly
   because this project's rule is that green-sounding claims are not evidence.
9. **No published data on what fraction of refunds occur in the first N minutes** — checked; not
   public.
10. **No 2023–26 source quantifies game feel or audio's effect on review score.** Both are
    **[CRAFT]** only, and §3 ranks them accordingly rather than deferring to folklore.
11. **The local/offline AI framing is untested** as marketing (§5). Hypothesis, not a finding.
12. **WebSearch was unavailable this entire session.** Community/forum sentiment is
    under-represented throughout. A second pass with search would most improve §3 (review-language
    evidence) and §5 (player reaction to local AI).

---

## Sources

**Valve primary** (all read 2026-07-27):
[Pricing](https://partner.steamgames.com/doc/store/pricing) ·
[Free to Play](https://partner.steamgames.com/doc/store/freetoplay) ·
[Applications](https://partner.steamgames.com/doc/store/application) ·
[Demos](https://partner.steamgames.com/doc/store/application/demos) ·
[Playtest](https://partner.steamgames.com/doc/features/playtest) ·
[Next Fest](https://partner.steamgames.com/doc/marketing/upcoming_events/nextfest) ·
[Wishlists](https://partner.steamgames.com/doc/marketing/wishlist) ·
[Reviews](https://partner.steamgames.com/doc/store/reviews) ·
[Steam Direct fee](https://partner.steamgames.com/doc/gettingstarted/appfee) ·
[Releasing](https://partner.steamgames.com/doc/store/releasing) ·
[Review process](https://partner.steamgames.com/doc/store/review_process) ·
[Content Survey](https://partner.steamgames.com/doc/gettingstarted/contentsurvey) ·
[Hardware Survey](https://store.steampowered.com/hwsurvey)

**Analyst / research:**
[Three years of AI on Steam](https://fragwyz.substack.com/p/three-years-of-ai-on-steam) (Haro, 2026-07-20) ·
[AI Transparency Index](https://aitransparencyindex.com/stats) (2026-07-27) ·
[Only 28 games recovered](https://howtomarketagame.com/2026/02/12/only-28-games-recovered-from-a-bad-launch-in-2024-what-do-they-have-in-common/) (2026-02-12) ·
[Itch.io traffic benchmark](https://howtomarketagame.com/2025/05/12/benchmark-itch-io-traffic/) (2025-05-12) ·
[Don't make your game free](https://howtomarketagame.com/2025/07/29/dont-make-your-game-free/) (2025-07-29) ·
[Median demo playtime](https://howtomarketagame.com/2022/10/26/what-is-a-good-median-play-time-for-a-demo-benchmark/) (2022-10-26) ·
[Favourite playtest question](https://howtomarketagame.com/2021/06/28/my-favorite-question-to-ask-play-testers/) (2021-06-28) ·
GameDiscoverCo wishlist-conversion benchmarks (Carless)

**Games UR / usability:**
[gamesuserresearch.com](https://gamesuserresearch.com/how-many-players-do-i-need-for-a-playtest/) (playtest size, moderation, surveys, secrecy) ·
[NN/g 5 users](https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/) ·
[Sauro rebuttal](https://measuringu.com/five-users/) ·
[SUS](https://measuringu.com/sus/) ·
[ACM think-aloud meta-analysis](https://dl.acm.org/doi/full/10.1145/3665327) (2024) ·
[itch.io access control](https://itch.io/docs/creators/access-control)

**AI-in-games reception:**
[Aftermath — AI NPCs hands-on](https://aftermath.site/ai-npcs-nvidia-unity-ubisoft-convai-inworld/) (2024-03-28, upd. 2025-10-27) ·
GDC State of the Industry 2026 (via WinBuzzer, 2026-03-23) ·
GamingOnLinux on the SteamDB AI filter (2025-02-25) ·
Game Developer on Valve's AI disclosure policy (2024-01-10)

**In-repo:** `docs/PORTING.md` (platform engineering, §2.5 gamepad risk, §3.4 graphics settings,
§6.1 the one-day spike) · `docs/AI_GUARDRAILS.md` (the Content Survey answer) ·
`docs/AI_MODEL_LICENSING.md` · `docs/RECTIFICATION_PLAN.md` (the art backlog) ·
`docs/AI_TRANSPARENCY_GAP_ANALYSIS.md` (EU AI Act Art. 50)
