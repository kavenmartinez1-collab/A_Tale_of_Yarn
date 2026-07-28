/**
 * Crafting panel (B key) for PanelManager — category tab bar across the top,
 * one row per recipe in the active tab: icon + name, input list with have/need
 * counts, station badge (fire / forge / loom / +pot) when not hand-crafted, and
 * a Craft button. Station badge is dimmed when the context doesn't satisfy the
 * requirement. Model lives in crafting.ts.
 *
 * THE TIER VIEW. Within a tab, rows are grouped under the rung of the
 * progression tree they belong to — Hand, Campfire, Forge, Loom, Dragonscale —
 * in that order, with a heading per group. That is the whole "tree" the player
 * ever sees, and it is a grouping rather than a graph on purpose: a node-and-
 * edge diagram would need its own pane, its own navigation and its own
 * controller story, and would tell the player less than "these four need a
 * forge" does.
 *
 * LOCKED ROWS ARE DRAWN, NOT HIDDEN. An undiscovered recipe renders as a
 * silhouette with its requirement in place of its ingredients. A tree you
 * cannot see the shape of is not a tree, it is a surprise.
 *
 * AND THEY STAY FOCUSABLE. `input/ui-focus.ts` SKIPS `disabled` controls, by a
 * deliberate rule (a permanently-disabled control is a dead end the pad has to
 * press out of). A locked row must still be reachable — the player has to be
 * able to land on it and read why it is locked — so its button is NOT
 * `disabled`; it carries `.locked` + `aria-disabled` and its handler does
 * nothing. Rows that are merely short of materials keep using `disabled`,
 * because those the player can already read from the red ingredient counts.
 */

import { ITEM_DEFS } from '../items';
import { itemIcon } from './item-icons';
import { countItem, type Inventory } from '../inventory';
import {
  canCraft, craft, RECIPES, TIER_NAMES,
  type Recipe, type StationContext, type Tier,
} from '../crafting';
import {
  isUnlocked, requirementText, unlockGate, type ProgressState,
} from '../progression/unlocks';

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CRAFT_CSS = `
#crafting-panel .recipe {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
#crafting-panel .recipe .r-icon {
  width: 26px;
  height: 26px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.85);
  font: 600 13px system-ui, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  flex: none;
}
#crafting-panel .recipe .r-body { flex: 1; min-width: 0; }
#crafting-panel .recipe .r-name { font-weight: 600; }
#crafting-panel .recipe .r-inputs { font-size: 11px; opacity: 0.75; }
#crafting-panel .recipe .r-inputs .missing { color: #e07a6a; }
#crafting-panel .recipe .r-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: 4px;
  letter-spacing: 0.04em;
  flex: none;
  white-space: nowrap;
}
#crafting-panel .recipe .r-badge.fire  { background: rgba(220, 120, 30, 0.25); color: #e8903a; border: 1px solid rgba(220, 120, 30, 0.4); }
#crafting-panel .recipe .r-badge.forge { background: rgba(100, 140, 220, 0.20); color: #8ab2e8; border: 1px solid rgba(100, 140, 220, 0.35); }
#crafting-panel .recipe .r-badge.loom  { background: rgba(200, 170, 110, 0.20); color: #d8bd80; border: 1px solid rgba(200, 170, 110, 0.35); }
#crafting-panel .recipe .r-badge.pot   { background: rgba(80, 180, 180, 0.20); color: #72c8c8; border: 1px solid rgba(80, 180, 180, 0.30); }
#crafting-panel .recipe .r-badge.dim   { opacity: 0.35; }

/* --- the tier view ------------------------------------------------------- */
#crafting-panel .tier-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 2px;
  font: 600 10px system-ui, sans-serif;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: rgba(240, 230, 200, 0.72);
}
#crafting-panel .tier-head::after {
  content: '';
  flex: 1;
  height: 1px;
  /* A running stitch, not a rule: the tree's dividers are thread like
     everything else in this game's UI. */
  background: repeating-linear-gradient(
    to right,
    rgba(240, 230, 200, 0.34) 0 4px,
    transparent 4px 8px);
}
#crafting-panel .tier-head .tier-count { opacity: 0.5; letter-spacing: 0.04em; }

/* A locked row is the same row with the light off. The icon keeps its shape
   and loses its colour, which is what makes it read as a silhouette of a thing
   that exists rather than as an empty slot. */
#crafting-panel .recipe.locked .r-icon {
  filter: grayscale(1) brightness(0.30) contrast(0.75);
  opacity: 0.55;
}
#crafting-panel .recipe.locked .r-name { color: rgba(205, 214, 228, 0.42); }
#crafting-panel .recipe.locked .r-req {
  font-size: 11px;
  color: rgba(240, 230, 200, 0.62);
  font-style: italic;
}
#crafting-panel .recipe .r-craft.locked {
  opacity: 0.5;
  cursor: default;
  border-style: dashed;
  border-color: rgba(240, 230, 200, 0.28);
  letter-spacing: 0.04em;
  font-size: 11px;
}
#crafting-panel .recipe .r-craft {
  background: rgba(205, 214, 228, 0.12);
  color: inherit;
  border: 2px solid transparent;
  border-radius: 5px;
  padding: 3px 10px;
  cursor: pointer;
  font: inherit;
  flex: none;
}
#crafting-panel .recipe .r-craft:disabled {
  opacity: 0.35;
  cursor: default;
}
#crafting-panel .craft-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
#crafting-panel .craft-tab {
  background: rgba(205, 214, 228, 0.08);
  color: rgba(205, 214, 228, 0.65);
  border: 1px solid rgba(205, 214, 228, 0.15);
  border-radius: 5px;
  padding: 3px 9px;
  cursor: pointer;
  font: 600 11px system-ui, sans-serif;
  letter-spacing: 0.04em;
}
#crafting-panel .craft-tab.active {
  background: rgba(205, 214, 228, 0.20);
  color: #cdd6e4;
  border-color: rgba(205, 214, 228, 0.40);
}
/* THE PANEL HAS TO SCROLL NOW, and that is a direct consequence of the tier
   view: drawing undiscovered recipes instead of hiding them roughly doubles
   the rows on a page (the Camp page goes from 11 to 27 on a fresh save), and
   the panel is fixed and vertically centred, so the extra rows ran off both
   ends of the screen. Capping the list and letting it scroll is the fix; the
   pad already handles it, because ui-focus.ts scrolls the focused control into
   view (block: nearest) whenever it moves the ring.
   NOTE FOR EDITORS: this is inside a template literal. A backtick in a comment
   here ends the string and the build fails pointing at CSS — see the same
   warning above FOCUS_CSS in input/ui-focus.ts. Prose about code, no backticks. */
#crafting-panel {
  display: flex;
  flex-direction: column;
  max-height: 86vh;
}
#crafting-panel .craft-list {
  min-height: 24px;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* Room for the heading, the tab bar and the hint line. */
  max-height: calc(86vh - 110px);
  /* The scrollbar must not sit on top of the Craft buttons. */
  padding-right: 4px;
}
/* The rung you are looking at stays named while you scroll through it. */
#crafting-panel .tier-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgba(10, 14, 20, 0.94);
  padding: 4px 0 2px;
}
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CRAFT_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type Category = Recipe['category'];

const TABS: { label: string; category: Category }[] = [
  { label: 'Tools',           category: 'tools'   },
  { label: 'Weapons',         category: 'weapons' },
  { label: 'Armor',           category: 'armor'   },
  { label: 'Food & Potions',  category: 'food'    },
  { label: 'Camp & Materials',category: 'camp'    },
];

// ---------------------------------------------------------------------------
// Station badge helpers
// ---------------------------------------------------------------------------

function stationSatisfied(recipe: Recipe, ctx: StationContext): boolean {
  if (recipe.station === 'fire')  return ctx.nearCampfire || ctx.nearForge;
  if (recipe.station === 'forge') return ctx.nearForge;
  if (recipe.station === 'loom')  return ctx.nearLoom === true;
  return true;
}

/** The station a locked/unbuildable row should name, in player words. */
const STATION_LABEL: Record<Recipe['station'], string> = {
  hand: 'Hand', fire: 'Campfire', forge: 'Forge', loom: 'Loom',
};

/** Build the badge element(s) for a recipe. Returns null for hand-only. */
function buildBadges(recipe: Recipe, ctx: StationContext): HTMLElement[] {
  if (recipe.station === 'hand' && !recipe.needsPot) return [];

  const badges: HTMLElement[] = [];

  if (recipe.station !== 'hand') {
    const b = document.createElement('span');
    b.className = 'r-badge ' + recipe.station;
    b.textContent = recipe.station;
    if (!stationSatisfied(recipe, ctx)) b.classList.add('dim');
    badges.push(b);
  }

  if (recipe.needsPot) {
    const b = document.createElement('span');
    b.className = 'r-badge pot';
    b.textContent = '+pot';
    if (!ctx.hasCookingPot) b.classList.add('dim');
    badges.push(b);
  }

  return badges;
}

// ---------------------------------------------------------------------------
// Panel builder
// ---------------------------------------------------------------------------

/**
 * The discovery half of the panel's inputs.
 *
 * Optional as a whole: with no progress record every recipe renders unlocked,
 * which is exactly what a unit fixture or a future panel that has no save
 * behind it should see. The game always passes one.
 */
export interface CraftingProgressOptions {
  progress: ProgressState;
  /** Called with the recipe key after a successful craft. */
  onCrafted: (key: string) => void;
}

/** Crafting panel content for PanelManager. */
export function buildCraftingPanel(
  inv: Inventory,
  onChange: () => void,
  ctx: StationContext,
  prog?: CraftingProgressOptions,
): HTMLElement {
  injectCss();
  const el = document.createElement('div');
  el.id = 'crafting-panel';

  const h = document.createElement('h2');
  h.textContent = 'Crafting';
  el.appendChild(h);

  // --- Tab bar ---------------------------------------------------------------
  let activeCategory: Category = 'tools';

  const tabBar = document.createElement('div');
  tabBar.className = 'craft-tabs';
  el.appendChild(tabBar);

  const list = document.createElement('div');
  list.className = 'craft-list';
  el.appendChild(list);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Gather logs, ore, and berries in the world — B to close';
  el.appendChild(hint);

  // --- Recipe row builders ---------------------------------------------------

  const gate = prog === undefined ? undefined : unlockGate(prog.progress);

  /** True when the player has discovered this recipe (or there is no record). */
  function discovered(recipe: Recipe): boolean {
    return prog === undefined || isUnlocked(prog.progress, recipe.key);
  }

  /** Build one recipe row, locked or not, and append it to `list`. */
  function renderRow(recipe: Recipe): void {
    const def = ITEM_DEFS[recipe.output];
    const open = discovered(recipe);

    const row = document.createElement('div');
    row.className = open ? 'recipe' : 'recipe locked';
    row.dataset.output = recipe.output; // stable hook for e2e
    row.dataset.recipe = recipe.key;    // ditto, and unambiguous for dupes
    row.dataset.tier = String(recipe.tier);
    row.dataset.locked = open ? '0' : '1';

    // Icon — greyed to a silhouette by CSS when locked.
    const icon = document.createElement('div');
    icon.className = 'r-icon';
    icon.style.background =
      `url(${itemIcon(recipe.output)}) center / contain no-repeat`;
    row.appendChild(icon);

    // Body: name + either the ingredient list or the requirement line.
    const body = document.createElement('div');
    body.className = 'r-body';
    const name = document.createElement('div');
    name.className = 'r-name';
    // A locked recipe still names its output. Hiding the name behind "???"
    // was tried in spirit and rejected: the player cannot plan around a
    // question mark, and every one of these is discoverable by doing the
    // obvious thing, so the name is a signpost rather than a spoiler.
    name.textContent = recipe.count > 1 ? `${recipe.count}× ${def.name}` : def.name;
    body.appendChild(name);

    const detail = document.createElement('div');
    detail.className = open ? 'r-inputs' : 'r-req';
    body.appendChild(detail);
    row.appendChild(body);

    for (const b of buildBadges(recipe, ctx)) row.appendChild(b);

    const btn = document.createElement('button');
    row.appendChild(btn);

    if (!open) {
      // Locked: name the first unmet condition, and stay focusable-but-inert.
      // See the header for why this is not `disabled`.
      detail.textContent = prog === undefined
        ? '' : requirementText(recipe, prog.progress);
      btn.className = 'r-craft locked';
      btn.textContent = 'Locked';
      btn.setAttribute('aria-disabled', 'true');
      btn.title = detail.textContent;
      btn.addEventListener('click', (e) => {
        // Swallow it. A pad player WILL press A on this row — the ring lands
        // here by design — and the one thing that must not happen is a craft.
        e.preventDefault();
        e.stopPropagation();
      });
      list.appendChild(row);
      return;
    }

    btn.className = 'r-craft';
    btn.textContent = 'Craft';
    btn.addEventListener('click', () => {
      if (craft(inv, recipe, ctx, gate)) {
        onChange();
        // Order matters: the craft is recorded BEFORE the re-render, so a
        // recipe unlocked by this craft is already open when the list redraws.
        prog?.onCrafted(recipe.key);
        renderList();
        return;
      }
      // A craft that was allowed and still failed has exactly one cause: the
      // output had nowhere to go, so `craft` restored the inputs and returned
      // false. Left unsaid, that is a button that visibly does nothing — the
      // single most alarming thing a crafting panel can do. Say it.
      if (canCraft(inv, recipe, ctx, gate)) {
        detail.replaceChildren();
        const warn = document.createElement('span');
        warn.className = 'missing';
        warn.textContent = 'No room in your pack for it — drop something first.';
        detail.appendChild(warn);
        return;
      }
      refreshRow();
    });

    function refreshRow(): void {
      detail.replaceChildren(...recipe.inputs.map(([id, n], k) => {
        const span = document.createElement('span');
        const have = countItem(inv, id);
        span.textContent = `${k > 0 ? ', ' : ''}${n}× ${ITEM_DEFS[id].name} (${have})`;
        if (have < n) span.className = 'missing';
        return span;
      }));
      btn.disabled = !canCraft(inv, recipe, ctx, gate);
      // When the ingredients are all there and the bench is not, say which
      // bench. "Craft" greyed out with full green counts is the single most
      // confusing state this panel can be in.
      const haveInputs = recipe.inputs.every(([id, n]) => countItem(inv, id) >= n);
      btn.title = haveInputs && !stationSatisfied(recipe, ctx)
        ? `Requires: ${STATION_LABEL[recipe.station]}`
        : '';
    }

    refreshRow();
    list.appendChild(row);
  }

  /** Render rows for the active category into `list`, grouped by tier. */
  function renderList(): void {
    list.replaceChildren();

    const visible = RECIPES.filter((r) => r.category === activeCategory);
    if (visible.length === 0) return;

    for (let tier = 0 as Tier; tier <= 4; tier = (tier + 1) as Tier) {
      const inTier = visible.filter((r) => r.tier === tier);
      if (inTier.length === 0) continue;

      const head = document.createElement('div');
      head.className = 'tier-head';
      head.dataset.tier = String(tier);
      const label = document.createElement('span');
      label.textContent = TIER_NAMES[tier];
      head.appendChild(label);
      const count = document.createElement('span');
      count.className = 'tier-count';
      const openCount = inTier.filter(discovered).length;
      count.textContent = `${openCount}/${inTier.length}`;
      head.appendChild(count);
      list.appendChild(head);

      for (const recipe of inTier) renderRow(recipe);
    }
  }

  // --- Tab buttons -----------------------------------------------------------

  const tabButtons: HTMLButtonElement[] = [];

  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.className = 'craft-tab';
    btn.textContent = tab.label;
    btn.dataset.category = tab.category;
    btn.addEventListener('click', () => {
      if (activeCategory === tab.category) return;
      activeCategory = tab.category;
      tabButtons.forEach((b) =>
        b.classList.toggle('active', b.dataset.category === activeCategory));
      renderList();
    });
    tabBar.appendChild(btn);
    tabButtons.push(btn);
  }

  // Set initial active tab
  tabButtons.forEach((b) =>
    b.classList.toggle('active', b.dataset.category === activeCategory));

  renderList();

  return el;
}
