/**
 * The genuine boss kill — the demo gate's centrepiece.
 *
 *   node scripts/boss-kill-real.mjs
 *
 * Every prior proof of the final fight was partial: `castle-siege.mjs` proves
 * real swings LAND (dragon 260 -> 248) and then grinds the remaining ~550 hp
 * through `castleDamageBoss`, a debug hook. Nobody — human or harness — has
 * ever taken both bosses from full health to dead through the player's own
 * weapons. This does, and asserts it.
 *
 * What is REAL here (the claim): every point of boss damage goes through
 * `releaseBowDraw()` — the player's own release function — via the
 * `looseArrow(1)` hook, which sets genuine draw state and calls it. Real ammo
 * is consumed from the real inventory, the real aim resolve picks the impact,
 * and damage routes through the same path a playing human's shot does.
 * `castleDamageBoss` is never called; nothing touches boss hp except arrows.
 *
 * What is SCRIPTED (the setup, stated so the claim stays honest): the camera
 * is aimed by `setCamera` (a bot has no mouse), the fire-rate wait is skipped,
 * arrows are granted up front, the alarm is set to hunting, and the player's
 * own vitals are topped up when low — this bot cannot dodge, and the claim
 * under test is "the bosses die to real weapons", not "an AFK player
 * survives".
 *
 * The run FAILS if: either boss survives 480 loosed arrows, phases do not
 * traverse, damage arrives without a matching arrow spend, or the page
 * reloads mid-run.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = 'scripts/shots/boss-kill-real';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 160)}`));

// A parallel save hot-reloading the page mid-run has corrupted harness data in
// this project repeatedly — stub the HMR socket and stamp a boot id.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

await page.goto('http://localhost:5173/game.html?director=off&tod=0.50&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__pb = (window.__pb ?? 0) + 1; });

let failures = 0;
const ok = (cond, label, detail = '') => {
  failures += cond ? 0 : 1;
  process.stdout.write(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
};

// --- setup (scripted, declared) ---------------------------------------------
await page.evaluate(() => {
  const g = window.__gameDebug;
  g.giveItem('composite_bow', 1);
  g.giveItem('arrow', 60);           // Tintreach — the artifact, 18/bolt
  g.equipItem('composite_bow');
  g.castleTeleport('arena');
  g.castleSetAlarm('hunting');
  g.setVitals({ hp: 20, stamina: 100, alive: true });
});
await page.waitForTimeout(1200);

// SELECT the Tintreach quiver. The first run of this harness never did, and
// the starter kit now carries 48 flint arrows with flint as the default
// selection — so 48 shots lobbed ballistic arrows at a circling dragon,
// mostly missed, and the ammo assertion watched the wrong stack. X toggles;
// verify by firing one probe shot at the ground and seeing WHICH count drops.
{
  const which = async () => await page.evaluate(async () => {
    const g = window.__gameDebug;
    const t0 = g.countItem('arrow'), f0 = g.countItem('flint_arrow');
    g.setCamera(0, 0.9, 6);           // straight down — a throwaway shot
    g.looseArrow(1);
    await new Promise((r) => setTimeout(r, 250));
    return { tin: t0 - g.countItem('arrow'), flint: f0 - g.countItem('flint_arrow') };
  });
  let probe = await which();
  if (probe.tin === 0) {
    await page.keyboard.press('KeyX');
    await page.waitForTimeout(200);
    probe = await which();
  }
  ok(probe.tin === 1 && probe.flint === 0,
    'Tintreach quiver selected (probe shot spent 1 bolt)',
    JSON.stringify(probe));
}

const before = await page.evaluate(() => {
  const g = window.__gameDebug;
  return { fight: g.castleFight(), ammo: g.countItem('arrow') };
});
process.stdout.write(`  start: dragon ${before.fight.dragonHp} hp, king ${before.fight.kingHp} hp, ` +
  `phase ${before.fight.phase}\n`);

// --- the kill (real weapons only) --------------------------------------------
const phasesSeen = new Set();
let shots = 0;
let lastSnap = 0;
const SHOT_CAP = 480;

for (let i = 0; i < 2000 && shots < SHOT_CAP; i++) {
  const s = await page.evaluate(() => {
    const g = window.__gameDebug;
    const f = g.castleFight();
    const d = g.castleDragon();
    const k = g.castleKing();
    const p = g.playerPos();
    // Aim at whichever boss is still standing: dragon first, then the King.
    const t = (f.dragonHp > 0 && d !== null) ? { x: d.x, y: d.y + 1.6, z: d.z }
      : (k !== null ? { x: k.x, y: k.y + 1.6, z: k.z } : null);
    if (t !== null) {
      const flat = Math.hypot(t.x - p[0], t.z - p[2]);
      g.setCamera(Math.atan2(-(t.x - p[0]), -(t.z - p[2])),
        Math.max(-1.2, Math.min(0.8, -Math.atan2(t.y - (p[1] + 1.45), flat))), 6);
    }
    if (g.vitals().hp <= 8) g.setVitals({ hp: 20, stamina: 100 });
    const fired = t !== null ? g.looseArrow(1) : false;
    return {
      fired, phase: f.phase, dragonHp: f.dragonHp, kingHp: f.kingHp,
      dragonDead: f.dragonHp <= 0, kingDead: f.kingHp <= 0,
      ammo: g.countItem('arrow'), flint: g.countItem('flint_arrow'),
    };
  });
  if (s.fired) shots++;
  phasesSeen.add(s.phase);
  if (s.kingDead && s.dragonDead) break;
  if (shots - lastSnap >= 8) {
    lastSnap = shots;
    process.stdout.write(`  shot ${String(shots).padStart(3)}: phase ${s.phase.padEnd(10)} ` +
      `dragon ${String(Math.max(0, Math.round(s.dragonHp))).padStart(3)}  ` +
      `king ${String(Math.max(0, Math.round(s.kingHp))).padStart(3)}  ammo ${s.ammo}\n`);
    if (shots === 8) await page.screenshot({ path: path.join(outDir, '01-first-volley.png') });
  }
  await page.waitForTimeout(s.fired ? 650 : 120);   // real cadence when firing; brief retry when not
}

const after = await page.evaluate(() => {
  const g = window.__gameDebug;
  const f = g.castleFight();
  return { fight: f, ammo: g.countItem('arrow'), flint: g.countItem('flint_arrow') };
});
await page.screenshot({ path: path.join(outDir, '02-the-field-after.png') });

const boot = await page.evaluate(() => window.__pb);
await browser.close();

process.stdout.write('\n--- verdict ---\n');
ok(boot === 1, 'run integrity: no page reload', `boot=${boot}`);
ok(after.fight.dragonHp <= 0, 'the dragon is dead to real arrows',
  `hp ${after.fight.dragonHp}`);
ok(after.fight.kingHp <= 0, 'the Evil King is dead to real arrows',
  `hp ${after.fight.kingHp}`);
ok(shots <= SHOT_CAP, 'within the shot budget', `${shots} loosed`);
for (const ph of ['circle', 'grounded', 'dismounted']) {
  ok(phasesSeen.has(ph), `phase traversed by real damage: ${ph}`);
}
// Ammo really was consumed — the shots were not free. Count BOTH pools: the
// bow falls back to flint if Tintreach somehow empties, and either way every
// loose must map to a spent arrow.
const spent = (before.ammo - after.ammo) + (48 - after.flint);
ok(spent >= shots && spent <= shots + 3,
  'every shot consumed real ammunition',
  `${spent} spent (${before.ammo - after.ammo} tintreach, ${48 - after.flint} flint) for ${shots} loosed`);
ok(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));

process.stdout.write(`\n${failures === 0
  ? `PASS — both bosses fell to ${shots} real arrows`
  : `FAIL (${failures})`}\n`);
process.exit(failures > 0 ? 1 : 0);
