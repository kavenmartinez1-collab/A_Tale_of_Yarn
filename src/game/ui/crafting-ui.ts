/**
 * Crafting panel (B key) for PanelManager — category tab bar across the top,
 * one row per recipe in the active tab: icon + name, input list with have/need
 * counts, station badge (fire / forge / +pot) when not hand-crafted, and a
 * Craft button. Station badge is dimmed when the context doesn't satisfy the
 * requirement. Model lives in crafting.ts.
 */

import { ITEM_DEFS } from '../items';
import { itemIcon } from './item-icons';
import { countItem, type Inventory } from '../inventory';
import { canCraft, craft, RECIPES, type Recipe, type StationContext } from '../crafting';

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
#crafting-panel .recipe .r-badge.pot   { background: rgba(80, 180, 180, 0.20); color: #72c8c8; border: 1px solid rgba(80, 180, 180, 0.30); }
#crafting-panel .recipe .r-badge.dim   { opacity: 0.35; }
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
#crafting-panel .craft-list { min-height: 24px; }
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
  return true;
}

/** Build the badge element(s) for a recipe. Returns null for hand-only. */
function buildBadges(recipe: Recipe, ctx: StationContext): HTMLElement[] {
  if (recipe.station === 'hand' && !recipe.needsPot) return [];

  const badges: HTMLElement[] = [];

  if (recipe.station !== 'hand') {
    const b = document.createElement('span');
    b.className = 'r-badge ' + recipe.station;
    b.textContent = recipe.station === 'fire' ? 'fire' : 'forge';
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

/** Crafting panel content for PanelManager. */
export function buildCraftingPanel(
  inv: Inventory,
  onChange: () => void,
  ctx: StationContext,
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

  /** Render rows for the active category into `list`. */
  function renderList(): void {
    list.replaceChildren();

    const visible = RECIPES.filter((r) => r.category === activeCategory);

    visible.forEach((recipe, _i) => {
      const def = ITEM_DEFS[recipe.output];
      const row = document.createElement('div');
      row.className = 'recipe';
      row.dataset.output = recipe.output; // stable hook for e2e

      // Icon
      const icon = document.createElement('div');
      icon.className = 'r-icon';
      icon.style.background =
        `url(${itemIcon(recipe.output)}) center / contain no-repeat`;
      row.appendChild(icon);

      // Body: name + inputs
      const body = document.createElement('div');
      body.className = 'r-body';
      const name = document.createElement('div');
      name.className = 'r-name';
      name.textContent = recipe.count > 1 ? `${recipe.count}× ${def.name}` : def.name;
      body.appendChild(name);
      const inputs = document.createElement('div');
      inputs.className = 'r-inputs';
      body.appendChild(inputs);
      row.appendChild(body);

      // Station badges
      const badges = buildBadges(recipe, ctx);
      for (const b of badges) row.appendChild(b);

      // Craft button
      const btn = document.createElement('button');
      btn.className = 'r-craft';
      btn.textContent = 'Craft';
      btn.addEventListener('click', () => {
        if (craft(inv, recipe, ctx)) onChange();
        refreshRow();
      });
      row.appendChild(btn);

      function refreshRow(): void {
        inputs.replaceChildren(...recipe.inputs.map(([id, n], k) => {
          const span = document.createElement('span');
          const have = countItem(inv, id);
          span.textContent = `${k > 0 ? ', ' : ''}${n}× ${ITEM_DEFS[id].name} (${have})`;
          if (have < n) span.className = 'missing';
          return span;
        }));
        btn.disabled = !canCraft(inv, recipe, ctx);
      }

      refreshRow();
      list.appendChild(row);
    });
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
