/**
 * Walk-cycle filmstrips — the verification the still portraits cannot do.
 *
 *   node scripts/creature-walk.mjs <outDir> [speciesFilter]
 *
 * creature-portraits.mjs answers "is this animal assembled correctly", which is
 * a question about a single frame. The complaint this exists to check is about
 * MOTION — legs pivoting rigidly from the hip, feet skating and sinking — and
 * none of that is visible in a still. So: put the animal on flat ground, make
 * it actually walk under its own AI, and film the same creature across one
 * gait cycle from a fixed side-on camera.
 *
 * What to look for in the output strip:
 *   - the knee/hock BENDS, and bends the right way (fore back, hind forward)
 *   - the planted foot stays welded to the ground while the body passes over it
 *   - the swinging foot lifts clear, reaches, and sets down
 *   - the body rises and falls; it never floats or sinks
 *
 * Driven by the real AI on purpose. The gait phase advances from distance
 * travelled (animal-ai.ts) while the mesh solves feet from that same phase
 * (animal-mesh.ts) — filming a hand-driven phase would bypass exactly the
 * agreement between those two that keeps feet from skating.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/walk';
const filter = process.argv[3] || '';

const SPECIES = ['rabbit', 'deer', 'wolf', 'bear', 'cow', 'horse', 'donkey',
  'dragon', 'wyvern',
  // The bipeds. This strip is the only thing that can show whether the
  // planted-foot IK actually holds on a humanoid leg — a still portrait cannot
  // distinguish a walk from a skate.
  'goblin', 'goblin_archer', 'skeleton', 'dread_king'];

/**
 * Camera distance per species, from SPECIES_DEFS shoulder height.
 *
 * Framed so the animal fills most of the frame: the first pass used one
 * distance band for everything and put a 0.3 m rabbit 2.6 m away, where it was
 * sixty pixels tall and its legs were literally unresolvable. A gait strip you
 * cannot see the knees in verifies nothing.
 */
const SIZE = {
  rabbit: 0.3, deer: 1.2, wolf: 0.9, bear: 1.8, cow: 1.4, horse: 1.6,
  donkey: 1.3, dragon: 3.5, wyvern: 2.4,
  goblin: 0.86, goblin_archer: 0.86, skeleton: 1.45, dread_king: 1.92,
};
/**
 * Extra pull-back for species whose SPAN, not their height, sets the frame.
 * The dragon and the wyvern furl their wings at rest and OPEN them the moment
 * they move — which is precisely what this harness films — so a distance
 * derived from shoulder height alone puts a 15 m wingspan two metres outside
 * the viewport at exactly the moment the strip is supposed to show it.
 */
const SPAN = { dragon: 1.9, wyvern: 1.9,
  // Same reason as the portrait harness: a biped is tall for its shoulder.
  goblin: 1.5, goblin_archer: 1.5, skeleton: 1.3, dread_king: 1.25 };
const distFor = (sp) => (1.0 + 2.9 * (SIZE[sp] ?? 1.0)) * (SPAN[sp] ?? 1);

const FRAMES = 8;      // frames per strip
const FRAME_MS = 260;  // wall-clock between frames

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message.slice(0, 200)));

const log = [];
for (const sp of SPECIES) {
  if (filter && !sp.includes(filter)) continue;
  process.stdout.write(`${sp.padEnd(10)} `);

  await page.goto('http://localhost:5173/game.html?director=off&tod=0.52&weather=clear',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined,
    { timeout: 60_000 });
  await page.waitForTimeout(1200);

  const d = distFor(sp);
  const ok = await page.evaluate(async (cfg) => {
    const g = window.__gameDebug;
    // Flattest ground we can find. On a slope the downhill legs hang in the
    // air and the animal reads as floating — a terrain artefact that looks
    // exactly like the mesh bug we are trying to rule out.
    let best = null;
    for (let gx = -6; gx <= 6; gx++) {
      for (let gz = -6; gz <= 6; gz++) {
        const x = 244 + gx * 9, z = -304 + gz * 9;
        const h = g.heightAt(x, z);
        if (h < 1.0) continue;
        let dev = 0;
        for (const [ox, oz] of [[-5, 0], [5, 0], [0, -5], [0, 5],
                                [-4, -4], [4, 4]]) {
          dev = Math.max(dev, Math.abs(g.heightAt(x + ox, z + oz) - h));
        }
        if (best === null || dev < best.dev) best = { x, z, dev };
      }
    }
    g.teleport(best.x, best.z);
    for (const e of g.entities()) g.killEntity(e.id);

    // Spawn WELL away from the player. Portrait mode only clamps aggro and
    // flee back to idle after the fact, so a bear 2 m from the player spends
    // every other tick being re-triggered, and a rabbit that close simply
    // bolts. Both then fight the drive loop and the strip shows a standing
    // animal. 26 m clears the flee (12 m) and aggro (16 m) radii outright.
    const spawned = g.spawnEntity(cfg.sp, 0, -26);
    if (spawned === null) return null;
    g.setPortraitSubject(spawned.id);

    // Walk it in a STRAIGHT line toward a fixed distant point, rather than
    // letting it wander. Wander turns, and a turning subject under a
    // world-fixed camera drifts from side-on to rear-on mid-strip — the first
    // run produced exactly that, a filmstrip of a deer's backside.
    const dir = 0;                      // heading: yaw 0 faces -Z
    const tx = spawned.x + Math.sin(dir) * 90;
    const tz = spawned.z - Math.cos(dir) * 90;

    window.__walkStop = false;
    window.__walkId = spawned.id;
    window.__walkLost = false;
    const drive = () => {
      if (window.__walkStop) return;
      // Re-arm every frame. `stateTimer` must stay POSITIVE: animal-ai treats
      // stateTimer <= 0 as "wander timed out" and drops back to idle, and
      // zeroing it is what made six of seven subjects stand still on the
      // first run. Only the post-hoc walkPhase check caught that.
      spawned.mode = 'wander';
      spawned.stateTimer = 60;
      spawned._wanderTX = tx;
      spawned._wanderTZ = tz;
      // Camera locked square to the direction of travel, following the
      // subject. A quadruped's gait is sagittal-plane motion; 90 degrees off
      // its heading is the only view that shows the whole linkage.
      g.setCamera(dir + Math.PI / 2, -0.05, cfg.d);
      requestAnimationFrame(drive);
    };
    drive();
    return { x: best.x, z: best.z, dev: best.dev };
  }, { sp, d });
  if (ok === null) { console.log('spawn failed'); continue; }

  // Hide every DOM overlay. Naming the ids individually missed the vitals
  // cluster and the compass, which main.ts creates at runtime rather than
  // declaring in game.html — so target everything that is not the canvas.
  await page.addStyleTag({ content:
    'body > *:not(canvas){display:none!important}' });

  // Side-on. A quadruped's gait is a sagittal-plane motion, so 90 degrees off
  // its heading is the only angle that shows the whole linkage at once —
  // the opposite of the portrait harness, where head-on hides body length.
  await page.waitForTimeout(1800); // let it get up to walking speed

  for (let i = 0; i < FRAMES; i++) {
    await page.screenshot({ path: path.join(outDir, `${sp}-${i}.png`) });
    await page.waitForTimeout(FRAME_MS);
  }

  const state = await page.evaluate(() => {
    window.__walkStop = true;
    const g = window.__gameDebug;
    // By id, not entities()[0] — the snapshot order is not the spawn order.
    const all = g.entities();
    const e = all.find(x => x.id === window.__walkId);
    // Report the roster when the subject is missing: "subject vanished" and
    // "subject stood still" look identical in a filmstrip, and knowing which
    // one happened is the difference between a harness bug and a game bug.
    return e
      ? { mode: e.mode, walkPhase: e.walkPhase }
      : { missing: true, roster: all.map(x => `${x.species}:${x.mode}`) };
  });
  const moved = state !== null && !state.missing && state.walkPhase > 0.5;
  log.push({ species: sp, frames: FRAMES, ground: ok, state, moved });
  console.log(moved
    ? `ok (phase ${state.walkPhase.toFixed(1)}, ground dev ${ok.dev.toFixed(2)}m)`
    : state?.missing
      ? `WARNING: subject VANISHED (roster: ${state.roster.join(', ') || 'empty'})`
      : `WARNING: never walked (phase ${state?.walkPhase ?? '?'}) — strip is useless`);
}

fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify(log, null, 1), 'utf-8');
await browser.close();

const bad = log.filter(l => !l.moved);
console.log(`\n${log.length} strips -> ${outDir}`);
if (bad.length) {
  console.log(`${bad.length} subject(s) never walked: ${bad.map(b => b.species).join(', ')}`);
  console.log('Those strips show a STANDING animal — do not read them as a gait.');
}
