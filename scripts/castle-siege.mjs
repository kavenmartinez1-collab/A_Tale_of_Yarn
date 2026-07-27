/**
 * Plays the castle AFTER the escape: comes back, gets attacked, and wins.
 *
 *   node scripts/castle-siege.mjs [outDir]
 *
 * ## Why this exists on top of `castle-escape.mjs` and `test-castle-fight.mts`
 *
 * `test-castle-fight.mts` proves the garrison stands on real floors and the
 * fight's state machine has the right shape. `castle-escape.mjs` proves the
 * opening is walkable and visible. Neither can prove the castle is DANGEROUS —
 * and this repo's standing lesson is that a weapon can look completely active
 * and deal exactly zero damage for its entire steady state, which is what the
 * mounted breath had been doing.
 *
 * So the only claim this file makes is one it measures:
 *
 *   1. the escape is unopposed        — player hp does not move, nothing aggros
 *   2. coming back wakes the castle   — alarm=hunting, garrison in 'aggro'
 *   3. the garrison actually attacks  — player hp DROPS with the bosses far off
 *   4. the dragon's breath connects   — hp drops during a 'burning' stage
 *   5. the player's own swing lands   — boss hp drops from real left-clicks
 *   6. the fight has phases           — circle -> strafe -> grounded -> dismounted
 *   7. both bosses die                — through the real death path
 *
 * Every one of those is a number in the summary, not a screenshot.
 *
 * ## What is accelerated, and what is not
 *
 * Beat 5 is real: the harness walks into reach and left-clicks, and the assert
 * is that boss hp fell BECAUSE of that. Grinding all 560 hp that way would take
 * ~140 connected swings and many minutes of wall clock, so once real damage is
 * proven the rest is driven through `__gameDebug.castleDamageBoss`, which goes
 * through `damageEntityFromMount` — the same function the player's sword calls.
 * The deaths, the phase changes and the dismount are therefore the real ones.
 *
 * ## Harness hazards this repo has actually hit
 *
 * A parallel agent hot-reloading the page mid-capture once produced a filmstrip
 * where every frame was at the spawn point, filed as real beats. The boot
 * sentinel and the frame-counter check below are kept from `castle-escape.mjs`
 * for that reason; a run that reloads is reported as INVALID rather than
 * summarised.
 *
 * Camera: the orbit camera sits BEHIND the player. Walking toward (tx,tz) is
 * `setCamera(atan2(-(tx-px), -(tz-pz)))` and holding W. The sign that looks
 * right walks you away.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/castle-siege';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 300)}`);
  }
});

await page.goto('http://localhost:5173/game.html?wipe=1&director=off&tod=0.30&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { window.__siegeToken = 1; });

let shot = 0;
const log = [];
const failures = [];
let reloads = 0;
let reboots = 0;
let lastFrames = 0;

function expect(name, cond, detail) {
  if (!cond) {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  !! FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function alive(fn, arg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ok = await page.evaluate(() => window.__gameReady === true
        && window.__siegeToken === 1
        && typeof window.__gameDebug?.castleFight === 'function');
      if (ok) {
        // A Vite module hot-swap keeps the window (and the sentinel) but
        // re-runs boot(): the frame counter going backwards is the only tell.
        const frames = await page.evaluate(() => window.__gameStats?.frames ?? 0);
        if (frames + 5 < lastFrames) {
          reboots++;
          console.log(`     !! game re-booted mid-run (frames ${lastFrames} -> ${frames})`);
        }
        lastFrames = frames;
        return await page.evaluate(fn, arg);
      }
    } catch { /* context destroyed */ }
    reloads++;
    await page.waitForFunction(() => window.__gameReady === true, undefined,
      { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__siegeToken = 1; }).catch(() => {});
  }
  throw new Error('page never came back after a reload');
}

async function state() {
  return alive(() => ({
    pos: window.__gameDebug.playerPos().map((v) => Math.round(v * 10) / 10),
    hp: window.__gameDebug.vitals().hp,
    castle: window.__gameDebug.castle(),
    fight: window.__gameDebug.castleFight(),
    fps: Math.round(window.__gameStats.fps ?? 0),
  }));
}

async function snap(note) {
  const st = await state();
  const name = `${String(shot).padStart(2, '0')}-${note.replace(/[^a-z0-9]+/gi, '-')}.png`;
  await page.screenshot({ path: path.join(outDir, name) });
  log.push({ shot: name, note, ...st });
  console.log(`  ${name.padEnd(38)} pos ${JSON.stringify(st.pos)} hp=${st.hp} `
    + `alarm=${st.castle.alarm} phase=${st.fight.phase} fps=${st.fps}`);
  shot++;
  return st;
}

/** Hold W toward a world XZ until arrival or timeout. */
async function walkTo(target, seconds, note, { sprint = false, pitch = 0.3,
  dist = 5.5, tol = 2.5 } = {}) {
  const TICK = 0.3;
  const steps = Math.max(1, Math.round(seconds / TICK));
  if (sprint) await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  let arrived = false;
  for (let i = 0; i < steps && !arrived; i++) {
    arrived = await alive(([t, p, d, tl]) => {
      const g = window.__gameDebug;
      const [px, , pz] = g.playerPos();
      g.setCamera(Math.atan2(-(t[0] - px), -(t[1] - pz)), p, d);
      return Math.hypot(t[0] - px, t[1] - pz) <= tl;
    }, [target, pitch, dist, tol]);
    await page.waitForTimeout(TICK * 1000);
  }
  await page.keyboard.up('KeyW');
  if (sprint) await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(250);
  return snap(note);
}

const verdict = {};

// ===========================================================================
console.log('\n=== 1. the garrison exists, and is asleep ===');
// ===========================================================================

const g0 = await alive(() => window.__gameDebug.castleGarrison());
console.log(`  ${g0.length} posts, ${g0.filter((p) => p.live).length} live`);
for (const p of g0.slice(0, 20)) {
  console.log(`    ${p.id.padEnd(11)} ${p.species.padEnd(9)} @ ${p.station.padEnd(21)} `
    + `${p.live ? p.mode : '(not live)'}`);
}
expect('the castle has a garrison', g0.length >= 12, `${g0.length} posts`);
expect('the garrison is live near the player', g0.filter((p) => p.live).length === g0.length,
  `${g0.filter((p) => p.live).length}/${g0.length} live`);
expect('every post is a goblin or a skeleton',
  g0.every((p) => p.species === 'goblin' || p.species === 'skeleton'),
  [...new Set(g0.map((p) => p.species))].join(', '));
expect('nothing is aggro before the alarm',
  g0.every((p) => p.mode !== 'aggro'),
  g0.filter((p) => p.mode === 'aggro').map((p) => p.id).join(', ') || 'none');

const start = await snap('woke-in-the-cell');
verdict.startHp = start.hp;

// ===========================================================================
console.log('\n=== 2. the escape is unopposed ===');
// ===========================================================================

const marks = await alive((names) => {
  const g = window.__gameDebug;
  const out = {};
  for (const n of names) out[n] = g.castleMarkerPos(n);
  return out;
}, ['chest', 'undercroftStairFoot', 'undercroftStairHead', 'L1hall',
  'frontCourt', 'breach', 'breachFoot', 'outside', 'arena', 'spawn']);

// Walk the real route out, with castle-escape.mjs's leg parameters — which are
// not decoration. Sprinting a stairwell overshoots the landing and grinds the
// player along the wall until the beat times out, and the first version of this
// file did exactly that: every "courtyard" and "breach" beat was filed from
// inside the undercroft at y 28.6, eight metres below the courtyard, because
// the stair climb had silently failed nine beats earlier.
const leg = async (to, s, name, opts) => walkTo(to, s, name, opts);

await leg([marks.chest[0], marks.chest[2]], 7, 'at-the-chest', { tol: 2.2 });
await page.keyboard.press('KeyE');
await page.waitForTimeout(500);
const chestNow = await alive(() => window.__gameDebug.castle().chestOpened);
expect('the chest opened', chestNow === true, `chestOpened=${chestNow}`);

const stairHead = marks.undercroftStairHead;
await leg([marks.undercroftStairFoot[0], marks.undercroftStairFoot[2]], 6, 'stair-foot');
await leg([stairHead[0], stairHead[2]], 10, 'climbed-the-stair');
await leg([stairHead[0], stairHead[2] + 7], 5, 'onto-level-one');
await leg([marks.L1hall[0], marks.L1hall[2] + 7], 8, 'across-the-hall');
const inHall = await leg([marks.L1hall[0], marks.L1hall[2]], 5, 'the-great-hall');
expect('the stair actually went up', inHall.pos[1] > marks.spawn[1] + 6,
  `y ${inHall.pos[1]}, the cell floor is ${marks.spawn[1].toFixed(1)}`);
await leg([marks.L1hall[0], marks.L1hall[2] - 30], 9, 'through-the-keep-door',
  { pitch: 0.12, dist: 7 });
await leg([marks.frontCourt[0], marks.frontCourt[2]], 9, 'the-courtyard',
  { pitch: 0.05, dist: 8 });
await leg([marks.breach[0] - 14, marks.breach[2]], 11, 'along-the-wall',
  { sprint: true, pitch: 0.1, dist: 8 });
const atBreach = await leg([marks.breach[0], marks.breach[2]], 8, 'the-breach',
  { pitch: 0.1, dist: 8 });

// The unopposed claim is measured HERE, at the last beat inside the walls.
//
// Not at the end of the route, and the difference is not pedantry: the breach
// causeway drops 29 m over 46 m, and sprinting down it costs about 8 hp of
// FALL damage. An end-of-route assertion reads that as "something attacked me
// during the escape" and sends you looking for a goblin that does not exist.
// What the opening actually promises is that nothing in the castle touches
// you, and that is what this asserts.
verdict.hpInsideTheWalls = atBreach.hp;
expect('crossed the whole castle without being touched', atBreach.hp === start.hp,
  `hp ${start.hp} -> ${atBreach.hp} between the cell and the breach`);

await leg([marks.breachFoot[0], marks.breachFoot[2]], 14, 'down-the-causeway',
  { sprint: true, pitch: 0.18, dist: 9 });
const out = await leg([marks.outside[0], marks.outside[2]], 10, 'into-the-wilderness',
  { sprint: true, pitch: 0.15, dist: 9 });
verdict.causewayFall = atBreach.hp - out.hp;
if (verdict.causewayFall > 0) {
  console.log(`  (note: ${verdict.causewayFall} hp of FALL damage sprinting the `
    + `causeway, ${atBreach.pos[1]} m -> ${out.pos[1]} m — not an attack)`);
}
const escaped = await state();
verdict.escapeHp = escaped.hp;
expect('the alarm stayed dormant through the escape',
  escaped.castle.alarm === 'dormant', escaped.castle.alarm);
expect('got out of the curtain wall', escaped.castle.escaped);

const gEsc = await alive(() => window.__gameDebug.castleGarrison());
expect('nothing woke up during the escape',
  gEsc.every((p) => !p.live || p.mode !== 'aggro'),
  gEsc.filter((p) => p.mode === 'aggro').length + ' aggro');

// ===========================================================================
console.log('\n=== 3. coming back wakes the castle ===');
// ===========================================================================

const a1 = await alive(() => window.__gameDebug.castleAlarmStep('depart'));
await page.waitForTimeout(700);
expect('leaving trips departed', a1 === 'departed', a1);
const a2 = await alive(() => window.__gameDebug.castleAlarmStep('return'));
await page.waitForTimeout(900);
expect('returning trips hunting', a2 === 'hunting', a2);
verdict.alarm = [escaped.castle.alarm, a1, a2];

// Give the player a weapon and full health for the fight.
await alive(() => {
  const g = window.__gameDebug;
  g.giveItem('iron_sword', 1);
  g.equipItem('iron_sword');
  g.setVitals({ hp: 20, stamina: 100 });
});
await page.waitForTimeout(300);

// ===========================================================================
console.log('\n=== 4. the garrison actually attacks ===');
// ===========================================================================

// Put the player in the front courtyard, well away from the bosses, so any
// damage taken here can only have come from a goblin or a skeleton.
await alive(() => window.__gameDebug.castleTeleport('frontCourt'));
await page.waitForTimeout(1200);
await alive(() => window.__gameDebug.setVitals({ hp: 20, stamina: 100 }));
await snap('back-in-the-courtyard');

let mobHpStart = 20;
let mobHpEnd = 20;
let engaged = 0;
let breathTicksDuringMob = 0;
{
  const f0 = await alive(() => window.__gameDebug.castleFight());
  const before = await state();
  mobHpStart = before.hp;
  // Stand still and let them come. 18 s is comfortably more than the walk from
  // anywhere in the courtyard at goblin speed (4.8 m/s).
  //
  // The dragon orbits the PLAYER, not the castle, so it is overhead here too
  // and its breath reaches the courtyard. Attributing its damage to a goblin
  // would make this beat a lie that happens to pass, so the breath tick counter
  // is read at both ends and the beat only claims the garrison hurt the player
  // if NO breath tick landed in between.
  for (let i = 0; i < 36; i++) {
    await page.waitForTimeout(500);
    const s2 = await alive(() => ({
      hp: window.__gameDebug.vitals().hp,
      g: window.__gameDebug.castleGarrison(),
      f: window.__gameDebug.castleFight(),
    }));
    engaged = Math.max(engaged, s2.g.filter((p) => p.mode === 'aggro').length);
    // Breath FIRST, and `mobHpEnd` only from samples taken before any landed.
    //
    // It used to record the hp and then check, so the contaminated sample's hp
    // was already in the number the beat reported. That was invisible while the
    // garrison killed fast enough to finish inside 18 s, and stopped being
    // invisible when attack tokens capped the garrison to two attackers: the
    // window now runs long enough for the orbiting dragon to get a breath in,
    // and the beat aborted with 4.84 hp of MIXED damage on the books.
    //
    // Keeping only pre-breath samples means `mobHpEnd - mobHpStart` is melee
    // and nothing else, by construction, which is what the beat always claimed.
    breathTicksDuringMob = s2.f.breathHits - f0.breathHits;
    if (breathTicksDuringMob > 0) break;
    mobHpEnd = s2.hp;
    if (mobHpEnd <= 8) break;
  }
  await snap('under-attack-in-the-courtyard');
}
verdict.mobHp = [mobHpStart, mobHpEnd];
verdict.mobEngaged = engaged;
verdict.breathTicksDuringMob = breathTicksDuringMob;
expect('the garrison engages once hunting', engaged > 0, `${engaged} in aggro`);
// The garrison is now capped at two simultaneous attackers by the melee token
// pool (`combat/attack-tokens.ts`), so this beat measures a deliberately
// slower grind than it used to. What it must still prove is that the grind is
// real and that it is MELEE — hence the pre-breath-only sampling above.
expect('the garrison damage measured is melee only, with no breath in it',
  mobHpEnd < mobHpStart || breathTicksDuringMob === 0,
  `hp ${mobHpStart} -> ${mobHpEnd}, ${breathTicksDuringMob} breath tick(s) after the window`);
expect('the garrison actually hurts the player', mobHpEnd < mobHpStart,
  `hp ${mobHpStart} -> ${mobHpEnd} from melee alone`);
expect('...and no more than two of them are ever engaged at once',
  engaged <= 2, `${engaged} in aggro simultaneously`);

// And they can be killed.
{
  const alive0 = (await alive(() => window.__gameDebug.castleGarrison()))
    .filter((p) => !p.dead).length;
  // AIM before swinging. The melee hit test needs the target inside 3.2 m AND
  // `dot(facing, toTarget) > 0.3`; the first version just clicked 40 times
  // wherever `castleTeleport` had left the camera and killed nobody, while the
  // player's own health fell by twelve — which reads as "goblins are
  // invincible" rather than "the harness swung at a wall".
  // Top the player up each swing. Not to make it easy — the damage beat above
  // already proved the garrison hurts — but because at 6.8 hp after that beat
  // the player DIES two goblin blows in, `doRespawn` teleports them to the
  // breach foot, and the remaining eighty swings hit empty wilderness. The run
  // then reports "garrison members cannot be killed", which is true of the
  // harness and false of the game. That is exactly the kind of green-looking
  // nonsense this file exists to avoid, so the beat states its own precondition.
  let swings = 0;
  let inReach = 0;
  for (let i = 0; i < 90; i++) {
    const r = await alive(() => {
      const g = window.__gameDebug;
      g.setVitals({ hp: 20, stamina: 100 });
      const [px, py, pz] = g.playerPos();
      let best = null;
      let bestD = 1e9;
      for (const p of g.castleGarrison()) {
        if (p.dead || !p.live) continue;
        const d = Math.hypot(p.x - px, p.z - pz);
        if (d < bestD && Math.abs(p.y - py) < 3) { bestD = d; best = p; }
      }
      if (best === null) return { swung: false, near: 1e9 };
      g.setCamera(Math.atan2(-(best.x - px), -(best.z - pz)), 0.15, 4.5);
      // `leftClick` -> `resolveLeftClick` snaps `controller.yaw` from the
      // camera before it hit-tests, so setting both in one evaluate is safe.
      if (bestD <= 3.1) { g.leftClick(); return { swung: true, near: bestD }; }
      return { swung: false, near: bestD };
    });
    if (r.swung) { swings++; inReach++; }
    await page.waitForTimeout(110);
  }
  console.log(`  ${swings} swings landed in reach (nearest garrison member `
    + 'tracked each frame)');
  verdict.garrisonSwings = swings;
  void inReach;
  const g2 = await alive(() => window.__gameDebug.castleGarrison());
  const alive1 = g2.filter((p) => !p.dead).length;
  verdict.garrisonKilled = alive0 - alive1;
  expect('garrison members can be killed', alive1 < alive0,
    `${alive0} -> ${alive1} alive`);
}

// ===========================================================================
console.log('\n=== 5. the dragon fights ===');
// ===========================================================================

await alive(() => window.__gameDebug.castleTeleport('arena'));
await page.waitForTimeout(1500);
await alive(() => window.__gameDebug.setVitals({ hp: 20, stamina: 100 }));

// Aim the camera at the dragon for the money shot, then hold still and let it
// breathe. Standing still is the point: the aim latches at the tell, so a
// stationary player MUST be hit, and a breath that does not land here is the
// zero-damage failure this whole harness exists to catch.
let sawTell = false;
let sawBurn = false;
let burnFrames = 0;
let hpAtBurnStart = null;
let hpAtBurnEnd = null;
let breathHitsAtJetStart = 0;
let breathHitsAtBurnEnd = 0;
let diedInTheJet = false;
let lostInJet = 0;
// ARMOUR OFF FOR THIS BEAT, AND PUT BACK AFTER.
//
// This is what made 'breath damage is accounted for inside the total' fail with
// `breath 12 hp vs 7.04 hp lost in total`. Nothing was wrong with the breath.
//
// `BOSS_BREATH_DMG` is 2 and the beat multiplied the tick count by it, which is
// the NOMINAL figure. The tick then goes through `applyAttackOnPlayer(2,
// 'animal', 'ranged', …)` -> `damagePlayer(v, 2, 'animal', totalDefense(inv))`,
// and `'animal'` is in `PHYSICAL_CAUSES`, so armour scales it by
// `max(0.40, 1 - min(0.60, defense * 0.04))`. The demo player wears 14 points
// of it: measured in `scripts/king-melee-check.mjs`, the King's 5-damage swing
// takes exactly 2.2 hp off, i.e. a multiplier of 0.44. So six ticks are 12 hp
// nominal and 5.28 hp of actual health, and the beat was comparing one against
// the other. It "passed sometimes" because on a cycle with fewer ticks and more
// help from the guards the wrong inequality happens to hold.
//
// Stripping the armour removes the unknown from the measurement instead of
// modelling it — with defense 0 the nominal figure IS the health lost, which is
// what the assertion has always claimed to compare. Restored immediately after,
// because the phase beats below want the player the game actually ships.
const savedArmor = await alive(() => {
  const inv = window.__gameDebug.inventory();
  const was = {
    head: inv.armor.head?.id ?? null,
    body: inv.armor.body?.id ?? null,
    legs: inv.armor.legs?.id ?? null,
  };
  window.__gameDebug.setArmor({ head: null, body: null, legs: null });
  return was;
});
console.log(`  armour off for the measurement (was `
  + `${JSON.stringify(savedArmor)}); every hp below is unmitigated`);

// The arena's own skeleton guards are the other confound: they land hits
// DURING the jet, where the between-jet top-up cannot reach, and an
// unarmoured full-health player can be taken below zero by jet+guards
// together — the beat then dies mid-jet and truncates its own totals (it
// failed exactly that way once the armour strip landed). This beat measures
// BREATH; the guards are noise in it. Clear them from the arena for the
// measurement only — the fight beats before and after keep the full garrison.
{
  const cleared = await alive(() => {
    const g = window.__gameDebug;
    const arena = g.castleMarkerPos('arena');
    if (arena === null) return 0;
    let n = 0;
    for (const e of g.entities()) {
      if (e.species !== 'skeleton' && e.species !== 'goblin') continue;
      if (Math.hypot(e.x - arena[0], e.z - arena[2]) > 30) continue;
      if (g.removeEntity(e.id)) n++;
    }
    return n;
  });
  console.log(`  arena guards cleared for the breath measurement: ${cleared}`);
}
{
  // Sample at 150 ms. The tell is 1.1 s and the jet 1.6 s, so this cannot
  // stride over a whole stage — the first version sampled at 250 ms AND broke
  // out at hp <= 4, and since a connected jet takes a full-health player to 4
  // in about two seconds it exited before it had classified a single frame.
  // It then reported "the dragon never telegraphs" about a breath that had
  // just taken sixteen hp off the player.
  let hp = null;
  // The sample immediately before the jet started: the window's origin.
  let prevHits = 0;
  let prevHp = 20;
  lostInJet = 0;
  for (let i = 0; i < 220; i++) {
    const s = await alive(() => {
      const g = window.__gameDebug;
      const d = g.castleDragon();
      const [px, py, pz] = g.playerPos();
      if (d !== null) {
        const flat = Math.hypot(d.x - px, d.z - pz);
        g.setCamera(Math.atan2(-(d.x - px), -(d.z - pz)),
          -Math.max(0.05, Math.min(0.55, Math.atan2(d.y - py, flat) * 0.6)), 11);
      }
      return { hp: g.vitals().hp, f: g.castleFight() };
    });
    hp = s.hp;
    if (s.f.breath !== 'burning') {
      // Top up whenever the jet is NOT burning, so the player is never killed
      // by the arena's skeleton guards between cycles — a dead player freezes
      // the controller and every damage source, and the beat then measures a
      // breath that has simply stopped being applied.
      await alive(() => window.__gameDebug.setVitals({ hp: 20, stamina: 100 }));
      // The window opens at the last sample BEFORE the jet, whatever stage that
      // sample was in. Latching only on 'tell' looked equivalent and is not: a
      // run that sampled straight from 'none' into 'burning' left the start
      // count at 0, so `jetTicks` became every tick since the page loaded and
      // the beat reported "breath 24 hp vs 0.00 hp lost in total" — twelve
      // ticks from the whole session weighed against one cycle's health.
      prevHits = s.f.breathHits;
      prevHp = 20; // just set, above
    }
    if (s.f.breath === 'tell') {
      sawTell = true;
    } else if (s.f.breath === 'burning') {
      sawBurn = true;
      if (hpAtBurnStart === null) {
        hpAtBurnStart = prevHp;
        breathHitsAtJetStart = prevHits;
      }
      hpAtBurnEnd = s.hp;
      // Health lost is accumulated PER SAMPLE, not endpoint-to-endpoint, so
      // the player can be topped up mid-jet without corrupting the total.
      // Endpoint arithmetic required the player to SURVIVE the whole jet, and
      // an unarmoured 20 hp player cannot: the jet alone is ~10 and the
      // garrison respawns behind removeEntity (documented in king-melee-check)
      // and lands ~10 more DURING it — the beat died mid-jet and truncated its
      // own numbers. Per-sample deltas measure the weapon whoever else is
      // swinging, and the top-up keeps the subject alive to finish the jet.
      lostInJet += Math.max(0, prevHp - s.hp);
      if (s.hp <= 8) {
        await alive(() => window.__gameDebug.setVitals({ hp: 20, stamina: 100 }));
        prevHp = 20;
      } else {
        prevHp = s.hp;
      }
      // The tick count from the SAME sample as the health, not from a read
      // after the loop. The loop exits on the first 'none' frame, so up to a
      // sampling interval of jet can still be running past the last health
      // reading — and `fEnd.breathHits` counted those ticks against a total
      // that had stopped being measured. One tick of window mismatch is 2 hp
      // on a 20 hp bar.
      breathHitsAtBurnEnd = s.f.breathHits;
      if (s.hp <= 0) diedInTheJet = true;
      if (burnFrames < 3 && s.f.breathGeom !== null) {
        console.log(`     burn: ${JSON.stringify(s.f.breathGeom)} `
          + `hits=${s.f.breathHits}`);
      }
      burnFrames++;
    }
    if (i === 24) await snap('the-king-over-his-castle');
    // One full tell -> burn -> done cycle measured is enough.
    if (sawBurn && s.f.breath === 'none' && hpAtBurnEnd !== null) break;
    await page.waitForTimeout(150);
  }
  void hp;
  await snap('after-the-breath');
}
await alive((was) => window.__gameDebug.setArmor(was), savedArmor);
verdict.breathHp = [hpAtBurnStart, hpAtBurnEnd];
const fEnd = await alive(() => window.__gameDebug.castleFight());
verdict.breathHits = fEnd.breathHits;
expect('the dragon telegraphs its breath', sawTell);
expect('the dragon actually breathes', sawBurn);
// The per-sample accumulator plus the mid-jet top-up keeps the subject alive
// through the whole jet, so death here can only mean a >12 hp single sample —
// i.e. the top-up threshold is wrong, and the totals really are truncated.
expect('the measurement survived the whole jet',
  !diedInTheJet, 'a single 150 ms sample exceeded the top-up margin');
const jetTicks = breathHitsAtBurnEnd - breathHitsAtJetStart;
verdict.jetTicks = jetTicks;
expect('the breath connects with a stationary player',
  hpAtBurnStart !== null && hpAtBurnEnd !== null && hpAtBurnEnd < hpAtBurnStart,
  `hp ${hpAtBurnStart} -> ${hpAtBurnEnd}`);
// Separate the breath's contribution from everything else's, rather than
// assuming the jet was the only thing hitting the player.
//
// It is not, and that is the design rather than a flaw: `arena` is a garrison
// station with two skeletons on it, so a player standing on the tower during
// the fight is being breathed on AND chopped at. Asserting equality made this
// beat fail while everything it describes was working.
//
// `* 2` is `BOSS_BREATH_DMG`, and it is only the health lost because the
// armour came off above. With the demo player's kit on, the same six ticks
// were 12 hp of nominal damage against 6.6 hp of actual health — 1.1 hp a
// tick — and the inequality below failed on arithmetic that had nothing to do
// with the dragon.
const breathPart = jetTicks * 2;
const total = lostInJet;
verdict.jetBreathHp = breathPart;
verdict.jetOtherHp = Math.round((total - breathPart) * 100) / 100;
expect('the breath itself lands real damage', jetTicks > 0,
  `${jetTicks} tick(s) x 2 = ${breathPart} hp`);
expect('breath damage is accounted for inside the total',
  breathPart <= total + 0.001,
  `breath ${breathPart} hp vs ${total.toFixed(2)} hp lost in total`);
console.log(`  (of ${total.toFixed(1)} hp lost on the arena, ${breathPart} was the `
  + `breath and ${(total - breathPart).toFixed(1)} the two skeleton guards)`);

// ===========================================================================
console.log('\n=== 6. the player can hurt the bosses ===');
// ===========================================================================

// Real swings. Wait for a swoop to bring the dragon inside 3.2 m, then click.
let realHits = 0;
let dragonHp0 = null;
let dragonHp1 = null;
{
  await alive(() => window.__gameDebug.setVitals({ hp: 20, stamina: 100 }));
  dragonHp0 = (await alive(() => window.__gameDebug.castleFight())).dragonHp;
  for (let i = 0; i < 260; i++) {
    const r = await alive(() => {
      const g = window.__gameDebug;
      const d = g.castleDragon();
      if (d === null) return null;
      const [px, py, pz] = g.playerPos();
      const flat = Math.hypot(d.x - px, d.z - pz);
      // Face it, so the melee dot-product gate passes.
      g.setCamera(Math.atan2(-(d.x - px), -(d.z - pz)), 0.1, 5);
      const inReach = flat <= 3.2 && Math.abs(d.y + 2.2 - py) <= 6.9;
      if (inReach) g.leftClick();
      return { inReach, flat: Math.round(flat * 10) / 10,
        hp: g.castleFight().dragonHp };
    });
    if (r === null) break;
    if (r.inReach) realHits++;
    dragonHp1 = r.hp;
    if (realHits > 10) break;
    await page.waitForTimeout(100);
  }
  await snap('swinging-at-the-dragon');
}
verdict.realHits = realHits;
verdict.dragonHpFromRealSwings = [dragonHp0, dragonHp1];
expect('a swoop brings the dragon inside sword reach', realHits > 0,
  `${realHits} frames in reach over 26 s`);
expect('the player\'s own swing damages the dragon',
  dragonHp1 !== null && dragonHp0 !== null && dragonHp1 < dragonHp0,
  `dragon hp ${dragonHp0} -> ${dragonHp1}`);

// ===========================================================================
console.log('\n=== 7. the fight has phases, and can be won ===');
// ===========================================================================

const phases = [];
{
  const seen = new Set();
  const record = async () => {
    const f = await alive(() => window.__gameDebug.castleFight());
    if (!seen.has(f.phase)) { seen.add(f.phase); phases.push(f.phase); }
    return f;
  };
  await record();
  // Drive the dragon down through its phases, letting each settle so the
  // transition is the real one rather than a single step past a threshold.
  for (let i = 0; i < 40; i++) {
    const hp = await alive((n) => window.__gameDebug.castleDamageBoss('dragon', n), 24);
    await page.waitForTimeout(400);
    const f = await record();
    if (f.phase === 'grounded' && !seen.has('_shot')) {
      seen.add('_shot');
      await snap('the-dragon-is-down');
    }
    if (hp === null || hp <= 0) break;
  }
  await page.waitForTimeout(1500);
  const afterDragon = await record();
  verdict.dragonMode = afterDragon.dragonMode;
  expect('the dragon dies', afterDragon.dragonMode === 'dead', afterDragon.dragonMode);
  expect('the King is unseated when his mount dies',
    afterDragon.kingMounted === false, `kingMounted=${afterDragon.kingMounted}`);
  await snap('the-king-on-his-feet');

  // Now the King, on foot.
  for (let i = 0; i < 40; i++) {
    const hp = await alive((n) => window.__gameDebug.castleDamageBoss('king', n), 28);
    await page.waitForTimeout(300);
    if (hp === null || hp <= 0) break;
  }
  await page.waitForTimeout(1200);
  const done = await record();
  verdict.kingMode = done.kingMode;
  verdict.phases = phases;
  expect('the King dies', done.kingMode === 'dead', done.kingMode);
  expect('the fight passed through every phase',
    ['circle', 'strafe', 'grounded', 'dismounted'].every((p) => phases.includes(p)),
    phases.join(' -> '));
  await snap('the-castle-is-yours');
}

// ===========================================================================
console.log('\n=== 8. it survives a reload ===');
// ===========================================================================
{
  const before = await alive(() => ({
    c: window.__gameDebug.castle(),
    g: window.__gameDebug.castleGarrison().filter((p) => p.dead).length,
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.__siegeToken = 1; });
  lastFrames = 0;
  const after = await alive(() => ({
    c: window.__gameDebug.castle(),
    g: window.__gameDebug.castleGarrison().filter((p) => p.dead).length,
  }));
  verdict.reload = { before, after };
  console.log(`  alarm ${before.c.alarm} -> ${after.c.alarm}, `
    + `chest ${before.c.chestOpened} -> ${after.c.chestOpened}, `
    + `dead ${before.g} -> ${after.g}`);
  expect('the alarm survives a reload', after.c.alarm === before.c.alarm,
    `${before.c.alarm} -> ${after.c.alarm}`);
  expect('the chest stays open across a reload', after.c.chestOpened === true,
    `${after.c.chestOpened}`);
  expect('the dead stay dead across a reload', after.g === before.g,
    `${before.g} -> ${after.g}`);
  await snap('after-the-reload');
}

// ---------------------------------------------------------------------------

verdict.beatFailures = failures;
verdict.reloads = reloads;
verdict.reboots = reboots;
verdict.errors = errors;
fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify({ verdict, log }, null, 1), 'utf-8');

console.log('\n--- summary ---');
console.log(`alarm:          ${(verdict.alarm ?? []).join(' -> ')}`);
console.log(`escape hp:      ${verdict.startHp} -> ${verdict.hpInsideTheWalls} `
  + `crossing the castle (untouched), then -${verdict.causewayFall} to the causeway fall`);
console.log(`mob damage:     ${(verdict.mobHp ?? []).join(' -> ')} `
  + `with ${verdict.mobEngaged} engaged, ${verdict.breathTicksDuringMob} breath ticks`);
console.log(`breath damage:  ${verdict.jetBreathHp} hp from ${verdict.jetTicks} ticks `
  + `(+${verdict.jetOtherHp} from the arena guards); ${verdict.breathHits} ticks all run`);
console.log(`real swings:    ${verdict.realHits} in reach, dragon `
  + `${(verdict.dragonHpFromRealSwings ?? []).join(' -> ')}`);
console.log(`phases:         ${(verdict.phases ?? []).join(' -> ')}`);
console.log(`bosses:         dragon=${verdict.dragonMode} king=${verdict.kingMode}`);
if (reboots > 0 || reloads > 0) {
  console.log(`RUN QUALITY:    ${reloads} reload(s), ${reboots} reboot(s) — `
    + 'treat these numbers with suspicion');
}
console.log(failures.length ? `\n${failures.length} BEAT FAILURE(S):\n  ` + failures.join('\n  ')
  : '\nall beats passed');
console.log(errors.length ? `${errors.length} page error(s):\n  ` + errors.slice(0, 6).join('\n  ')
  : 'no page errors');

await browser.close();
if (errors.length || failures.length) process.exitCode = 1;
