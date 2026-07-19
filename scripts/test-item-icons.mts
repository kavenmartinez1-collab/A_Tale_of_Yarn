/**
 * Coverage test for item-icons.ts — verifies that every GameItemId in
 * ITEM_DEFS has an explicit entry in ICON_DRAWERS, and that ICON_DRAWERS
 * contains no unknown ids.
 *
 * Runs entirely in Node (no DOM, no canvas): we import only the id→drawer
 * map (ICON_DRAWERS) and the hasIcon helper, which are pure data/function
 * tables with no document references.
 *
 * Run:  npx tsx scripts/test-item-icons.mts
 */

import { ITEM_DEFS } from '../src/game/items';
import { ICON_DRAWERS, hasIcon } from '../src/game/ui/item-icons';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const allItemIds = Object.keys(ITEM_DEFS) as (keyof typeof ITEM_DEFS)[];
const allDrawerIds = Object.keys(ICON_DRAWERS) as (keyof typeof ICON_DRAWERS)[];

// 1. Total counts
check(
  'item registry has at least 83 ids',
  allItemIds.length >= 83,
  `actual: ${allItemIds.length}`,
);

check(
  'ICON_DRAWERS has at least 83 entries',
  allDrawerIds.length >= 83,
  `actual: ${allDrawerIds.length}`,
);

// 2. Every item id has an icon drawer
for (const id of allItemIds) {
  check(
    `ICON_DRAWERS has entry for '${id}'`,
    hasIcon(id),
  );
}

// 3. No drawer for unknown ids (belt-and-suspenders)
const itemIdSet = new Set<string>(allItemIds);
for (const id of allDrawerIds) {
  check(
    `ICON_DRAWERS entry '${id}' is a known GameItemId`,
    itemIdSet.has(id),
  );
}

// 4. Every drawer is a function (not undefined/null/wrong type)
for (const id of allDrawerIds) {
  check(
    `ICON_DRAWERS['${id}'] is a function`,
    typeof ICON_DRAWERS[id] === 'function',
  );
}

// 5. Drawer count matches item count exactly
check(
  'ICON_DRAWERS count equals ITEM_DEFS count',
  allDrawerIds.length === allItemIds.length,
  `drawers=${allDrawerIds.length} items=${allItemIds.length}`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
