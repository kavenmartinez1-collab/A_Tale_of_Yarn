# MUSIC_HOOK — wiring `src/game/music/` into the game

I own `src/game/music/**` and its scripts. I have not touched `main.ts`,
`audio-engine.ts`, or any UI file. This is the complete set of changes needed
to make the music audible, written so it can be applied mechanically.

Line numbers are against the working tree as of this writing; anchor on the
quoted code, not the numbers.

---

## 1. `GameAudio` must expose its context and master bus

`src/game/audio/audio-engine.ts` creates the `AudioContext` lazily inside
`resume()` (line ~209) and keeps both `ctx` and `masterGain` **private**. The
music engine needs the context and a node to land on. Add two getters to
`class GameAudio`:

```ts
  /** The live context, or null before the first user gesture. */
  get context(): AudioContext | null { return this.ctx; }
  /** The master bus every source lands on. Null until resume(). */
  get master(): GainNode | null { return this.masterGain; }
```

Nothing else in `audio-engine.ts` changes. Routing music through `masterGain`
means the existing `M` mute key and `audio.setVolume()` cover music too, and
the music bus's own volume sits underneath as an independent trim.

---

## 2. Construct the engine when audio resumes

`main.ts:946` builds `const audio = new GameAudio();` and `resumeAudio()` at
:958-962 is the only place the context can exist. Add the import next to the
existing audio import at :193:

```ts
import { createMusic, type MusicEngine, type MusicState } from './music';
```

Then, inside `resumeAudio()`:

```ts
  let music: MusicEngine | null = null;
  function resumeAudio() {
    if (audioResumed) return;
    audioResumed = true;
    audio.resume();
    const actx = audio.context;
    const master = audio.master;
    if (actx && master) music = createMusic(actx, WORLD_SEED, { destination: master });
  }
```

`WORLD_SEED` is already in scope. Seeding from it means a given world always
has the same score — the same property every other generated thing here has.

---

## 3. The one per-frame call

`main.ts:9711` is `function tick(now: number)`. The fixed-step loop runs
9740-10029; the **once-per-frame** section is 10031-10643. Insert at **line
10178**, immediately after `wx` is computed and immediately before the existing
`// Feature 10: per-frame ambience + SFX wiring` block:

```ts
    music?.update(musicState(tod, wx, paused), now / 1000);
```

That is the whole per-frame cost: measured at **0.019 ms mean in Chrome**, and
0.0029 ms mean / 0.069 ms p99 / 0.265 ms max in Node against the offline shim.
Budget was 0.5 ms.

Three things about placement:

- **`now / 1000`, not `simTime`.** `now` is the `tick` parameter, a
  `performance.now()` millisecond value in the same domain as
  `AudioContext.currentTime`. `simTime` freezes while paused, and the music
  must keep running under the pause menu.
- **Outside the `if (!isDead && !paused)` gate** at :10182. The ambience call
  is deliberately gated; music is not. Pause is passed *into* the state instead.
- Everything it needs is already in scope at that line: `tod` (:10175),
  `wx` (:10177), `paused` (:9716), `controller.pos`, `dungeonManager`,
  `buildingManager`, `castleManager`, `settlementManager`, `meleeTokens`,
  `lockOnId`.

---

## 4. Deriving the state

Add this helper near the other per-frame helpers in `main.ts`:

```ts
  function musicState(tod: number, wx: Weather, paused: boolean): MusicState {
    // Interiors FIRST. Dungeon and building interiors move the controller into
    // an arena at y = -300 whose x/z are unrelated to world space (main.ts
    // :10013-10018), so any XZ test below would be reading garbage.
    const region: MusicState['region'] =
      dungeonManager.isInside ? 'dungeon'
      : buildingManager.isInside ? 'interior'
      : castleManager.collider.inFootprint(controller.pos[0], controller.pos[2]) ? 'castle'
      : nearestSettlementKind() ?? 'wilds';

    const intensity: MusicState['intensity'] =
      castleManager.hostile ? 'boss'
      : (meleeTokens.heldCount > 0 || lockOnId !== null) ? 'combat'
      : lockOnId !== null ? 'alert'
      : 'calm';

    return { region, intensity, tod, weather: wx.rainLevel, paused };
  }
```

with

```ts
  /** 'village' when standing inside a settlement's radius, else null. */
  function nearestSettlementKind(): 'village' | null {
    const site = settlementManager.findNearestSite(controller.pos[0], controller.pos[2], 2);
    if (!site) return null;
    const dx = controller.pos[0] - site.x;
    const dz = controller.pos[2] - site.z;
    const r = SETTLEMENT_RADIUS[site.kind];
    // ruins and ranches are too small to earn their own cue; they read as wilds.
    if (dx * dx + dz * dz > r * r) return null;
    return site.kind === 'village' || site.kind === 'town' ? 'village' : null;
  }
```

`SETTLEMENT_RADIUS` comes from `./settlement/settlement-scatter`
(`{ ruins: 10, ranch: 20, village: 28, town: 40, castle: 68 }`).

### API notes, all verified against the tree

| need | expression | source |
|---|---|---|
| in a dungeon | `dungeonManager.isInside` | getter, `dungeon-manager.ts:230` |
| in a building | `buildingManager.isInside` | getter, `building-manager.ts:424` |
| in the castle | `castleManager.collider.inFootprint(x, z)` | `castle-collider.ts:167` |
| nearest settlement | `settlementManager.findNearestSite(x, z, rings)` | `settlement-manager.ts:477` — use this, **not** `nearestSettlement()`, which resolves a full settlement layout and is too heavy per-frame |
| attack token held | `meleeTokens.heldCount > 0` | `attack-tokens.ts:348` |
| lock-on active | `lockOnId !== null` | closure var, `main.ts:8583` |
| boss | `castleManager.hostile` | getter, `castle-manager.ts:328`, equals `state.alarm === 'hunting'` |
| tod | already computed at `main.ts:10175` | |
| weather | `wx.rainLevel` (0..1) | `weather.ts:18` |
| pause menu | `panels.openId === 'pause'` | the only writer of `simClock.setPaused`, `main.ts:7081`. `paused` at :9716 is equivalent here |

### Known gap: dungeon melee does not raise intensity

The overworld pool is `meleeTokens` (`main.ts:1059`). The dungeon has its own
pool at `dungeon-combat.ts:210`, held behind `private readonly combat` in
`DungeonManager` with **no public accessor**. Underground fights will therefore
read as `calm` unless a passthrough is added:

```ts
  // src/game/dungeon/dungeon-manager.ts
  get meleeHeld(): number { return this.combat.tokens.heldCount; }
```

and then `(dungeonManager.isInside ? dungeonManager.meleeHeld : meleeTokens.heldCount) > 0`.
That file is not mine to edit. Flagging, not fixing.

Also note the `intensity` ladder above never yields `'alert'` — combat and
alert both key off `lockOnId`. If you want a real alert tier, the natural
signal is "a hostile is aware of you but no token is held"; I left the branch in
place so it is one condition away. `'alert'` is fully implemented on the music
side.

---

## 5. Volume and ducking

**Bus name: `music`.** Agreed with the UI agent.

```ts
music?.setVolume(v);   // 0..1, the Settings slider
music?.duck(amount);   // 0 = unducked, 1 = fully ducked (-12 dB)
```

`duck(amount)` takes the **amount of ducking**, not the resulting gain. Call
`duck(1)` when an NPC starts speaking and `duck(0)` when they stop; the bus
handles the shape (120 ms down, 400 ms back up). It is idempotent, so calling
it every frame with the current value is fine.

There is currently **no settings UI at all** — `audio.setVolume` has zero call
sites and `src/game/ui/` has no volume control. Whoever builds it should write
to both `audio.setVolume` (sfx/ambience) and `music.setVolume` (music).

Persist under `artifex-music-volume:v1` to match the `artifex-audio-muted:v1`
convention at `main.ts:948`.

---

## 6. What the engine guarantees

- Never allocates per frame in the common case; schedules ~0.5 s ahead.
- Never touches the WebGPU queue.
- Never calls `Math.random()` or `Date.now()`.
- Never stops or disconnects a sounding voice, so no note is ever cut.
- Survives a backgrounded tab: a clock jump > 1.5 s resyncs the bar grid
  instead of scheduling the missing bars.
- Safe to call `update()` before the first bar, at any frame rate, with any
  state, including state that changes every frame.

---

## 7. The soundtrack — the developer's own recordings

Four compositions by Kaven Martinez now play through this engine as decoded
buffers, on the layer seam `layer.ts` always described. **This needs no wiring
changes at all** — no new call, no new state field, no `main.ts` edit beyond
what §1–§5 already describe. It is entirely inside `music.update(state, nowS)`.

### What plays where

| region | what | how |
|---|---|---|
| wilds, village | `500nanometers` → `Ryan's song A` → `Ryan's song B`, cycling | an interlude every ~4 min of bed (240 s ± a seeded 40 s jitter) |
| dungeon | `Untitled Song` | on entry, looped seamlessly (bars 3→29, 1.043 s crossfade) |
| castle | `Castle Vhaeron` | on entry |
| interior | nothing — the procedural bed only | |

### Assets

`models/music/` holds the vendored copies (**21.04 MB**, the depot delta),
produced from the gitignored `music-src/` masters by:

```
npx tsx scripts/prepare-music.mts
```

They are served over the path both servers already answer —
`/api/hf-cache/local/music/resolve/main/<file>` — so neither `dev-server.ts`
nor `app/steam/local-server.cjs` needed a change. `pack-steam.mjs` copies the
directory explicitly (its `d.includes('--')` rule is about HuggingFace repo ids
and would have dropped it silently) and refuses to build a depot without it.

Decoding is lazy and non-blocking: `decodeAudioData` per region, on first
schedule or first entry, cached. **A track that fails to load is never
scheduled and the procedural bed simply keeps playing** — there is no code path
where music stops because a file was missing or slow.

### Two things worth knowing if you touch this

**The keys are not what the brief assumed.** Measured: 500nanometers is F
minor, Ryan's song E-flat minor, Untitled Song C major, Project 1 A/E. They do
not share a tonic, so the bed's D is unchanged and the pad instead *modulates
into each song's key* for the handoff, as an open fifth. The full measurement
and reasoning is in the `KEYS` block at the top of `songs.ts`. Do not "fix"
this by retuning the engine.

**`duck()` still means speech.** Combat and boss intensity duck the song on a
separate bus trim (`SONG_DUCK_FLOOR`), so a fight and an NPC talking do not
fight over the same gain node. Nothing external needs to call it.

---

## 8. Verify after wiring

```
npx tsx scripts/test-music.mts                 # 290 assertions, ~35 s
npx tsx scripts/prepare-music.mts              # vendors + measures the soundtrack
npx tsx scripts/render-music-integration.mts   # 5 demonstration WAVs + index.html
npx tsx scripts/export-music-midi.mts          # 140 .mid stems + README
npx tsx scripts/render-music-audition.mts      # 17 WAVs + index.html (needs Chrome)
```

`render-music-integration` is the one a human should actually listen to:
`scripts/shots/music-integration/index.html`. Its gates only prove nothing is
broken — whether the handoffs *flow* is a listening judgement.
