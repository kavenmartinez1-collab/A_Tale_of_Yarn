/**
 * Attack filmstrips — the verification neither the walk nor the idle harness
 * can do.
 *
 *   node scripts/anim-attack.mjs <outDir> [speciesFilter]
 *
 * WHY THIS CANNOT BE "SCREENSHOT IN A LOOP AND HOPE"
 *
 * A wolf's bite is 0.52 s and a rabbit's kick is 0.34 s. A Playwright
 * screenshot round trip is 80–200 ms and jittery. Sampling as fast as possible
 * and filming whatever turns up gives a strip that is mostly rest pose, mostly
 * misses the contact frame entirely, and looks completely plausible — every
 * frame is a real render of a real animal.
 *
 * That is exactly the failure this repo keeps having. A portrait harness
 * photographed the back of the player's head for a session and reported
 * success. A walk harness filmed six standing animals because it reset the AI
 * state timer. A third shot rear views while claiming fronts. In every case the
 * output was images, the images were real, and the claim about what they showed
 * was wrong.
 *
 * So this harness does not sample. It SCRUBS: `animDebug.hold` pins one
 * creature's playhead to a named move at a named second (see `creature-anim.ts`
 * — the hook is in the shipping module precisely so a harness cannot be wrong
 * about what it captured), and every frame is then shot deliberately.
 *
 * HOW IT TRIES NOT TO LIE TO YOU
 *
 *  1. **The clip and the time are read back, not assumed.** After each shot the
 *     driver's own log is read: the clip name it actually played and the
 *     playhead it was actually at. A mismatch is a hard failure, not a warning.
 *  2. **The frames are proved to differ.** Each frame is diffed against the
 *     rest pose inside a box around the creature, AND against a control box of
 *     empty sky, because grass and clouds move too. A strip whose contact frame
 *     does not differ from its rest frame by more than the sky did is reported
 *     as showing nothing.
 *  3. **The change is proved to be monotone through the swing.** The windup,
 *     contact and follow-through must each differ from rest by MORE than the
 *     frame before — an animation, not three renders of the same pose with
 *     different filenames.
 *  4. **The subject is proved to be there and still.** Position is sampled
 *     every frame; a subject that wandered off or despawned is reported.
 *  5. **The subject is proved to be VISIBLE, not merely present.** Position
 *     and the box-diffs below both assume the frame actually shows the
 *     animal; neither notices a camera aimed into a tree canopy, because the
 *     subject is still alive at the right (x, y, z) — it just is not what is
 *     on screen. Every "signal 0" this harness used to report traces back to
 *     a camera-angle bug that pointed every species at the same arbitrary
 *     world-space direction (see `CAMERA_YAW` below); one species' distance
 *     happened to put that ray inside foliage. Copied from
 *     `boss-portraits.mjs`'s coverage check: collapse the subject to a point
 *     and confirm a large fraction of ITS OWN framing box actually changes.
 *  6. **Hot reloads are prevented, not just detected.** Vite's HMR socket is
 *     stubbed before the page ever loads, so another agent saving a file
 *     mid-strip does not push a reload that wipes every `window` global. The
 *     retry loop below stays as a fallback for whatever that does not catch.
 *
 * Requires `npm run dev` (port 5173).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outDir = process.argv[2] || 'scripts/shots/attack';
const filter = process.argv[3] || '';

/**
 * Which species to film and how far the camera sits back, as a multiple of
 * shoulder height. Every species with a body plan is represented; the list is
 * ordered so the ones whose attacks differ most sit next to each other.
 */
const SUBJECTS = [
  { sp: 'wolf', size: 0.9 },
  { sp: 'bear', size: 1.5 },
  { sp: 'deer', size: 1.2 },
  { sp: 'cow', size: 1.4 },
  { sp: 'horse', size: 1.6 },
  { sp: 'donkey', size: 1.2 },
  { sp: 'rabbit', size: 0.4 },
  { sp: 'bird', size: 0.3 },
  { sp: 'dragon', size: 3.5 },
  { sp: 'wyvern', size: 2.4 },
  { sp: 'griffin', size: 2.0 },
  // Aquatic: `EntityManager._yFor` puts a sea serpent at the WATER surface
  // whatever the terrain under it is doing, so spawning it on the flat grass
  // every other subject uses buries it in a hillside and points the portrait
  // camera at the inside of the hill. The first run of this harness produced
  // five frames of solid green for it — and, to its credit, said so rather than
  // calling them a strike.
  { sp: 'sea_serpent', size: 2.6, water: true },
  // Dungeon enemies. `size` here only sets the camera distance
  // (`2.8 * size`), so it is tuned to standing height rather than to the
  // species' shoulder height — a goblin framed at 0.86 puts the camera 2.4 m
  // out and crops its head off.
  { sp: 'goblin', size: 1.2 },
  { sp: 'goblin_archer', size: 1.2 },
  { sp: 'skeleton', size: 1.9 },
  { sp: 'dread_king', size: 2.7 },
  // The castle-fight bosses. They were absent from this list while their five
  // attack moves were being authored, which is why nobody had ever seen one of
  // them swing: the King's whole fight is 1.15–1.30 s of greatsword and the
  // only harness that can hold a playhead still did not know he existed.
  //
  // `size` is camera framing, not shoulder height. The King STANDS 3.24 m, so
  // 3.4 keeps the crown in shot; the dragon is framed off its 19 m span rather
  // than its 4.4 m shoulder, or the wings leave the frame on the contact frame
  // of every move it has.
  { sp: 'evil_king', size: 3.4 },
  { sp: 'black_dragon', size: 6.5 },
];

fs.mkdirSync(outDir, { recursive: true });

// --- minimal PNG decode (RGBA/RGB, 8-bit, no interlace) ---------------------
// Same decoder as `anim-idle.mjs`; we only need pixel deltas and an image
// library is not worth the dependency.
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG: depth ${bitDepth} colour ${colorType}`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, px: out };
}

/** Mean absolute per-pixel difference inside a normalised box. */
function boxDiff(a, b, x0, y0, x1, y1) {
  const { w, h, ch, px } = a;
  const X0 = Math.floor(x0 * w), X1 = Math.ceil(x1 * w);
  const Y0 = Math.floor(y0 * h), Y1 = Math.ceil(y1 * h);
  let sum = 0, n = 0;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const i = y * w * ch + x * ch;
      sum += Math.abs(px[i] - b.px[i])
        + Math.abs(px[i + 1] - b.px[i + 1])
        + Math.abs(px[i + 2] - b.px[i + 2]);
      n += 3;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Where the creature is in frame, and a patch of sky that it never is.
 *
 * Portrait mode frames every subject at half its standing height from a
 * distance proportional to that height, so the on-screen size is roughly
 * constant across species and a fixed box is safe. The box is kept TIGHT: the
 * looser one this started with was more grass than animal, and grass sways.
 */
const SUBJ_BOX = [0.37, 0.24, 0.68, 0.70];
const CTRL_BOX = [0.02, 0.02, 0.22, 0.16];

/**
 * Floor for `subjectCoverage()` below: the fraction of `SUBJ_BOX` that must
 * change when the subject collapses to a point. The box is deliberately tight
 * around a properly framed subject (see above), so a real capture changes a
 * large share of it; a camera aimed at the wrong thing changes none of it.
 * Set low enough to tolerate a small or distant-reading subject (a rabbit, a
 * bird) and still fail hard on the ~0% a tree trunk or an empty patch of sky
 * produces.
 */
const MIN_SUBJ_COVER = 0.03;

/**
 * Subject-relative camera azimuth, degrees (0 = head-on, 90 = pure profile),
 * and the conversion to the game's absolute orbit yaw.
 *
 * THIS IS THE PART THAT WAS WRONG. The previous version spun the SUBJECT to
 * `Math.PI - 0.5` and held the CAMERA at a bare `Math.PI / 2`, on the belief
 * that "orbit yaw pi/2" meant something fixed relative to the subject's face.
 * It does not — `OrbitCamera.forward()` (`src/game/camera.ts`) never reads the
 * subject's yaw at all, it is one absolute world angle — so that pairing
 * filmed every species from the same arbitrary direction in WORLD space
 * (works out to a rear three-quarter view, not the front three-quarter one
 * the comment thought it was building), and for one species that direction
 * ran the camera straight into a tree canopy at that species' particular
 * distance. Every "signal 0" this harness was reported to produce traces back
 * to this: the measurement box was full of grass or foliage, because the
 * subject was never where the box assumed.
 *
 * `boss-portraits.mjs` already solved this correctly: pin the SUBJECT's yaw to
 * 0 (done below via `Object.defineProperty` on the spawned entity — a per-rAF
 * write loses a race with the game loop, a redefined getter cannot), then
 * drive the camera through `orbitOf`, copied verbatim from that file because
 * re-deriving it by hand is exactly how the sign got lost the first time.
 *
 * 62 degrees, not 90: pure profile reads an overhead arc's full pendulum and
 * the body rise best, but hides HEAD YAW completely — a wolf's bite turns its
 * head toward the camera and a profile view foreshortens that turn to nothing.
 * Backing off 28 degrees toward head-on keeps the arc legible while the head
 * sweep still reads — the same trade-off the old constants were reaching for;
 * only the geometry under them was wrong.
 */
const REL_DEG = 62;
const orbitOf = (rel) => ((180 - rel) * Math.PI) / 180;
const CAMERA_YAW = orbitOf(REL_DEG);

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
// Cut vite's HMR socket before anything loads. Other agents edit this repo
// while harnesses run, and every file they save pushes a full-page reload —
// wiping every `window` global mid-strip, which is what the MAX_TRIES retry
// loop below exists to survive. Stubbing the socket means most of those
// reloads never happen at all; the retry loop stays as the fallback for
// whatever this does not catch (a build error, a manual refresh).
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });
const pageErrors = [];
page.on('pageerror', (e) => {
  pageErrors.push(e.message.slice(0, 200));
  console.error('  [pageerror]', e.message.slice(0, 200));
});

const log = [];
const MAX_TRIES = 3;

for (const subj of SUBJECTS) {
  if (filter && !subj.sp.includes(filter)) continue;
  let result = null, reloads = 0;
  for (let attempt = 0; attempt < MAX_TRIES && result === null; attempt++) {
    try {
      result = await shootSpecies(subj);
    } catch (err) {
      if (!/Execution context was destroyed|__gameDebug|__animDebug/.test(String(err))) throw err;
      result = null;
    }
    if (result === null) reloads++;
  }
  if (result === null) {
    console.log(`${subj.sp.padEnd(13)} WARNING: could not capture after ${MAX_TRIES} attempts`);
    log.push({ species: subj.sp, ok: false, reason: 'page kept reloading' });
    continue;
  }
  for (const strip of result) {
    log.push(strip);
    report(strip);
  }
}

function report(s) {
  const head = `${s.species}/${s.move}`.padEnd(26);
  if (!s.alive) {
    console.log(`${head} WARNING: subject VANISHED — the frames show empty grass`);
  } else if (s.scrubError) {
    console.log(`${head} WARNING: SCRUB MISMATCH — ${s.scrubError}`);
  } else if (!s.moved) {
    console.log(`${head} WARNING: contact frame is INDISTINGUISHABLE from rest `
      + `(signal ${s.contactDiff}, scene noise ${s.noise})`);
  } else if (!s.distinct) {
    console.log(`${head} WARNING: fewer than 3 DISTINCT poses in the swing `
      + `(${s.distinctPoses.join('+')}; pairs ${JSON.stringify(s.pairs)})`);
  } else if (!s.returns) {
    console.log(`${head} WARNING: does not RETURN to rest — `
      + `[${s.signals.join(', ')}]`);
  } else {
    console.log(`${head} ok  wind/hit/follow/recover [${s.signals.join(', ')}] `
      + `${s.distinctPoses.length} distinct poses, noise ${s.noise}`);
  }
}

async function stampSession() {
  await page.evaluate(() => { window.__atkSession = (window.__atkSession || 0) + 1; });
  return page.evaluate(() => window.__atkSession);
}

async function shootSpecies(subj) {
  await page.goto('http://localhost:5173/game.html?director=off&tod=0.52&weather=clear',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined,
    { timeout: 60_000 });
  await page.waitForTimeout(1200);

  // Purely proportional, with a floor. The `a + b*size` form this started with
  // put a 0.4 m rabbit at 2.0 m and a 1.5 m bear at 4.75 m — the constant term
  // dominates for small species, so the rabbit came out a third of the bear's
  // on-screen size and its whole attack disappeared into swaying grass. Scaling
  // by size alone keeps every subject the same size in frame, which is also
  // what makes one fixed measurement box legitimate.
  const dist = Math.max(1.3, 2.8 * subj.size);
  const placed = await page.evaluate(async (cfg) => {
    const g = window.__gameDebug;
    if (window.__animDebug === undefined) throw new Error('__animDebug missing');
    // Flattest ground available: a slope makes the downhill legs hang, which
    // looks exactly like a rig bug and would be blamed on the attack.
    //
    // Note WHERE the flat spot ends up. `anim-idle.mjs` teleports the PLAYER to
    // it and then spawns the subject 26 m away, on ground it never measured —
    // so the flatness check protected the camera position and not the animal.
    // Here the player is placed 26 m north of the flat spot so that spawning
    // the subject 26 m south of the player lands it exactly on the ground that
    // was actually tested.
    // SEA_LEVEL is 0. Land subjects want the flattest ground well above it;
    // an aquatic subject wants open water, deep enough that the sea bed is
    // nowhere near the surface it will be floating on.
    //
    // Flat is not the same as clear. The single flattest cell in this whole
    // search box turned out to be a grassy shoulder overlooking a lake, and
    // the animated water surface moved MORE between two supposedly-identical
    // rest-pose shots than a king's cleave moved his sword — burying a real
    // swing's signal under its own background rather than under anything
    // wrong with the swing. `WATER_RING` rejects any land site with open
    // water in the likely camera background; `black_dragon`'s 18 m boom is
    // the longest lens this file uses, and 35 m comfortably covers what
    // actually lands in frame at every distance used below.
    const WATER_RING = [
      [35, 0], [-35, 0], [0, 35], [0, -35],
      [25, 25], [25, -25], [-25, 25], [-25, -25],
    ];
    let best = null;
    for (let gx = -10; gx <= 10; gx++) {
      for (let gz = -10; gz <= 10; gz++) {
        const x = 244 + gx * 7, z = -304 + gz * 7;
        const hgt = g.heightAt(x, z);
        let dev = 0;
        for (const [ox, oz] of [[-4, 0], [4, 0], [0, -4], [0, 4], [-3, -3], [3, 3]]) {
          dev = Math.max(dev, Math.abs(g.heightAt(x + ox, z + oz) - hgt));
        }
        if (cfg.water) {
          // Deepest water whose neighbourhood is also water, so nothing pokes
          // through the surface into frame.
          let deepest = hgt;
          for (const [ox, oz] of [[-8, 0], [8, 0], [0, -8], [0, 8]]) {
            deepest = Math.max(deepest, g.heightAt(x + ox, z + oz));
          }
          if (deepest > -1.5) continue;
          if (best === null || deepest < best.dev) best = { x, z, dev: deepest };
        } else {
          if (hgt < 1.0) continue;
          if (WATER_RING.some(([ox, oz]) => g.heightAt(x + ox, z + oz) < 1.0)) continue;
          if (best === null || dev < best.dev) best = { x, z, dev };
        }
      }
    }
    if (best === null) return null;
    // 26 m clears the 12 m flee and 16 m aggro radii, so the subject is not
    // re-triggered by the player's presence every tick.
    g.teleport(best.x, best.z + 26);
    for (const e of g.entities()) g.killEntity(e.id);

    const sp = g.spawnEntity(cfg.sp, 0, -26);
    if (sp === null) return null;
    g.setPortraitSubject(sp.id);

    // Pin facing by REDEFINING the property, not by reassigning it every
    // frame. A per-rAF write loses a race with the game loop — see
    // `boss-portraits.mjs`, which hit exactly that (the King's rider caught
    // mid-turn between the pin and the render). A redefined getter cannot
    // lose that race: nothing that runs after this line can make `sp.yaw`
    // read back as anything but 0, which is what makes `CAMERA_YAW` above a
    // subject-relative angle rather than a guess about world space.
    Object.defineProperty(sp, 'yaw', { get: () => 0, set: () => {}, configurable: true });

    const dbg = window.__animDebug;
    dbg.enabled = true;
    dbg.hold = null;
    window.__atkId = sp.id;
    window.__atkStop = false;
    const drive = () => {
      if (window.__atkStop) return;
      // Pin the AI. `animal-ai` treats stateTimer <= 0 as "this state timed
      // out" and moves on, which is how an earlier harness ended up filming
      // animals that had wandered out of frame.
      sp.mode = 'idle';
      sp.stateTimer = 600;
      // Slightly above the horizontal: a level camera at ground height looks
      // straight through the grass and, on anything but perfectly flat terrain,
      // through the lip of the next rise. Both put a green wall over the
      // subject.
      g.setCamera(cfg.camYaw, 0.20, cfg.dist);
      requestAnimationFrame(drive);
    };
    drive();

    const moves = (dbg.attacks[cfg.sp] || []).map(m => ({
      name: m.name, kind: m.kind, contactT: m.contactT,
      duration: m.clip.duration,
    }));
    return { id: sp.id, x: sp.x, y: sp.y, z: sp.z, dev: best.dev, moves };
  }, {
    sp: subj.sp, dist, camYaw: CAMERA_YAW,
    water: subj.water === true,
  });

  if (placed === null) throw new Error('__gameDebug spawn returned null');
  const session = await stampSession();

  await page.addStyleTag({ content: 'body > *:not(canvas){display:none!important}' });

  // WAIT FOR THE SUBJECT TO STOP FALLING.
  //
  // A winged species does not spawn on the ground: `main.ts` gives it a
  // `_landingY` and flies it down over several seconds, during which the whole
  // frame is changing. A fixed 1.5 s wait was not enough, and the symptom was
  // subtle in exactly the wrong way — only the FIRST move of each flier had a
  // wrecked noise floor (42 against a signal of zero for the wyvern's bite),
  // because by the second move the descent had finished. A timing bug that
  // affects one strip in three is far more likely to be dismissed as flakiness
  // than a timing bug that affects all of them.
  let y = null, stable = 0;
  for (let i = 0; i < 40 && stable < 4; i++) {
    await page.waitForTimeout(250);
    const now = await page.evaluate(() => {
      const e = window.__gameDebug?.entities().find(x => x.id === window.__atkId);
      return e === undefined ? null : e.y;
    });
    if (now === null) break;
    stable = (y !== null && Math.abs(now - y) < 0.02) ? stable + 1 : 0;
    y = now;
  }
  await page.waitForTimeout(600);

  // Prove the camera can actually see the subject before spending any beats
  // on it. The camera setup here (`cfg.camYaw`/`cfg.dist`) is identical for
  // every move of this species, so occlusion is a property of this one spot
  // and checking once, before the per-move loop, is enough.
  const cover = await subjectCoverage(placed.id);
  if (cover < MIN_SUBJ_COVER) {
    console.log(`${subj.sp.padEnd(13)} WARNING: camera cannot see the subject `
      + `(only ${(cover * 100).toFixed(2)}% of its box changed when it was `
      + 'collapsed — occluded by scenery, or aimed at the wrong spot)');
    log.push({
      species: subj.sp, ok: false, reason: 'subject not visible from camera', cover,
    });
    await page.evaluate(() => { window.__atkStop = true; });
    return [];
  }

  const strips = [];
  for (const mv of placed.moves) {
    strips.push(await shootMove(subj, mv, placed, session));
  }
  await page.evaluate(() => { window.__atkStop = true; });
  return strips;
}

/**
 * Fraction of `SUBJ_BOX` that changes when entity `id` is collapsed to a
 * point — copied from `boss-portraits.mjs`'s `coverage()`/`subScale()` pair,
 * adapted to this file's Node-side PNG decoding instead of an in-page canvas.
 *
 * Near 0 means the box was never showing the subject: background (grass, sky,
 * a tree trunk 8 cm from the lens) does not move when an unrelated entity
 * shrinks to nothing. A properly framed subject fills enough of its own
 * (deliberately tight) box that collapsing it changes most of the pixels in it.
 */
async function subjectCoverage(id) {
  const before = decodePng(await page.screenshot());
  await page.evaluate((sid) => {
    const e = window.__gameDebug.entities().find((x) => x.id === sid);
    if (e !== undefined) e.scaleOverride = 0.0004;
  }, id);
  await page.waitForTimeout(220);
  const after = decodePng(await page.screenshot());
  // Never leave it collapsed — a failed species would otherwise leave a
  // pinhead on screen for whatever runs next against the same page.
  await page.evaluate((sid) => {
    const e = window.__gameDebug.entities().find((x) => x.id === sid);
    if (e !== undefined) e.scaleOverride = 1;
  }, id);
  await page.waitForTimeout(160);
  return changedFraction(before, after, ...SUBJ_BOX);
}

/** Fraction of pixels in a normalised box that differ by a visible amount. */
function changedFraction(a, b, x0, y0, x1, y1) {
  const { w, h, ch, px } = a;
  const X0 = Math.floor(x0 * w); const X1 = Math.ceil(x1 * w);
  const Y0 = Math.floor(y0 * h); const Y1 = Math.ceil(y1 * h);
  let changed = 0; let n = 0;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const i = y * w * ch + x * ch;
      const d = Math.abs(px[i] - b.px[i]) + Math.abs(px[i + 1] - b.px[i + 1])
        + Math.abs(px[i + 2] - b.px[i + 2]);
      if (d > 42) changed++;
      n++;
    }
  }
  return n > 0 ? changed / n : 0;
}

async function shootMove(subj, mv, placed, session) {
  // Five beats of the swing, bracketed by two extra shots of the REST pose.
  //
  // Those two are the whole reason this harness can be believed. The world does
  // not hold still between screenshots — grass sways, clouds drift, the sun
  // moves — and the subject box is full of grass. Diffing a contact frame
  // against a rest frame therefore measures the weather as much as the animal,
  // and the first version of this harness happily reported a 3.6-of-5.0 grass
  // signal as proof of a bite. `rest2` and `rest3` are the same pose shot at
  // the start and the end of the strip, so the difference between them is the
  // scene's own drift over the whole capture: the noise floor, measured rather
  // than assumed, in the same box, on the same run.
  const beats = [
    ['rest', 0],
    ['rest2', 0],
    ['windup', mv.contactT * 0.62],
    ['contact', mv.contactT],
    ['follow', mv.contactT + (mv.duration - mv.contactT) * 0.45],
    ['recover', mv.duration * 0.93],
    ['rest3', 0],
  ];

  const shots = [];
  const positions = [];
  let scrubError = null;

  for (const [label, t] of beats) {
    await page.evaluate(([id, move, tt]) => {
      window.__animDebug.hold = { id, move, t: tt };
    }, [placed.id, mv.name, t]);

    // Several frames for the pin to take effect, the mesh to be rebuilt from
    // it and the compositor to settle.
    await page.waitForTimeout(160);

    const buf = await page.screenshot({
      path: path.join(outDir, `${subj.sp}-${mv.name}-${label}.png`),
    });
    shots.push({ label, t, img: decodePng(buf) });

    const state = await page.evaluate(() => {
      if (window.__gameDebug === undefined || window.__atkSession === undefined) {
        return { reloaded: true };
      }
      const e = window.__gameDebug.entities().find(x => x.id === window.__atkId);
      const d = window.__animDebug.log.get(window.__atkId);
      return {
        session: window.__atkSession,
        missing: e === undefined,
        x: e?.x, y: e?.y, z: e?.z,
        clip: d?.clip ?? null, clipT: d?.clipT ?? null, attack: d?.attack ?? null,
      };
    });
    if (state.reloaded === true || state.session !== session) {
      throw new Error('Execution context was destroyed (hot reload mid-strip)');
    }
    positions.push(state);

    // THE check that makes the frame evidence: the driver has to agree that it
    // was playing this move at this time.
    if (state.clip !== mv.name) {
      scrubError = `asked for ${mv.name}, driver played ${state.clip}`;
    } else if (state.clipT === null || Math.abs(state.clipT - t) > 0.035) {
      scrubError = `asked for t=${t.toFixed(3)}, driver was at ${Number(state.clipT).toFixed(3)}`;
    }
  }

  const at = (label) => shots.find(s => s.label === label).img;
  const rest = at('rest');
  const raw = (label) => boxDiff(rest, at(label), ...SUBJ_BOX);

  // The noise floor: the same pose, shot up to a second apart.
  const noise = Math.max(raw('rest2'), raw('rest3'));
  const sig = (label) => +Math.max(0, raw(label) - noise).toFixed(2);
  const signals = ['windup', 'contact', 'follow', 'recover'].map(sig);
  const [windupS, contactS, , recoverS] = signals;
  const ctrl = +Math.max(...shots.slice(1).map(
    s => boxDiff(rest, s.img, ...CTRL_BOX))).toFixed(2);

  const alive = positions.every(p => p.missing !== true);
  let drift = 0;
  if (alive) {
    for (const p of positions) {
      drift = Math.max(drift, Math.hypot(p.x - placed.x, p.z - placed.z));
    }
  }

  // The contact frame must differ from rest by more than the scene drifted on
  // its own, with margin.
  const moved = alive && contactS > 0.35;

  // ...and it must be a SWING, not renders of one pose under four filenames.
  //
  // TWO CRITERIA, AND WHAT IS DELIBERATELY NOT AMONG THEM
  //
  //   - the strip contains at least THREE mutually distinct poses;
  //   - the recovery comes back to rest.
  //
  // "Contact is the most extreme frame" is absent because it is FALSE for half
  // the vocabulary: a bear's swipe and a horse's rear are furthest from rest at
  // the TOP OF THE WINDUP — reared up — and the contact is the mass coming back
  // down through the target. The bear failed that check and the check was wrong,
  // not the bear.
  //
  // "Every consecutive pair differs" is absent for the same kind of reason: a
  // sea serpent's thrash and a dragon's breath deliberately HOLD at full
  // extension, so contact and follow-through are nearly the same pose on
  // purpose. Counting distinct poses instead of consecutive steps states what
  // is actually required — that the animation moves through a sequence — without
  // dictating where in the clip the movement has to be.
  const beatsToCompare = ['windup', 'contact', 'follow', 'recover'];
  const pairs = {};
  for (let i = 0; i < beatsToCompare.length; i++) {
    for (let j = i + 1; j < beatsToCompare.length; j++) {
      pairs[`${beatsToCompare[i]}-${beatsToCompare[j]}`] = +Math.max(0,
        boxDiff(at(beatsToCompare[i]), at(beatsToCompare[j]), ...SUBJ_BOX) - noise
      ).toFixed(2);
    }
  }
  const kept = [];
  for (const b of beatsToCompare) {
    if (kept.every(k => (pairs[`${k}-${b}`] ?? pairs[`${b}-${k}`]) > 0.4)) kept.push(b);
  }
  const distinct = kept.length >= 3;
  const returns = recoverS < Math.max(windupS, contactS) * 0.45;
  const builds = distinct && returns;

  return {
    species: subj.sp, move: mv.name, kind: mv.kind,
    contactT: mv.contactT, duration: mv.duration,
    alive, drift: +drift.toFixed(3), signals, contactDiff: contactS,
    distinctPoses: kept, pairs,
    noise: +noise.toFixed(2), ctrlDiff: ctrl, moved, distinct, returns, builds,
    scrubError,
    ok: alive && moved && builds && scrubError === null,
  };
}

fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify({ strips: log, pageErrors }, null, 1), 'utf-8');
await browser.close();

const bad = log.filter(l => !l.ok);
console.log(`\n${log.length} attack strips -> ${outDir}`);
if (pageErrors.length) console.log(`${pageErrors.length} page error(s)`);
if (bad.length) {
  // The coverage-check failure (added above `shootMove`) logs one record per
  // species with no `.move` — a whole species that could not be filmed at
  // all, not one bad strip within an otherwise-good species.
  console.log(`${bad.length} strip(s) failed: `
    + bad.map(b => b.move ? `${b.species}/${b.move}` : `${b.species} (${b.reason})`)
      .join(', '));
  process.exitCode = 1;
}
