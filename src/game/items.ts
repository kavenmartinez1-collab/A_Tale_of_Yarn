/**
 * Item definitions — the single registry for everything that can sit in an
 * inventory slot. Superset of the Director's KNOWN_ITEMS (dungeon loot) plus
 * game-only items: spawn-kit tools, gathered materials, food, armor, and crafted gear.
 *
 * `held` names the mesh archetype drawn in the character's right hand when
 * equipped (D-M3). `tool` marks what resource nodes the item can harvest
 * (E-M2). `stack` is the max per slot (1 = unstackable).
 *
 * Phase-E additions:
 * `edible`      — hearts*2 healed on eat (instant, BOTW-style).
 * `drinkable`   — thirst points restored on drink/fill.
 * `warmth`      — temperature contribution (BOTW max-not-sum) when worn/held.
 * `armor`       — equip slot + defense rating (handled by inventory armor slots).
 * `fuel`        — seconds of campfire burn when used as fuel.
 * `throwable`   — can be thrown as a simple arc projectile.
 * `effectClass` — timed effect applied on consumption (potions / dishes).
 */

/**
 * `shield` is its own kind rather than `armor` because a shield is never WORN.
 * Armour lives in the three equip slots and applies its defence passively; a
 * shield sits in the hotbar beside your weapon and only does anything while you
 * hold the block input. Calling it armour would have put it in the equip UI,
 * where it would have been a fourth passive defence rating and not a shield at
 * all. See `combat/shields.ts`.
 */
export type ItemKind = 'weapon' | 'tool' | 'material' | 'consumable' | 'loot' | 'armor' | 'container' | 'shield';
export type HeldKind = 'sword' | 'axe' | 'pickaxe' | 'bow' | 'staff' | 'torch';
export type ToolKind = 'axe' | 'pickaxe';
export type ArmorSlot = 'head' | 'body' | 'legs';
export type EffectClass = 'heal' | 'warm' | 'cool' | 'stamina';

export interface ItemDef {
  name: string;
  kind: ItemKind;
  /** Icon / held-mesh tint, linear RGB. */
  color: [number, number, number];
  /** Max per slot. */
  stack: number;
  /** What this item can harvest (E-M2 gathering). */
  tool?: ToolKind;
  /** Right-hand mesh archetype when equipped (D-M3). */
  held?: HeldKind;
  /** Hearts*2 healed on eat (instant, BOTW-style). */
  edible?: { heal: number };
  /** Thirst points restored on drink/use. Empty/full state tracked in Phase H. */
  drinkable?: { quench: number };
  /** Temperature contribution (BOTW max-not-sum) when worn/held. */
  warmth?: number;
  /** Equip slot and defense rating (used by inventory armor system). */
  armor?: { slot: ArmorSlot; defense: number };
  /** Seconds of campfire burn when used as fuel (Phase H). */
  fuel?: number;
  /** Can be thrown as a simple arc projectile (Phase H). */
  throwable?: boolean;
  /** Timed effect applied on consumption — potions and dishes. */
  effectClass?: EffectClass;
}

export const ITEM_DEFS = {
  // --- Director loot (KNOWN_ITEMS in dungeon-spec.ts) ----------------------
  gold_small:    { name: 'Gold Coins',    kind: 'loot',      color: [0.85, 0.68, 0.21], stack: 99 },
  gold_large:    { name: 'Gold Pile',     kind: 'loot',      color: [0.92, 0.75, 0.25], stack: 99 },
  healing_herb:  { name: 'Healing Herb',  kind: 'consumable', color: [0.35, 0.65, 0.30], stack: 20, edible: { heal: 2 } },
  iron_sword:    { name: 'Iron Sword',    kind: 'weapon',    color: [0.70, 0.72, 0.76], stack: 1,  held: 'sword' },
  ancient_relic: { name: 'Ancient Relic', kind: 'loot',      color: [0.55, 0.45, 0.75], stack: 1  },
  torch_oil:     { name: 'Torch Oil',     kind: 'loot',      color: [0.60, 0.50, 0.25], stack: 20 },
  old_bone:      { name: 'Old Bone',      kind: 'loot',      color: [0.85, 0.82, 0.72], stack: 20 },
  rusty_key:     { name: 'Rusty Key',     kind: 'loot',      color: [0.55, 0.38, 0.25], stack: 1  },
  iron_axe:      { name: 'Iron Axe',      kind: 'tool',      color: [0.66, 0.68, 0.72], stack: 1,  tool: 'axe',      held: 'axe'     },
  hunter_bow:    { name: 'Hunter Bow',    kind: 'weapon',    color: [0.48, 0.34, 0.20], stack: 1,  held: 'bow'     },
  oak_staff:     { name: 'Oak Staff',     kind: 'weapon',    color: [0.52, 0.38, 0.22], stack: 1,  held: 'staff'   },

  // --- Spawn-kit tools (game-only, not Director loot) ----------------------
  bronze_axe:      { name: 'Bronze Axe',      kind: 'tool',  color: [0.72, 0.50, 0.30], stack: 1, tool: 'axe',      held: 'axe'     },
  bronze_pickaxe:  { name: 'Bronze Pickaxe',   kind: 'tool',  color: [0.70, 0.48, 0.28], stack: 1, tool: 'pickaxe',  held: 'pickaxe' },
  iron_pickaxe:    { name: 'Iron Pickaxe',     kind: 'tool',  color: [0.66, 0.68, 0.72], stack: 1, tool: 'pickaxe',  held: 'pickaxe' },

  // --- Gathered materials (E-M1/2) -----------------------------------------
  logs:    { name: 'Logs',      kind: 'material',   color: [0.45, 0.31, 0.18], stack: 99, fuel: 120 },
  stone:   { name: 'Stone',     kind: 'material',   color: [0.55, 0.54, 0.56], stack: 99, throwable: true },
  ore:     { name: 'Iron Ore',  kind: 'material',   color: [0.45, 0.35, 0.30], stack: 99 },
  berries: { name: 'Berries',   kind: 'consumable', color: [0.60, 0.15, 0.25], stack: 99, edible: { heal: 1 } },

  // --- Crafted (E-M3) -------------------------------------------------------
  meal: { name: 'Berry Meal', kind: 'consumable', color: [0.70, 0.30, 0.35], stack: 20, edible: { heal: 4 } },

  // --- Plants / gathered (Phase E) -----------------------------------------
  plant_fiber:  { name: 'Plant Fiber',  kind: 'material',   color: [0.45, 0.60, 0.25], stack: 99 },
  flax:         { name: 'Flax',         kind: 'material',   color: [0.55, 0.70, 0.40], stack: 99 },
  reeds:        { name: 'Reeds',        kind: 'material',   color: [0.50, 0.55, 0.25], stack: 99 },
  gourd:        { name: 'Gourd',        kind: 'material',   color: [0.55, 0.65, 0.20], stack: 99 },
  cactus_flesh: { name: 'Cactus Flesh', kind: 'consumable', color: [0.35, 0.68, 0.35], stack: 20, edible: { heal: 1 }, drinkable: { quench: 15 } },
  warming_herb: { name: 'Warming Herb', kind: 'material',   color: [0.80, 0.50, 0.15], stack: 99 },
  cooling_herb: { name: 'Cooling Herb', kind: 'material',   color: [0.30, 0.70, 0.75], stack: 99 },
  mushroom:     { name: 'Mushroom',     kind: 'consumable', color: [0.72, 0.52, 0.35], stack: 20, edible: { heal: 1 } },

  // --- Ores / minerals (Phase E) -------------------------------------------
  coal:       { name: 'Coal',       kind: 'material', color: [0.20, 0.20, 0.22], stack: 99, fuel: 240 },
  copper_ore: { name: 'Copper Ore', kind: 'material', color: [0.72, 0.40, 0.25], stack: 99 },
  tin_ore:    { name: 'Tin Ore',    kind: 'material', color: [0.65, 0.65, 0.60], stack: 99 },

  // --- Animal drops (Phase E) -----------------------------------------------
  hide:           { name: 'Hide',           kind: 'material', color: [0.58, 0.42, 0.28], stack: 99 },
  wool:           { name: 'Wool',           kind: 'material', color: [0.90, 0.88, 0.85], stack: 99 },
  feather:        { name: 'Feather',        kind: 'material', color: [0.92, 0.90, 0.88], stack: 99 },
  bone:           { name: 'Bone',           kind: 'material', color: [0.88, 0.85, 0.75], stack: 99 },
  meat_raw:       { name: 'Raw Meat',       kind: 'material', color: [0.78, 0.30, 0.28], stack: 20 },
  egg_bird:       { name: 'Bird Egg',       kind: 'material', color: [0.92, 0.88, 0.78], stack: 1  },
  egg_dragon:     { name: 'Dragon Egg',     kind: 'material', color: [0.65, 0.20, 0.20], stack: 1  },
  egg_griffin:    { name: 'Griffin Egg',    kind: 'material', color: [0.80, 0.72, 0.35], stack: 1  },
  dragon_scale:   { name: 'Dragon Scale',   kind: 'loot',     color: [0.20, 0.55, 0.30], stack: 20 },
  griffin_feather:{ name: 'Griffin Feather',kind: 'material', color: [0.88, 0.80, 0.45], stack: 20 },

  // --- Processed materials (Phase E) ----------------------------------------
  sticks:       { name: 'Sticks',        kind: 'material', color: [0.48, 0.34, 0.20], stack: 99, fuel: 30 },
  planks:       { name: 'Planks',        kind: 'material', color: [0.62, 0.46, 0.28], stack: 99, fuel: 90 },
  thread:       { name: 'Thread',        kind: 'material', color: [0.85, 0.82, 0.78], stack: 99 },
  bow_string:   { name: 'Bow String',    kind: 'material', color: [0.88, 0.85, 0.80], stack: 99 },
  rope:         { name: 'Rope',          kind: 'material', color: [0.62, 0.52, 0.35], stack: 99 },
  arrow_shaft:  { name: 'Arrow Shaft',   kind: 'material', color: [0.52, 0.38, 0.22], stack: 99 },
  copper_ingot: { name: 'Copper Ingot',  kind: 'material', color: [0.75, 0.42, 0.22], stack: 99 },
  tin_ingot:    { name: 'Tin Ingot',     kind: 'material', color: [0.68, 0.68, 0.62], stack: 99 },
  bronze_ingot: { name: 'Bronze Ingot',  kind: 'material', color: [0.72, 0.50, 0.28], stack: 99 },
  iron_ingot:   { name: 'Iron Ingot',    kind: 'material', color: [0.68, 0.70, 0.74], stack: 99 },
  leather:      { name: 'Leather',       kind: 'material', color: [0.55, 0.38, 0.22], stack: 99 },
  wool_yarn:    { name: 'Wool Yarn',     kind: 'material', color: [0.88, 0.85, 0.82], stack: 99 },
  bone_needle:  { name: 'Bone Needle',   kind: 'material', color: [0.90, 0.88, 0.78], stack: 99 },
  meat_cooked:  { name: 'Cooked Meat',   kind: 'consumable', color: [0.65, 0.35, 0.18], stack: 20, edible: { heal: 4 } },

  // --- Containers (Phase E) -------------------------------------------------
  /** quench value reflects full state; empty/full tracking arrives Phase H. */
  gourd_bottle: { name: 'Gourd Bottle',  kind: 'container', color: [0.55, 0.65, 0.20], stack: 1, drinkable: { quench: 30 } },
  gourd_bowl:   { name: 'Gourd Bowl',    kind: 'container', color: [0.52, 0.62, 0.18], stack: 1 },
  waterskin:    { name: 'Waterskin',     kind: 'container', color: [0.52, 0.36, 0.20], stack: 1, drinkable: { quench: 50 } },
  iron_flask:   { name: 'Iron Flask',    kind: 'container', color: [0.66, 0.68, 0.72], stack: 1, drinkable: { quench: 80 } },
  cooking_pot:  { name: 'Cooking Pot',   kind: 'container', color: [0.30, 0.30, 0.32], stack: 1 },

  // --- Full containers (Phase H) — swapped in/out at fresh water -----------
  /** Filled gourd bottle: quench 35, reverts to gourd_bottle on drink. */
  gourd_bottle_full: { name: 'Gourd Bottle (Full)', kind: 'container', color: [0.35, 0.55, 0.72], stack: 1, drinkable: { quench: 35 } },
  /** Filled waterskin: quench 55, reverts to waterskin on drink. */
  waterskin_full:    { name: 'Waterskin (Full)',    kind: 'container', color: [0.32, 0.50, 0.68], stack: 1, drinkable: { quench: 55 } },
  /** Filled iron flask: quench 80, reverts to iron_flask on drink. */
  iron_flask_full:   { name: 'Iron Flask (Full)',   kind: 'container', color: [0.40, 0.55, 0.78], stack: 1, drinkable: { quench: 80 } },

  // --- Fire / shelter (Phase E) ---------------------------------------------
  fire_starter: { name: 'Fire Starter',  kind: 'tool',      color: [0.55, 0.38, 0.22], stack: 20 },
  // `fuel` here is the campfire meaning shared with logs (seconds of hearth
  // burn if you feed it to a fire). How long a torch burns IN YOUR HAND is a
  // different number and lives in torch.ts as TORCH_BURN_S — they were the
  // same field once and reading 60 as "a torch lasts a minute" is wrong.
  torch:        { name: 'Torch',         kind: 'tool',      color: [0.75, 0.55, 0.20], stack: 20, warmth: 0.3, fuel: 60, held: 'torch' },
  campfire_kit: { name: 'Campfire Kit',  kind: 'material',  color: [0.45, 0.31, 0.18], stack: 5  },
  fiber_tent:   { name: 'Fiber Tent',    kind: 'material',  color: [0.55, 0.60, 0.40], stack: 1,  warmth: 0.5 },
  wool_tent:    { name: 'Wool Tent',     kind: 'material',  color: [0.75, 0.72, 0.65], stack: 1,  warmth: 0.8 },
  hide_tent:    { name: 'Hide Tent',     kind: 'material',  color: [0.58, 0.42, 0.28], stack: 1,  warmth: 1.1 },
  /**
   * The walk-in tent. Same placement path and same warmth tier as the hide
   * tent; what it buys is FLOOR — a volume you stand inside rather than a
   * bedroll you huddle beside, and the one shelter you can set a campfire down
   * in. See shelter.ts `TentShape` for the two footprints.
   */
  canvas_tent:  { name: 'Canvas Tent',   kind: 'material',  color: [0.80, 0.76, 0.66], stack: 1,  warmth: 1.2 },

  // --- The loom (T3 station) -----------------------------------------------
  /**
   * The loom, flat-packed. A placeable station in the same idiom as
   * `campfire_kit`: the item IS the station until you put it down.
   *
   * Forged rather than lashed together — the reed and the heddle rod are iron,
   * which is what makes the loom a tier ABOVE the forge rather than beside it.
   */
  loom_kit:     { name: 'Loom Kit',      kind: 'material',  color: [0.60, 0.46, 0.30], stack: 5  },
  /**
   * Woven cloth — the loom's only primary output and the input to everything
   * else it makes. Spinning was already solved by hand (`wool → wool_yarn`);
   * weaving is the verb the game did not have, which is why the T3 station is
   * a loom and not a spinning wheel.
   */
  cloth:        { name: 'Cloth',         kind: 'material',  color: [0.86, 0.83, 0.76], stack: 99 },

  // --- Weapons (Phase E) ----------------------------------------------------
  /**
   * The rare ammunition — a lightning bolt with fletchings. Boss loot.
   *
   * The ID stays `arrow` on purpose. Every ammo check, icon, hit test, reticle
   * state and consumption site in main.ts already names it, and renaming the id
   * would touch a dozen files an agent does not own to change nothing the
   * player can see. What changed is what it IS: see tintreach.ts.
   *
   * It is no longer the ONLY ammunition, and that was a real defect rather than
   * a design: making Tintreach rare made the bow rare, because the bow had
   * nothing else to shoot. `flint_arrow` below is the everyday quiver; this is
   * the thing you save for the fight you cannot otherwise win.
   *
   * Colour is thread-cream `#f0e6c8` — the reticle's own thread, in linear RGB.
   */
  arrow:        { name: 'Tintreach Arrows', kind: 'weapon', color: [0.87, 0.79, 0.57], stack: 99 },
  /**
   * The everyday quiver: a knapped flint head, a whittled shaft, a feather.
   *
   * Cheap, craftable and stackable — this is what a bow is FOR. Its damage is
   * the ordinary draw-scaled arrow number (6 hunter / 9 composite), which is
   * exactly what the bow did before Tintreach existed, so nothing about hunting
   * or skirmishing has changed; only the rare bolt was added beside it.
   *
   * Colour is flint grey over a wood shaft.
   */
  flint_arrow:  { name: 'Flint Arrows',     kind: 'weapon', color: [0.46, 0.44, 0.42], stack: 99 },
  bronze_sword: { name: 'Bronze Sword',  kind: 'weapon',  color: [0.72, 0.50, 0.28], stack: 1,  held: 'sword' },
  spear:        { name: 'Spear',         kind: 'weapon',  color: [0.60, 0.45, 0.25], stack: 1,  held: 'staff' },
  composite_bow:{ name: 'Composite Bow', kind: 'weapon',  color: [0.42, 0.30, 0.18], stack: 1,  held: 'bow'  },

  // --- Shields (combat/shields.ts owns the stat ladder) ---------------------
  //
  // Four tiers, carried in the hotbar rather than worn: a shield costs you a
  // slot a torch or a quiver would otherwise have, and buys a guard that
  // coexists with whatever is in your hand. The stat ladder — stamina per
  // block, and how much fire it turns — lives in `combat/shields.ts` beside the
  // parry rules, NOT here, because it is a relation between the four of them
  // and a table split across two files is a table that drifts.
  //
  // No `held` archetype: `held` is the RIGHT hand, and a shield is on the left
  // arm. `character-mesh.ts` draws it off `CharacterOptions.shield`.
  wood_shield:        { name: 'Wooden Shield',      kind: 'shield', color: [0.52, 0.38, 0.22], stack: 1, fuel: 60 },
  bronze_shield:      { name: 'Bronze Shield',      kind: 'shield', color: [0.72, 0.50, 0.28], stack: 1 },
  iron_shield:        { name: 'Iron Shield',        kind: 'shield', color: [0.66, 0.68, 0.72], stack: 1 },
  /**
   * The payoff tier. Its colour is the BOSS palette — the black hide and
   * oxblood horn of `creature-parts.ts` — deliberately NOT the emerald of
   * `dragonscale_helm`. The armour set is scale from any dragon; a shield that
   * turns dragon fire reads as having been cut from something far worse, and
   * putting it in the King's own black-and-red is the cheapest way to say so.
   */
  dragonscale_shield: { name: 'Dragonscale Shield', kind: 'shield', color: [0.22, 0.06, 0.07], stack: 1, warmth: 0.2 },

  // --- Armor: fiber tier (defense 1/1/1, warmth 0.1) -----------------------
  fiber_hood:     { name: 'Fiber Hood',     kind: 'armor', color: [0.55, 0.60, 0.40], stack: 1, warmth: 0.1, armor: { slot: 'head', defense: 1 } },
  fiber_tunic:    { name: 'Fiber Tunic',    kind: 'armor', color: [0.52, 0.58, 0.38], stack: 1, warmth: 0.1, armor: { slot: 'body', defense: 1 } },
  fiber_leggings: { name: 'Fiber Leggings', kind: 'armor', color: [0.50, 0.56, 0.36], stack: 1, warmth: 0.1, armor: { slot: 'legs', defense: 1 } },

  // --- Armor: leather tier (defense 2/3/2, warmth 0.2) ---------------------
  leather_cap:     { name: 'Leather Cap',     kind: 'armor', color: [0.55, 0.38, 0.22], stack: 1, warmth: 0.2, armor: { slot: 'head', defense: 2 } },
  leather_tunic:   { name: 'Leather Tunic',   kind: 'armor', color: [0.52, 0.36, 0.20], stack: 1, warmth: 0.2, armor: { slot: 'body', defense: 3 } },
  leather_leggings:{ name: 'Leather Leggings',kind: 'armor', color: [0.50, 0.34, 0.18], stack: 1, warmth: 0.2, armor: { slot: 'legs', defense: 2 } },

  // --- Armor: quilted tier (defense 3/4/3, warmth 0.6) ---------------------
  //
  // The loom's armour, and the tier that exists because iron is COLD. Iron
  // out-defends it 4/6/4 to 3/4/3 and carries warmth 0, so alpine nights and
  // winter rain are the one place a full iron set is the wrong answer; a
  // quilted gambeson is worse in a fight and better on the mountain. Madder
  // red because a dyed woollen coat is the loudest thing a yarn person owns.
  quilted_hood:     { name: 'Quilted Hood',     kind: 'armor', color: [0.66, 0.34, 0.30], stack: 1, warmth: 0.6, armor: { slot: 'head', defense: 3 } },
  quilted_tunic:    { name: 'Quilted Tunic',    kind: 'armor', color: [0.62, 0.31, 0.28], stack: 1, warmth: 0.6, armor: { slot: 'body', defense: 4 } },
  quilted_leggings: { name: 'Quilted Leggings', kind: 'armor', color: [0.58, 0.29, 0.26], stack: 1, warmth: 0.6, armor: { slot: 'legs', defense: 3 } },

  // --- Armor: iron tier (defense 4/6/4, warmth 0) --------------------------
  iron_helm:  { name: 'Iron Helm',  kind: 'armor', color: [0.68, 0.70, 0.74], stack: 1, warmth: 0, armor: { slot: 'head', defense: 4 } },
  iron_chest: { name: 'Iron Chest', kind: 'armor', color: [0.66, 0.68, 0.72], stack: 1, warmth: 0, armor: { slot: 'body', defense: 6 } },
  iron_legs:  { name: 'Iron Legs',  kind: 'armor', color: [0.65, 0.67, 0.71], stack: 1, warmth: 0, armor: { slot: 'legs', defense: 4 } },

  // --- Armor: dragonscale tier (defense 6/9/6, warmth 0.2) ------------------
  // Top tier: forged from scales of slain dragons. Warm — dragons run hot.
  dragonscale_helm:  { name: 'Dragonscale Helm',    kind: 'armor', color: [0.16, 0.48, 0.28], stack: 1, warmth: 0.2, armor: { slot: 'head', defense: 6 } },
  dragonscale_chest: { name: 'Dragonscale Chest',   kind: 'armor', color: [0.14, 0.45, 0.26], stack: 1, warmth: 0.2, armor: { slot: 'body', defense: 9 } },
  dragonscale_legs:  { name: 'Dragonscale Greaves', kind: 'armor', color: [0.13, 0.42, 0.24], stack: 1, warmth: 0.2, armor: { slot: 'legs', defense: 6 } },

  // --- Consumables with effectClass (Phase E) -------------------------------
  healing_potion: { name: 'Healing Potion', kind: 'consumable', color: [0.75, 0.20, 0.25], stack: 20, edible: { heal: 8 }, effectClass: 'heal' },
  warming_potion: { name: 'Warming Potion', kind: 'consumable', color: [0.85, 0.45, 0.15], stack: 20, effectClass: 'warm' },
  cooling_potion: { name: 'Cooling Potion', kind: 'consumable', color: [0.25, 0.60, 0.85], stack: 20, effectClass: 'cool' },
  stamina_potion: { name: 'Stamina Potion', kind: 'consumable', color: [0.30, 0.75, 0.40], stack: 20, effectClass: 'stamina' },
  hearty_stew:    { name: 'Hearty Stew',    kind: 'consumable', color: [0.65, 0.35, 0.18], stack: 20, edible: { heal: 10 }, effectClass: 'heal' },
} as const satisfies Record<string, ItemDef>;

export type GameItemId = keyof typeof ITEM_DEFS;

/**
 * The Tintreach quiver — one per save file, ever.
 *
 * Declared here rather than in tintreach.ts because inventory.ts enforces the
 * uniqueness rule and tintreach.ts describes the weapon; both need the id, and
 * items.ts is the one module with no imports at all, so it is the only place
 * the constant can live without creating a cycle.
 */
export const TINTREACH_ID = 'arrow' satisfies GameItemId;

export function isGameItemId(x: string): x is GameItemId {
  return Object.prototype.hasOwnProperty.call(ITEM_DEFS, x);
}

export function itemDef(id: GameItemId): ItemDef {
  return ITEM_DEFS[id];
}
