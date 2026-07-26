/**
 * Creature portraits — three framed shots per species, with proof of subject.
 *
 *   node scripts/creature-portraits.mjs <outDir> [species,species,...]
 *
 * The play harness shows creatures at gameplay distance, which is the right
 * test for "is it recognisable" but the wrong one for "is it assembled".
 * A close pass in a play session put the camera 2 m from a wolf's flank and
 * the model read as a pile of disconnected parts — which could equally have
 * been a bad camera angle as a bad mesh. This removes that ambiguity: every
 * species gets the same framing, far enough out to see the whole animal,
 * close enough to judge the joins.
 *
 * THREE THINGS THIS HARNESS GOT WRONG BEFORE, all of which produced confident
 * "ok (1 drawn)" lines over useless images:
 *
 *  1. **Distance was hand-picked per species and mostly far too big.** A 0.3 m
 *     bird at 3.5 m was sixty pixels tall; the sea serpent's shot was a
 *     photograph of grass with no animal in it at all. Distance now comes from
 *     the species' own shoulder height, with an explicit multiplier only for
 *     the species whose *span* (griffin wings) or *length* (serpent, dragon)
 *     exceeds their height.
 *  2. **The subject's own facing was never controlled**, so "camera yaw 45"
 *     meant a different view of every animal — sometimes the flank, sometimes
 *     the backside. The subject's `yaw` is now redefined as a read-only 0.
 *
 *     Writing it every animation frame was NOT enough and produced a second,
 *     nastier version of the same bug: whichever of the game loop and the pin
 *     registered its rAF callback first won, so the AI's facing survived on
 *     some species and not others. Worse, the yaws in this table were
 *     originally calibrated against that unpinned build — which is how "side"
 *     came to mean head-on for half the roster while the harness reported
 *     side-on shots. With the accessor pin in place the mapping is: subject
 *     faces -Z, camera yaw 0 is HEAD-ON, 90 is a flank, 180 is the tail.
 *  3. **"1 drawn" is not proof the animal is in the picture.** It counts draw
 *     calls, not pixels, and it stayed at 1 for the grass photograph. Every
 *     shot is now taken twice — once with the subject, once after killing it —
 *     and the pair is differenced. `cover` (fraction of the frame that changed)
 *     and the diff bounding box are reported per shot, and a shot under
 *     MIN_COVER is flagged. That is a direct measurement of "is the thing I
 *     think I am photographing actually there".
 *
 * A tree between the camera and the subject still happens; it shows up as a
 * collapsed `cover` on one angle while the others are fine.
 *
 * Pair with contact-sheet.mjs to get every species on one image.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/creatures';
const filter = (process.argv[3] || '').split(',').filter(Boolean);

/** Shoulder height (m) — mirrors SPECIES_DEFS[sp].size. */
const SIZE = {
  rabbit: 0.4, bird: 0.3, wolf: 0.9, deer: 1.2, donkey: 1.3, cow: 1.4,
  horse: 1.6, bear: 1.8, griffin: 2.2, wyvern: 2.4, dragon: 3.5, sea_serpent: 4.0,
  // Dungeon enemies. `SIZE` is shoulder height (it feeds `distFor`), and a
  // humanoid is much TALLER than its shoulder relative to a quadruped — a
  // goblin framed as a 0.86 m animal is framed for something half its standing
  // height and walks out of the top of the shot. The SPREAD entries below
  // compensate.
  goblin: 0.86, goblin_archer: 0.86, skeleton: 1.45, dread_king: 1.92,
};
/** Extra pull-back for species wider or longer than they are tall. */
// bird pulls IN, not out: at the shared formula a 0.3 m bird sat 2.5 m away
// and was forty pixels tall, which is not enough to judge anything by.
const SPREAD = { griffin: 1.85, dragon: 1.55, wyvern: 1.90, sea_serpent: 1.30,
  bird: 0.62, rabbit: 0.72,
  // Bipeds are TALL and NARROW. `distFor` is tuned for quadrupeds, whose
  // framing problem is length, so applying it unmodified to a 1.1 m goblin
  // parks the camera 3.5 m away and the subject occupies 3% of the frame —
  // technically "in shot", useless for judging a model. These pull the camera
  // in until the silhouette actually fills the picture.
  goblin: 0.62, goblin_archer: 0.62, skeleton: 0.70, dread_king: 0.72 };
/** Species the entity manager pins to the waterline — must be shot at sea. */
const WATER = new Set(['sea_serpent']);

const SPECIES = Object.keys(SIZE);

const distFor = (sp) => (1.2 + 2.7 * SIZE[sp]) * (SPREAD[sp] ?? 1);
/** Pitch that lifts the eye `rise` shoulder-heights above the orbit target. */
const pitchFor = (sp, d, rise) => Math.asin(Math.min(0.9, rise * SIZE[sp] / d));

/**
 * Camera yaws, re-calibrated against a subject whose yaw is genuinely pinned
 * to 0 (facing -Z): 0 is HEAD-ON, 90 is a flank, 180 is the tail. The
 * three-quarter views are what actually show whether a body reads in the
 * round; a pure side-on hides width and a pure head-on hides length.
 *
 * The third column is EYE RISE in shoulder-heights above the orbit target,
 * not a pitch angle. Pitch is the wrong thing to fix per view: the orbit
 * target sits at `size * 0.5` and the eye lands at `target + sin(pitch) * d`,
 * so one shared pitch means one eye height per distance — and a *negative*
 * pitch at the sea serpent's 15.6 m put the eye 2.2 m UNDERGROUND. That is
 * the entire reason its portrait was a close-up of grass while the harness
 * reported success. Rise is converted to a pitch per species below.
 */
const VIEWS = [
  ['side', 90, 0.15],
  ['front', 38, 0.65],
  ['rear', 208, 0.65],
  // Planform. A winged creature reads almost entirely by its wing outline
  // from above — on the dragon/wyvern reference sheets it is the single most
  // informative view, and none of the three ground-level yaws show it at all.
  // The rise clamps to the pitch ceiling for every species, so this is a high
  // three-quarter rather than a true orthographic top-down.
  ['top', 24, 4.5],
];

/** Below this fraction of changed pixels, the subject is missing or occluded. */
const MIN_COVER = 0.006;

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
/**
 * One page per species, closed afterwards.
 *
 * A single long-lived page ran out of something around the sixth species and
 * came back from `goto` with `window.__gameDebug` undefined — eleven WebGPU
 * device/swapchain pairs created in one tab is more than the headless GPU
 * process reliably survives. Closing the page hands those back deterministically
 * instead of hoping the collector gets to them.
 */
let page = null;
async function freshPage() {
  if (page !== null) await page.close();
  page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message.slice(0, 200)));
  return page;
}

/**
 * Where did the picture change when the subject was removed?
 *
 * Composited in a throwaway page rather than with an image library, same
 * reasoning as contact-sheet.mjs: playwright is already a dependency.
 * The bbox is percentile-trimmed (2%/98% of the changed mass on each axis) so
 * a swaying grass blade or a drifting cloud cannot inflate it to full frame.
 */
const diffPage = await browser.newPage();
async function coverage(aBuf, bBuf) {
  const a = 'data:image/png;base64,' + aBuf.toString('base64');
  const b = 'data:image/png;base64,' + bBuf.toString('base64');
  return diffPage.evaluate(async ([sa, sb]) => {
    const load = (src) => new Promise((res) => {
      const im = new Image(); im.onload = () => res(im); im.src = src;
    });
    const [ia, ib] = await Promise.all([load(sa), load(sb)]);
    const w = ia.width, h = ia.height;
    const cv = new OffscreenCanvas(w, h);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(ia, 0, 0);
    const da = cx.getImageData(0, 0, w, h).data;
    cx.clearRect(0, 0, w, h);
    cx.drawImage(ib, 0, 0);
    const db = cx.getImageData(0, 0, w, h).data;
    const colM = new Float64Array(w), rowM = new Float64Array(h);
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1])
          + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 42) { colM[x]++; rowM[y]++; n++; }
      }
    }
    if (n === 0) return { cover: 0, box: null };
    const band = (m, len) => {
      let acc = 0, lo = 0, hi = len - 1;
      for (let i = 0; i < len; i++) { acc += m[i]; if (acc >= n * 0.02) { lo = i; break; } }
      acc = 0;
      for (let i = len - 1; i >= 0; i--) { acc += m[i]; if (acc >= n * 0.02) { hi = i; break; } }
      return [lo, hi];
    };
    const [x0, x1] = band(colM, w), [y0, y1] = band(rowM, h);
    return { cover: n / (w * h), box: [x0, y0, x1, y1] };
  }, [a, b]);
}

/**
 * Set the subject's render scale, resolving it by id out of the live entity
 * table rather than through a `window.__sub` handle. The handle version threw
 * `Cannot set properties of undefined` partway through a run: anything that
 * reloads the page (a lost WebGPU device does exactly this) wipes `window`
 * while the game comes back up perfectly happy, and the harness died instead of
 * reporting it. `entityManager.snapshot()` hands back live references, so a
 * by-id lookup mutates the same object and survives that.
 */
async function subScale(id, v) {
  return page.evaluate(([sid, s]) => {
    const g = window.__gameDebug;
    if (g === undefined) return 'no-debug';
    const e = g.entities().find((x) => x.id === sid);
    if (e === undefined) return 'no-entity';
    e.scaleOverride = s;
    return 'ok';
  }, [id, v]);
}

/**
 * Every PNG is held in memory and written only after the browser closes.
 *
 * Writing them as they were taken put new files under the project root while
 * the dev server was watching it, so Vite fired a full page reload mid-shoot.
 * That killed the run with "Execution context was destroyed" on a good day and
 * — worse — on a bad one silently reloaded the game between a shot and its
 * paired empty plate, which came back as a 38% "subject" that was really the
 * whole world re-lighting. A harness must not perturb the thing it measures.
 */
const pending = [];

const log = [];
for (const sp of SPECIES) {
  if (filter.length && !filter.includes(sp)) continue;
  process.stdout.write(`${sp.padEnd(12)}`);
  try {
  await freshPage();
  await page.goto('http://localhost:5173/game.html?director=off&tod=0.52&weather=clear',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined,
    { timeout: 60_000 });
  await page.waitForTimeout(1200);

  const d = distFor(sp);
  // Put the creature on open ground beside the player and make it the orbit
  // centre. Orbiting the *player* is what produced a run of portraits showing
  // nothing but the back of the player's head, and spawning a dragon next to a
  // vulnerable player killed the photographer mid-session.
  const info = await page.evaluate(async (cfg) => {
    const g = window.__gameDebug;
    // Find flat ground. The old fixed spot was a hillside, so legs on the
    // downhill side hung in the air and every animal looked like it was
    // floating — a terrain artefact that reads exactly like a mesh bug.
    //
    // Aquatic species need the opposite test. The entity manager pins a sea
    // serpent's y to the waterline (-0.5) whatever the terrain under it, so
    // spawning one on the 12 m hill every other species uses buried it twelve
    // metres inside the hill — and put the orbit camera in there with it. Every
    // sea-serpent portrait ever taken was a close-up of grass, reported as a
    // success. Aquatic subjects get deep open water instead.
    let best = null;
    for (let gx = -12; gx <= 12; gx++) {
      for (let gz = -12; gz <= 12; gz++) {
        const x = 244 + gx * 9, z = -304 + gz * 9;
        const h = g.heightAt(x, z);
        if (cfg.water ? h > -3.0 : h < 1.0) continue;
        // Max deviation across a 6 m span — the footprint of the biggest animal.
        let dev = 0;
        for (const [ox, oz] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
          dev = Math.max(dev, Math.abs(g.heightAt(x + ox, z + oz) - h));
        }
        // Flattest wins, full stop. Biasing toward LOW ground was tried, to
        // get out of the trees that block roughly two views a species — and it
        // moved the studio onto the rocky shore, where boulders blocked more
        // views than the trees had. Occlusion is handled by re-shooting the
        // blocked angle instead (below), which is the fix that generalises.
        if (best === null || dev < best.dev) best = { x, z, dev };
      }
    }
    if (best === null) return null;
    g.teleport(best.x, best.z);
    // Kill anything that wandered in, so the portrait has exactly one subject.
    for (const e of g.entities()) g.killEntity(e.id);
    const sub = g.spawnEntity(cfg.sp, cfg.off, 0);
    if (sub === null) return null;
    g.setPortraitSubject(sub.id);
    // Pin the subject. Portrait mode holds animals at idle but does NOT fix
    // their facing, so without this every species is photographed from a
    // different angle and the shots are not comparable.
    window.__sub = sub;
    // Pinned by REDEFINING the property, not by writing it every frame. The
    // rAF version lost a race: whichever of the game loop and the harness
    // registered its callback first ran first, so on some species the AI's
    // facing was applied after the pin and the "side" portrait came out as a
    // rear view of a deer — with the harness still reporting a side shot. A
    // read-only accessor cannot lose that race.
    Object.defineProperty(sub, 'yaw', { get: () => 0, set: () => {}, configurable: true });
    window.__pin = () => {
      if (window.__pinStop) return;
      sub.mode = 'idle'; sub.walkAmp = 0;
      requestAnimationFrame(window.__pin);
    };
    window.__pinStop = false;
    window.__pin();
    return { id: sub.id, y: sub.y, ground: g.heightAt(sub.x, sub.z), dev: best.dev };
  }, { sp, off: d * 0.40, water: WATER.has(sp) });
  if (info === null) { console.log(' spawn failed'); continue; }

  // Hide every DOM overlay. Naming ids individually missed the vitals cluster
  // and the compass, which main.ts creates at runtime — so hide everything
  // that is not the canvas.
  await page.addStyleTag({ content: 'body > *:not(canvas){display:none!important}' });
  await page.waitForTimeout(1600);

  // Each view is shot twice back to back: once normally, once with the subject
  // collapsed to a point. The difference is exactly the animal.
  //
  // Collapsed via `scaleOverride`, NOT killed. Killing it and clearing the
  // portrait subject hands the camera back to the player, so the "empty" plate
  // is shot from a completely different place and the diff comes out at 40-80%
  // of the frame — a number that looks like a healthy measurement and means
  // nothing. Shrinking the subject in place keeps the camera, the terrain, the
  // light and the grass identical, so the difference is only ever the model.
  // Interleaved per view rather than as two passes for the same reason at a
  // smaller scale: cloud shadows drift across the ground, and seconds between
  // a pair show up as tens of percent of spurious "subject".
  /** Shoot one view and measure how much of the frame the subject occupies. */
  const takeView = async (name, yaw, rise) => {
    const pitch = pitchFor(sp, d, rise);
    await page.evaluate((a) => window.__gameDebug.setCamera(
      a.yaw * Math.PI / 180, a.pitch, a.d), { yaw, pitch, d });
    await page.waitForTimeout(520);
    const shot = await page.screenshot();
    const hid = await subScale(info.id, 0.0004);
    await page.waitForTimeout(220);
    const empty = await page.screenshot();
    await subScale(info.id, 1);
    await page.waitForTimeout(120);
    if (hid !== 'ok') process.stdout.write(` [${hid}!]`);
    const c = await coverage(shot, empty);
    return { name, yaw, pitch: +pitch.toFixed(3), shot, cover: c.cover, box: c.box };
  };

  const shots = [];
  for (const [name, yaw, rise] of VIEWS) shots.push(await takeView(name, yaw, rise));

  // OCCLUSION RETRY. The subject stands where the flattest ground is, and that
  // is regularly behind a tree from one of the four yaws — a deer whose entire
  // head was hidden by a trunk, photographed and filed as evidence. A blocked
  // view shows up as a coverage far below this species' other views, so
  // re-shoot any such view 26 degrees round and keep whichever sees more.
  const bestCover = Math.max(...shots.map((s) => s.cover));
  for (let i = 0; i < shots.length; i++) {
    if (shots[i].cover >= bestCover * 0.62) continue;
    // Several offsets, not one: a tree canopy is wide enough that 26 degrees
    // often lands behind the same trunk.
    for (const off of [26, -26, 54]) {
      const alt = await takeView(shots[i].name, (VIEWS[i][1] + off + 360) % 360, VIEWS[i][2]);
      if (alt.cover > shots[i].cover) { alt.retried = true; shots[i] = alt; }
      if (shots[i].cover >= bestCover * 0.62) break;
    }
  }

  const marks = [];
  for (const s of shots) {
    pending.push([path.join(outDir, `${sp}-${s.name}.png`), s.shot]);
    delete s.shot;
    s.cover = +s.cover.toFixed(4);
    const bw = s.box === null ? 0 : s.box[2] - s.box[0];
    const bh = s.box === null ? 0 : s.box[3] - s.box[1];
    marks.push(`${s.name} ${(s.cover * 100).toFixed(1)}%${s.cover < MIN_COVER ? '!' : ''}`
      + `${s.retried === true ? '~' : ''} ${bw}x${bh}`);
  }
  log.push({ species: sp, dist: +d.toFixed(1), ground: info, shots });
  console.log(` d=${d.toFixed(1)}m  ${marks.join('  ')}`);
  } catch (err) {
    // Never let one bad species take the run down: the other ten shots are
    // still worth having, and a species that failed is itself a finding.
    console.log(` FAILED: ${String(err).split('\n')[0].slice(0, 120)}`);
    log.push({ species: sp, failed: String(err).slice(0, 200) });
  }
}

await browser.close();
for (const [p, buf] of pending) fs.writeFileSync(p, buf);
fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify(log, null, 1), 'utf-8');

// `?? []` because a species that threw is logged with no `shots` at all, and
// crashing the summary on it threw away the report for the eleven that worked.
const weak = log.flatMap((l) => (l.shots ?? []).filter((s) => s.cover < MIN_COVER)
  .map((s) => `${l.species}-${s.name}`))
  .concat(log.filter((l) => l.failed !== undefined).map((l) => `${l.species} (FAILED)`));
console.log(`\n${log.length} species x ${VIEWS.length} views -> ${outDir}`);
if (weak.length) {
  console.log(`SUBJECT MISSING OR OCCLUDED in: ${weak.join(', ')}`);
  console.log('Do not read those shots as evidence of anything.');
}
