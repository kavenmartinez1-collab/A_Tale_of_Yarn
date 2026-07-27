/**
 * help-panel.ts — "what am I supposed to be doing", in one page.
 *
 * A primer, not a manual. The controls live next door in `controls-panel.ts`;
 * this screen answers the questions a player has in their first hour and then
 * gets out of the way. If a paragraph here could be replaced by "read the
 * tooltip", it should not be here.
 *
 * ## Everything below was read out of the game, not imagined
 *
 * Written against the systems as they actually behave, because plausible
 * advice that is wrong is worse than no advice:
 *
 *   - The opening really is an escape. A new game spawns on the pallet in the
 *     forced cell under Castle Vhaeron, the castle starts `dormant` (nothing is
 *     hostile — `castle/castle-state.ts` calls it "the escape window"), the
 *     chest in the guard room gives your gear back, and the way out is a breach
 *     in the east curtain wall. There is no key and no puzzle.
 *   - Coming back within 130 m after leaving turns the castle `hunting`, for
 *     good. That is a warning worth giving, so it is given.
 *   - There are four vitals and hunger is NOT one of them (`vitals.ts`).
 *     GAME_PLAN.md still lists hunger; the code never had it. Health, thirst,
 *     stamina, temperature.
 *   - Warmth is max-not-sum: the single best source wins, +0.2 if two or more
 *     are active. Campfire 1.2 > tent 0.5-1.1 (a tree canopy counts as the
 *     lowest tent tier) > armour > torch 0.3. The torch being the WEAKEST
 *     source is the counter-intuitive bit, so the primer says it outright.
 *   - A torch burns 180 s, is lit by being the selected item and by nothing
 *     else, auto-lights the next one, and sets fire to vegetation within 1.6 m
 *     as you walk (`torch.ts`, `fire.ts`).
 *   - Tintreach arrows come from dungeon bosses — a slain `dread_king` always
 *     carries 5-9 (`dungeon/dungeon-loot.ts`). A dungeon with no boss pays
 *     almost nothing, which is why the primer points at the boss.
 *   - Saving is refused inside a dungeon (`ui/menu-panel.ts`'s `canSave`).
 *   - NPC conversation is free typed text into a local model, not a menu, and
 *     voice fills the box for you to confirm rather than sending it — because
 *     a misheard threat can genuinely make an enemy.
 *   - Lock-on changes the camera and which way your body faces, and NOTHING
 *     else. It does not aim the bow (`combat/lock-on.ts` is explicit). Saying
 *     so stops a player fighting the reticle.
 *
 * DETERMINISM: pure DOM construction, no clocks, no randomness.
 * RELEASE SAFE: reads no `__gameDebug`.
 */

const CREAM = '#f0e6c8';
const GOLD = '#e8c35a';

/** `[heading, paragraph]`. Kept as data so the order is one line to change. */
type Topic = [string, string];

const TOPICS: Topic[] = [
  ['Get out of the castle',
    'You wake on a pallet in a cell under Castle Vhaeron. Nobody is hunting '
    + 'you yet — the King is up on his dragon, circling his own towers, and '
    + 'the guards have not been told. Press E at the chest in the guard room '
    + 'to take your gear back, then find the breach in the east wall and walk '
    + 'down the motte. That is the whole of the opening: no key, no puzzle, '
    + 'just a hole in a wall and a head start.'],

  ['Do not come back too soon',
    'Once you have put some distance between you and the keep, returning to it '
    + 'wakes the place up — permanently. The King comes down off the dragon '
    + 'and everything inside those walls turns on you at once. Come back when '
    + 'you want that fight, not before.'],

  ['Staying alive',
    'Four things can kill you. Hearts, obviously. Thirst — drink at any river, '
    + 'pond or well with E, and fill a gourd or a waterskin to carry some with '
    + 'you; the desert drains you two and a half times as fast. Cold and heat, '
    + 'both of which start taking hearts once they get bad enough. And breath: '
    + 'running and climbing spend it, and running out while you are swimming '
    + 'means drowning. There is no hunger — food is for healing.'],

  ['Keeping warm',
    'Only your BEST source of warmth counts, not all of them added up. A '
    + 'campfire is far and away the strongest, then a tent — and standing '
    + 'under a thick tree counts as a poor one — then whatever you are '
    + 'wearing. A lit torch is the weakest warmth in the game, so it is what '
    + 'you use when there is nothing else, not what you plan around. On a cold '
    + 'night the answer is almost always to stop and build a fire.'],

  ['Torches',
    'A torch is lit whenever it is the item in your hand, and goes out when it '
    + 'is not. Each one burns about three minutes, then lights the next from '
    + 'your pack on its own until you run out. Carry more than you think. And '
    + 'be careful where you walk with one: dry grass and brush catch fire from '
    + 'a torch as you pass, and fire spreads.'],

  ['Dungeons',
    'Stone arches stand out in the wild, lit from within. Press E at one to go '
    + 'down. Skeletons and goblins hold the rooms, chests hold the reward, and '
    + 'the deepest room holds a Dread King — who hits far harder than anything '
    + 'above ground and who is the only dependable source of Tintreach, the '
    + 'lightning arrows. Take a torch: underground without one is genuinely '
    + 'black. You cannot save while you are down there, so leave by the portal '
    + 'before you stop for the night.'],

  ['The chart',
    'Escape unrolls a cloth map and stops the world while it is open. Every '
    + 'patch of ground you have walked is sewn onto it, roads and all, and the '
    + 'gold knot is you. Saving, loading, settings and this page all live '
    + 'beside it, so pausing is one press and one place.'],

  ['Talking to people',
    'Walk up to anyone and press E. They are not a menu — type whatever you '
    + 'want to say and press Enter, or hold V (LB on a pad) and just say it, '
    + 'and your words will drop into the box for you to send. They remember '
    + 'you between conversations, they will haggle, they can be asked to '
    + 'follow you or to wait, and they can absolutely be talked into hating '
    + 'you. Guards especially.'],

  ['Fighting',
    'Press Z, middle-click, or pull the left trigger to lock on to whatever '
    + 'you are facing within about twenty metres. Locked on, the camera holds '
    + 'them in frame and you keep your front to them as you circle, instead of '
    + 'showing them your shoulder. Tab, or a flick of the right stick, moves '
    + 'to the next one. It does not aim for you: an arrow always goes exactly '
    + 'where the reticle is pointing, locked on or not.'],
];

const CLOSER = 'Everything else is yours to find. Press H at any time for the '
  + 'full list of controls.';

// ---------------------------------------------------------------------------
// Rendering. Up to three columns, collapsing as the host narrows, so the same
// element reads correctly on the 1180 px chart and in a free-standing panel.
// ---------------------------------------------------------------------------

function topic([title, body]: Topic): HTMLElement {
  const t = document.createElement('div');
  // A topic must not be split down the middle of the page, or the heading ends
  // one column and its paragraph starts the next.
  t.style.cssText = 'break-inside:avoid; page-break-inside:avoid; margin:0 0 16px;';

  const h = document.createElement('div');
  h.style.cssText = 'font:600 11px system-ui,sans-serif; letter-spacing:0.10em; '
    + `text-transform:uppercase; color:${GOLD}; margin:0 0 5px;`;
  h.textContent = title;

  const p = document.createElement('div');
  p.style.cssText = 'font:500 11.5px system-ui,sans-serif; line-height:1.62; '
    + 'opacity:0.84; margin:0;';
  p.textContent = body;

  t.append(h, p);
  return t;
}

/**
 * The primer with no frame around it.
 *
 * CSS multi-column rather than flex: the topics are prose of wildly different
 * lengths, and columns balance them for free where a flex split would leave one
 * side half empty. Up to THREE columns, because the chart is 1180 px wide and
 * the alternative is a page that runs off the bottom of a 720 p window — a
 * read-only page has almost nothing for a pad to focus, so scrolling one is the
 * thing a controller is worst at. Wide-and-short beats narrow-and-long here.
 * The 340 px floor is what collapses it to two columns, then one, in a narrow
 * host such as the free-standing panel.
 */
export function buildHelpContent(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'help-content';
  root.style.cssText = `columns:340px 3; column-gap:38px; color:${CREAM};`;
  for (const t of TOPICS) root.appendChild(topic(t));

  const closer = document.createElement('div');
  closer.style.cssText = 'break-inside:avoid; font:500 10px system-ui,sans-serif; '
    + 'opacity:0.5; line-height:1.6; padding-top:10px; '
    + 'border-top:1px dashed rgba(240,230,200,0.34);';
  closer.textContent = CLOSER;
  root.appendChild(closer);

  return root;
}

/**
 * The free-standing panel, if main.ts ever wants Help on a key of its own.
 *
 * Re-dyed as cloth for the same reason the controls panel is: `.game-panel`'s
 * blue-grey belongs to the old UI, and this text also appears on the chart.
 */
export function buildHelpPanel(): HTMLElement {
  const el = document.createElement('div');
  // Not `help-panel` — that id belongs to the CONTROLS panel on KeyH, which has
  // carried it since it was built inline in main.ts and which
  // scripts/controller-ui-check.mjs asserts on. See controls-panel.ts.
  el.id = 'how-to-play-panel';
  el.style.cssText = [
    'background:#3b3122',
    'border:1px dashed rgba(240,230,200,0.42)',
    'border-radius:4px',
    `color:${CREAM}`,
    'width:min(780px, 92vw)',
    'max-height:86vh',
    'overflow-y:auto',
    'padding:14px 18px',
    'right:50%',
    'transform:translate(50%, -50%)',
  ].join(';');

  const h = document.createElement('h2');
  h.style.cssText = 'font:600 14px system-ui,sans-serif; letter-spacing:0.10em; '
    + `text-transform:uppercase; color:${CREAM}; margin:0 0 12px;`;
  h.textContent = 'How to play';
  el.appendChild(h);

  el.appendChild(buildHelpContent());
  return el;
}
