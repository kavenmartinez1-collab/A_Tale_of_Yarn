# MECHANICS.md — Design Reference Compendium

This document records concrete mechanics researched from four reference games and maps each to the numbers adopted for Artifex. It is a living reference feeding Phases E–N of the expansion plan; each "Adopted for Artifex" entry cites the plan phase that owns implementation.

---

## 1. Minecraft

### Horse taming (temper model)

| Parameter | Value |
|---|---|
| Temper range | 0–100 |
| Mount attempt on untamed horse | 50 % chance of buck |
| Temper gain per buck | +5 |
| Temper gain from feeding (sugar / wheat) | +3 |
| Temper gain from feeding (golden apple) | +17 |
| Tamed threshold | temper ≥ tame_threshold (random 0–99 per horse) |

- Repeated feeding + mounting raises temper until it crosses the hidden threshold.
- Once tamed the horse accepts a saddle and the rider can steer.

### Animal drop tables

| Animal | Drops |
|---|---|
| Cow | 0–2 leather, 1–3 raw beef |
| Pig | 1–3 raw porkchop |
| Chicken | 0–2 feathers, lays egg every 5–10 min |
| Sheep | 1 wool (or 1–3 with shears) |

### Tool and armor material tiers

| Tier | Tools | Armor DR | Notes |
|---|---|---|---|
| Wood | Harvestable only | 1 point (helm) | Lowest durability |
| Stone | +1 durability over wood | 1 point | — |
| Iron | Mid durability | 2–3 points/piece | Gate: iron ore |
| Diamond | Highest durability | 3 points/piece | Late game |

- Armor points absorb a percentage of incoming damage.
- Each additional point of protection reduces damage by ~4 % (approximately).

### Food values (hunger saturation)

| Food | Hunger restored |
|---|---|
| Steak | 8 |
| Bread | 5 |
| Cooked porkchop | 8 |
| Raw meat | 3 |
| Berries | 2 |

### Campfire and torch recipes

| Item | Ingredients |
|---|---|
| Campfire | 3 logs + 3 sticks + 1 coal |
| Torch (×4) | 1 stick + 1 coal |

### Lightning

- Thunderstorms spawn at random (weather system).
- Lightning strikes can ignite wooden blocks and transform mobs (villager→witch, pig→zombie piglin).
- Lightning rods redirect strikes to themselves within 128 blocks.
- Metal armour does **not** attract lightning in vanilla MC (contrast BOTW below).

### Villager reputation / gossip

- Each villager tracks a per-player reputation (−100 to +100).
- Trade prices scale: positive rep = discounts, negative = markups.
- Hitting or killing a villager/iron golem broadcasts negative gossip to other villagers in range.

---

## 2. The Legend of Zelda: Breath of the Wild

### Temperature bands

| Band | Condition |
|---|---|
| Freezing | High altitude, cold biome without protection |
| Cold | Cold biome, night in temperate |
| Temperate | Default |
| Hot | Desert |
| Scorching | Volcano / extreme desert |

**Critical design rule — MAX not SUM:** protection counters use the strongest single source per category (cold resist OR heat resist), not an additive sum across different sources. Wearing a Warm Doublet gives +1 cold resist; also holding a torch gives another +1 cold resist — but the effective level is MAX(1, 1) = 1, not 2. Sources within the same category do not stack. Heat resist and cold resist are separate categories and do not cancel each other.

### Stamina wheel

| Action | Drain rate |
|---|---|
| Sprinting | Continuous drain |
| Climbing (per metre) | Fixed cost per vertical metre |
| Swimming | Continuous drain |
| Rain on climbable surface | Surfaces become slippery; player slides back without stamina overhead |

- Stamina regenerates fully when no draining action is taken.
- Stamina exhaustion stops climbing/swimming immediately (slide back on walls).

### Cooking — effect classes

| Class | Ingredient trigger | Effect |
|---|---|---|
| Hearty | Hearty radish / big hearty radish | Bonus hearts (yellow overshield) |
| Energizing | Stamella mushroom / courser bee honey | Stamina restore |
| Enduring | Endura carrot / endura shroom | Bonus stamina (ring extension) |
| Spicy | Sizzlefin trout / warm pepper (= cold resist) | Cold protection |
| Chilly | Cool safflina / chillshroom (= heat resist) | Heat protection |
| Mighty / Tough / etc. | Other ingredients | Attack / defence buffs |

**One effect class per dish**: mixing two different effect classes cancels both, yielding a plain dish. More ingredients of the same class = stronger potency or longer duration.

### Horse taming (BOTW)

| Parameter | Value |
|---|---|
| Soothe presses (wild horse) | 15–30 L-presses depending on horse quality |
| Gentle coat horses | Tame with fewer presses |
| Wild solid-coat horses | More presses required |
| Bond level | 0–100, grows with riding, feeding, and soothing |
| Max bond | Allows special manoeuvres, better stamina bar |

### Metal equipment and lightning

- During thunderstorms, metal weapons/armour attract lightning strikes to the player.
- Damage = lethal without Rubber Armour.
- Safe strategy: swap to wooden weapons and unequip metal armour before exposed travel.

---

## 3. The Elder Scrolls V: Skyrim

### Crime bounty table (per-hold)

| Crime | Bounty added |
|---|---|
| Theft (small item) | ~25 gold (scales with item value) |
| Horse theft | 50 gold |
| Assault (NPC not killed) | 40–200 gold (severity-dependent) |
| Murder | 1 000 gold |
| Escaping jail | 100 gold |

- Bounties are tracked **per hold ledger** — a bounty in Whiterun does not affect Riften.
- Witnessed crime = a hold guard or civilian NPC observes the act; pickpocketing in an empty room generates no bounty.

### Guard arrest dialogue

When a guard detects a player with bounty > 0 in the hold:

1. **Pay bounty** — gold deducted, bounty cleared, stolen tag removed from goods.
2. **Go to jail** — teleport to hold jail, sentence timer begins.
3. **Resist arrest** — guard attacks; killing a guard adds murder bounty on top.

### Jail system

| Outcome | Consequence |
|---|---|
| Serve full sentence | Time skip; belongings placed in evidence chest; bounty cleared |
| Escape via lockpick | Keep all belongings; bounty remains; escape bounty added (+100) |
| Evidence chest confiscation | All flagged stolen items removed on sentence served |

- Skilled lockpicking can open the jail door and recover belongings from the evidence chest.

### Merchant gold pools

- Each merchant has a fixed gold pool (100–10 000 depending on type).
- Pool restocks on a 2-day in-game timer.
- Trading training or Investor perk raises the cap permanently.

### Dragons (behaviour reference)

- Fly a circling approach loop before landing to attack.
- Shoutable at range; breathe fire/frost in sweeping arcs.
- Drop dragon soul (absorb) + bones + scales.

### Survival Mode (DLC)

Adds three secondary vital meters:
- **Hunger** — drains over time; eating restores.
- **Cold** — drains from altitude, weather exposure, water immersion.
- **Fatigue** — drains from activity; rest restores.

---

## 4. RuneScape (OSRS / RS3 shared mechanics)

### Material tier ladders

**Woodcutting (log grades):**

| Log type | Level | Notes |
|---|---|---|
| Normal | 1 | Most common |
| Oak | 15 | — |
| Willow | 30 | — |
| Maple | 45 | — |
| Yew | 60 | Slow chop, high value |

**Ore → Ingot smelting (at furnace):**

| Output ingot | Inputs | Smithing level |
|---|---|---|
| Bronze | Copper ore + Tin ore (1:1) | 1 |
| Iron | Iron ore (×1, ~50 % success) | 15 |
| Steel | Iron ore + Coal (×2) | 30 |
| Mithril | Mithril ore + Coal (×4) | 50 |

**Key design principle:** Bronze is explicitly a *two-ore alloy* — copper + tin — matching real metallurgy. This makes early mining require sourcing two ore types.

### Smithing

Smelt ingots at furnace → smith at anvil into bars → weapons/armour. Each stage costs "bar" units (e.g., iron platebody = 5 iron bars).

### Leatherworking chain

```
Cowhide → Tanner (NPC, small fee) → Leather
Leather + Needle + Thread → Leather armour pieces
```

- Tanning requires an NPC tanner, not a crafting bench; or a crafting urns/portable.
- Needle and thread are consumed (thread) or last many uses (needle).

### Wool chain

```
Sheep → Shear (shears item) → Wool
Wool → Spinning wheel → Ball of wool
```

### Fletching chain

```
Logs → Knife → Arrow shafts (×15 per log)
Arrow shafts + Feathers → Headless arrows
Headless arrows + Arrowheads → Arrows

Logs + Knife → Unstrung bow (u)
Unstrung bow + Bowstring → Strung bow

Flax → Spinning wheel → Bowstring
```

**As shipped, arrows are not part of this chain.** The only ammunition in the
game is the **Tintreach** quiver (Irish *tintreach*, lightning): one per save
file, granted with the character, and impossible to craft, loot, buy or drop a
second of. It is hitscan — the bolt reaches the crosshair in the frame it is
loosed — and it never empties. Arrow shafts survive as a trade good and a
crafting input. See `src/game/tintreach.ts`.

### Firemaking

```
Logs + Tinderbox → Fire (placed on ground)
```

Higher log grades take longer to light; no furnace required for fire.

### Herblore (potion-making)

```
Grimy herb → Clean herb (skill check)
Clean herb + Water vial → Unfinished potion
Unfinished potion + Secondary ingredient → Finished potion
```

Each herb unlocks a potion type at a threshold herblore level.

### Cooking

- Cook on fire or kitchen range.
- Higher cooking level reduces burn chance per food type.
- Each food has a stop-burning level above which burns never occur.

---

## 5. Adopted for Artifex

The following table maps the reference mechanics above to the concrete numbers and rules locked in the expansion plan. Column "Phase" cites the plan phase that implements it.

### Vitals (Phase G)

| Stat | Range | Drain / Regen | Notes |
|---|---|---|---|
| HP | 0–20 (10 hearts) | damagePlayer() calls only | No passive drain |
| Thirst | 0–100 | −1.2 / min; faster in desert | Zero thirst → periodic HP damage |
| Temperature | −3..+3 | Biome + modifiers | Out-of-band → periodic HP damage |
| Stamina | 0–100 | −20/s climbing >42°; −15/s sprint; +12/s after 1.5 s idle | Exhausted = slide back / no climb |
| Food | instant heal | No hunger bar | BOTW model: eating = direct HP |

### Temperature system (Phase G) — BOTW max-not-sum

| Source | Contribution |
|---|---|
| Biome base heat/cold | +/− (varies by biome) |
| Altitude | −0.015 per metre above 20 m |
| Night | −0.5 |
| Campfire within 6 m | +1.2 |
| Held torch | +0.3 |
| Fiber tent | +0.5 warmth |
| Wool tent | +0.8 warmth |
| Hide tent | +1.1 warmth |
| Armor totalWarmth | per-armor field |

**Rule:** cold-resist sources use MAX (strongest wins); heat-resist sources use MAX. They are separate axes and do not cancel.

### Climbing (Phase G)

| Condition | Stamina drain |
|---|---|
| Slope > 42° | 20 / s |
| Slope > 42° while holding oak_staff | 14 / s |
| Sprint (flat) | 15 / s |
| Regen delay | 1.5 s after stopping |
| Exhausted state | Slide back; climbing blocked |

### Taming (Phase K) — MC temper model

| Parameter | Value |
|---|---|
| Tameness range | 0–100 |
| Untamed mount attempt buck chance | 50 % |
| Tameness gain per buck | +5 |
| Tameness gain per feeding (favorite food) | +8 |
| Tamed threshold | ≥ 80 |
| Commons (horse / cow / donkey) | Mount instantly (no taming needed) |
| Wild / rare creatures | Require taming |

### Eggs & babies (Phase K)

| Step | Trigger | Time |
|---|---|---|
| Egg placed near lit campfire | heatT accrues | — |
| Egg hatches → owned baby | heatT = 120 s | 2 min |
| Baby → adult | growthT | ~20 min real time |
| Feeding baby | Accelerates growthT | — |
| Grown dragon / griffin | Mountable (dragon ground-ride only; DRAGON_FLIGHT_ENABLED = false) | — |

### Lightning (Phase I)

| Case | Outcome |
|---|---|
| Strike hits tree | Tree enters BurningTree state for 45 s |
| Strike hits exposed player (no canopy / roof / tent) | 50/50: damagePlayer(20) = death, OR survive clamped to 2 hearts (hp = 4) |
| Player wearing metal armor | Slightly raised strike odds (BOTW nod) |
| Safe shelter | Under tree canopy, inside tent, inside building |

### Crime & bounty (Phase M) — Skyrim per-ledger model

| Crime | Bounty added |
|---|---|
| Theft | 25 gold |
| Horse theft | 50 gold |
| Assault | 200 gold |
| Murder | 1 000 gold |
| Kill owned animal | 30 gold |
| Escape jail | 100 gold |

- **Witness rule:** NPC within 30 m + line of sight at moment of act.
- Mounting an NPC-owned horse with a witness present = `horse_theft` → owner aggro + bounty.
- **Arrest panel options:** pay bounty / go to jail / resist.
- **Jail:** sentence timer; serving = ALL inventory confiscated + spawn kit re-granted.
- **Escape:** `rusty_key` in jail cell; escape keeps inventory; +100 escape_jail bounty.

### Crafting stations (Phase E)

| Station | How available |
|---|---|
| hand | Always |
| fire | Near placed campfire |
| forge | Near forge (campfire + stone upgrade) |
| fire + cooking_pot | fire station + cooking_pot in inventory |

### Material tiers (Phase E) — RS bronze-as-alloy model

| Ingot | Inputs | Station |
|---|---|---|
| copper_ingot | copper_ore × 1 | forge |
| tin_ingot | tin_ore × 1 | forge |
| bronze_ingot | copper_ingot + tin_ingot | forge |
| iron_ingot | ore × 1 | forge |

Iron tools are **forge-gated** (matching the plan's intent that early gear is bronze/wood, mid-game is iron).
