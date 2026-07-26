/**
 * Idle-animation filmstrips — the verification the WALK harness cannot do.
 *
 *   node scripts/anim-idle.mjs <outDir> [speciesFilter]
 *
 * `creature-walk.mjs` films a moving animal, which proves the gait works and
 * proves nothing at all about the thing that occupies most of a creature's
 * life: standing still. Before the clip system a standing animal was a statue
 * with one hardcoded `sin()` head sweep; the additive idle layer, the graze
 * clip and the wing-beat-at-rest are all invisible in a walk strip.
 *
 * So: hold ONE animal still, hold the camera still, and film it. Anything that
 * moves in the resulting strip is the idle layer, because nothing else is
 * moving.
 *
 * HOW THIS HARNESS TRIES NOT TO LIE TO YOU
 *
 * Every previous capture harness in this repo has at some point reported
 * success while filming the wrong thing — the back of the player's head, six
 * standing animals described as a gait, front views that were rear views. The
 * countermeasures here:
 *
 *   1. **The subject is measured, not assumed.** After the strip is shot, the
 *      subject's id is looked up again and its mode reported. If it wandered
 *      off or was despawned, that is printed rather than silently producing a
 *      strip of empty grass.
 *   2. **Motion is measured, not assumed.** Frames are diffed against frame 0
 *      inside a box around the creature, and against a CONTROL box of empty
 *      sky. Grass sway and cloud drift move too, so a raw whole-frame diff
 *      proves nothing; the subject box has to move MORE than the control.
 *   3. **Stillness is verified.** The entity's world position is sampled every
 *      frame. If it drifts, the strip is a walk cycle wearing an idle's
 *      clothes and is reported as such.
 *   4. **Hot reloads are detected and the strip is re-shot.** Vite reloads the
 *      page whenever anything under `src/` is written, which wipes
 *      `__gameDebug`, destroys the spawned subject and leaves a strip of empty
 *      grass that looks exactly like a rendering failure. This cost a capture
 *      run to diagnose. If the game context disappears mid-strip the attempt
 *      is discarded and retried rather than reported.
 *
 * Requires `npm run dev` (port 5173).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outDir = process.argv[2] || 'scripts/shots/idle';
const filter = process.argv[3] || '';

/** Subjects: species, the AI mode to pin, and a label for the strip. */
const SUBJECTS = [
  { sp: 'deer', mode: 'idle', size: 1.2 },
  { sp: 'cow', mode: 'graze', size: 1.4 },
  { sp: 'wolf', mode: 'idle', size: 0.9 },
  { sp: 'dragon', mode: 'idle', size: 3.5 },
];

const FRAMES = 6;
const FRAME_MS = 900;

fs.mkdirSync(outDir, { recursive: true });

// --- minimal PNG decode (RGBA, 8-bit, no interlace) -------------------------
// Playwright hands back a PNG buffer; we only need pixel deltas, and pulling in
// an image library for that is not worth it.
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

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
const pageErrors = [];
page.on('pageerror', (e) => {
  pageErrors.push(e.message.slice(0, 200));
  console.error('  [pageerror]', e.message.slice(0, 200));
});

/** Marker used to notice that the page reloaded under us. */
async function stampSession() {
  await page.evaluate(() => { window.__idleSession = (window.__idleSession || 0) + 1; });
  return page.evaluate(() => window.__idleSession);
}

const log = [];
const MAX_TRIES = 3;
for (const subj of SUBJECTS) {
  if (filter && !subj.sp.includes(filter)) continue;
  process.stdout.write(`${(subj.sp + '/' + subj.mode).padEnd(14)} `);
  let result = null;
  let reloads = 0;
  for (let attempt = 0; attempt < MAX_TRIES && result === null; attempt++) {
    try {
      result = await shoot(subj);
    } catch (err) {
      // "Execution context was destroyed" is what a hot reload looks like from
      // out here. Anything else is a real failure and should surface.
      if (!/Execution context was destroyed|__gameDebug/.test(String(err))) throw err;
      result = null;
    }
    if (result === null) reloads++;
  }
  if (result === null) {
    console.log(`WARNING: could not capture after ${MAX_TRIES} attempts `
      + '(page kept reloading — is something writing to src/?)');
    log.push({ species: subj.sp, mode: subj.mode, animated: false, reloads });
    continue;
  }
  result.reloads = reloads;
  log.push(result);
  report(result);
}

function report(r) {
  if (!r.alive) {
    console.log('WARNING: subject VANISHED mid-strip — the frames show empty grass');
  } else if (r.drift > 0.35) {
    console.log(`WARNING: subject MOVED ${r.drift.toFixed(2)} m — this is not an idle strip`);
  } else if (!r.animated) {
    console.log(`WARNING: subject is STATIC (subject diff ${r.subjMax} vs sky ${r.ctrlMax})`);
  } else {
    console.log(`ok (motion ${r.subjMax} vs sky ${r.ctrlMax}, `
      + `drift ${r.drift.toFixed(3)} m, mode ${r.finalMode}`
      + (r.reloads ? `, ${r.reloads} retr${r.reloads > 1 ? 'ies' : 'y'}` : '') + ')');
  }
}

async function shoot(subj) {
  await page.goto('http://localhost:5173/game.html?director=off&tod=0.52&weather=clear',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined,
    { timeout: 60_000 });
  await page.waitForTimeout(1200);

  const dist = 1.0 + 2.6 * subj.size;
  const placed = await page.evaluate(async (cfg) => {
    const g = window.__gameDebug;
    // Flattest ground available — a slope makes the downhill legs hang and
    // reads as floating, which looks exactly like a rig bug.
    let best = null;
    for (let gx = -6; gx <= 6; gx++) {
      for (let gz = -6; gz <= 6; gz++) {
        const x = 244 + gx * 9, z = -304 + gz * 9;
        const hgt = g.heightAt(x, z);
        if (hgt < 1.0) continue;
        let dev = 0;
        for (const [ox, oz] of [[-5, 0], [5, 0], [0, -5], [0, 5], [-4, -4], [4, 4]]) {
          dev = Math.max(dev, Math.abs(g.heightAt(x + ox, z + oz) - hgt));
        }
        if (best === null || dev < best.dev) best = { x, z, dev };
      }
    }
    g.teleport(best.x, best.z);
    for (const e of g.entities()) g.killEntity(e.id);

    // 26 m clears the 12 m flee and 16 m aggro radii outright, so the subject
    // is not re-triggered every tick by the player's presence.
    const sp = g.spawnEntity(cfg.sp, 0, -26);
    if (sp === null) return null;
    g.setPortraitSubject(sp.id);

    window.__idleStop = false;
    window.__idleId = sp.id;
    const drive = () => {
      if (window.__idleStop) return;
      // Pin the mode and keep the timer POSITIVE. animal-ai treats
      // stateTimer <= 0 as "this state timed out" and moves on; that is what
      // made the first walk harness film six standing animals, and here it
      // would do the reverse — an "idle" subject that wanders out of frame.
      sp.mode = cfg.mode;
      sp.stateTimer = 600;
      g.setCamera(Math.PI / 2, -0.02, cfg.dist);
      requestAnimationFrame(drive);
    };
    drive();
    return { x: sp.x, y: sp.y, z: sp.z, dev: best.dev };
  }, { sp: subj.sp, mode: subj.mode, dist });

  if (placed === null) throw new Error('__gameDebug spawn returned null');
  const session = await stampSession();

  await page.addStyleTag({ content: 'body > *:not(canvas){display:none!important}' });
  await page.waitForTimeout(1500);

  const shots = [];
  const positions = [];
  for (let i = 0; i < FRAMES; i++) {
    const buf = await page.screenshot({
      path: path.join(outDir, `${subj.sp}-${subj.mode}-${i}.png`),
    });
    shots.push(decodePng(buf));
    const state = await page.evaluate(() => {
      if (window.__gameDebug === undefined || window.__idleSession === undefined) {
        return { reloaded: true };
      }
      const e = window.__gameDebug.entities().find(x => x.id === window.__idleId);
      return e
        ? { session: window.__idleSession, x: e.x, y: e.y, z: e.z, mode: e.mode }
        : { session: window.__idleSession, missing: true };
    });
    // A page reload resets every `window` global, so a changed (or absent)
    // session stamp means these frames belong to a different world.
    if (state.reloaded === true || state.session !== session) {
      throw new Error('Execution context was destroyed (hot reload mid-strip)');
    }
    positions.push(state.missing === true ? null : state);
    await page.waitForTimeout(FRAME_MS);
  }

  await page.evaluate(() => { window.__idleStop = true; });

  // --- did the SUBJECT move, and did it move more than the background? -----
  // The creature occupies roughly the middle of the frame; the control box is
  // upper-left sky, which only clouds touch.
  let subjMax = 0, ctrlMax = 0;
  for (let i = 1; i < shots.length; i++) {
    subjMax = Math.max(subjMax, boxDiff(shots[0], shots[i], 0.32, 0.18, 0.70, 0.62));
    ctrlMax = Math.max(ctrlMax, boxDiff(shots[0], shots[i], 0.02, 0.02, 0.22, 0.16));
  }

  const alive = positions.every(p => p !== null);
  let drift = 0;
  if (alive) {
    for (const p of positions) {
      drift = Math.max(drift, Math.hypot(p.x - placed.x, p.z - placed.z));
    }
  }

  const animated = alive && subjMax > 1.0 && subjMax > ctrlMax * 2;
  return {
    species: subj.sp, mode: subj.mode, frames: FRAMES, ground: placed,
    alive, drift, subjMax: +subjMax.toFixed(2), ctrlMax: +ctrlMax.toFixed(2),
    finalMode: alive ? positions[positions.length - 1].mode : null, animated,
  };
}

fs.writeFileSync(path.join(outDir, 'session.json'),
  JSON.stringify({ strips: log, pageErrors }, null, 1), 'utf-8');
await browser.close();

const bad = log.filter(l => !l.animated);
console.log(`\n${log.length} idle strips -> ${outDir}`);
if (pageErrors.length) console.log(`${pageErrors.length} page error(s)`);
if (bad.length) {
  console.log(`${bad.length} subject(s) showed no idle motion: ${bad.map(b => b.species).join(', ')}`);
  process.exitCode = 1;
}
