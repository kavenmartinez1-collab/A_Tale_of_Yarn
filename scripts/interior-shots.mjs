/**
 * Interior capture harness — walks into every building kind and photographs
 * it from the doorway, the middle and the focal end, by day and by night.
 *
 *   node scripts/interior-shots.mjs [outDir] [kindFilter] [--yawsweep]
 *
 * Requires the vite dev server on :5173 (npx vite).
 *
 * ## Why this distrusts itself
 *
 * Two "black screens" in this repo turned out to be a death overlay and an
 * NPC chat panel, and a portrait harness once photographed the back of the
 * player's head for a whole session while reporting success. So every shot is
 * only counted when:
 *   - no page error fired,
 *   - `__gameDebug.insideBuilding()` is true,
 *   - `__buildingDebug.kind` is the kind we asked for,
 *   - no DOM panel covers more than a tenth of the viewport,
 *   - the image has real contrast (mean luminance and stddev in range).
 * Anything else is printed as a FAIL with the reason, not silently saved.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/interiors';
const kindFilter = (process.argv[3] || '').replace(/^--.*/, '');
const yawSweep = process.argv.includes('--yawsweep');

const KINDS = [
  'house', 'shop', 'tavern', 'keep', 'church',
  'longhouse', 'smithy', 'barn', 'guardhouse',
];

/** [label, placement, yawDeg, pitchDeg, distance] */
// yaw 0 puts the camera behind the player looking toward -Z, which is the
// end every interior composes toward. Getting this backwards photographs the
// wall behind you and reports success.
const VIEWS = [
  ['door', 'atDoor', 0, -7, 3.2],
  ['room', 'atCenter', 0, -9, 3.6],
  ['back', 'atFocus', 180, -8, 3.4],
];

const TIMES = [['day', 0.52], ['night', 0.03]];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

let pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    pageErrors.push(`console: ${t.slice(0, 300)}`);
  }
});

/** Panels that would sit between the camera and the thing we came to see. */
async function overlayReport() {
  return page.evaluate(() => {
    const vw = innerWidth * innerHeight;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.tagName === 'CANVAS') continue;
      // #overlay is the transparent click-to-play prompt; #lightning-flash is a
      // full-screen tint layer that is invisible unless a strike is in frame.
      if (['hud', 'overlay', 'lightning-flash'].includes(el.id)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > vw * 0.1) {
        bad.push(`${el.tagName}#${el.id || ''}.${(el.className || '').toString().slice(0, 24)}`);
      }
    }
    return bad.slice(0, 4);
  });
}

async function imageStats(buf) {
  const { data, info } = await sharp(buf).resize(160, 90, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  const lum = new Float64Array(info.width * info.height);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    lum[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += lum[p];
  }
  const mean = sum / lum.length;
  let v = 0;
  for (const l of lum) v += (l - mean) ** 2;
  return { mean, std: Math.sqrt(v / lum.length) };
}

const results = [];
let failures = 0;

for (const kind of KINDS) {
  if (kindFilter && kind !== kindFilter) continue;
  for (const [timeName, tod] of TIMES) {
    pageErrors = [];
    const url = `http://localhost:5173/game.html?director=off&interior=${kind}`
      + `&tod=${tod}&weather=clear`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
    await page.waitForTimeout(1_200);

    const entered = await page.evaluate(() => {
      const dbg = window.__gameDebug;
      if (!dbg) return { ok: false, why: 'no __gameDebug' };
      dbg.teleportToNearestSettlementSign();
      const ok = dbg.enterNearestBuilding();
      return { ok, why: ok ? '' : 'enterNearestBuilding returned false' };
    });
    if (!entered.ok) {
      console.log(`FAIL ${kind}/${timeName}: ${entered.why}`);
      failures++;
      continue;
    }
    await page.waitForTimeout(1_400);

    const info = await page.evaluate(() => ({
      inside: window.__gameDebug.insideBuilding(),
      b: window.__buildingDebug ? { ...window.__buildingDebug, teleport: undefined,
        atDoor: undefined, atFocus: undefined, atCenter: undefined,
        rentedRooms: undefined } : null,
      err: window.__gameError ?? null,
    }));
    if (!info.inside || !info.b) {
      console.log(`FAIL ${kind}/${timeName}: not inside a building`);
      failures++;
      continue;
    }
    if (info.b.kind !== kind) {
      console.log(`FAIL ${kind}/${timeName}: entered a ${info.b.kind}, asked for ${kind}`);
      failures++;
      continue;
    }
    if (info.err) {
      console.log(`FAIL ${kind}/${timeName}: GPU error ${info.err}`);
      failures++;
      continue;
    }

    const views = yawSweep
      ? [0, 90, 180, 270].map((y) => [`sweep${y}`, 'atCenter', y, -8, 3.4])
      : VIEWS;

    for (const [label, place, yawDeg, pitchDeg, dist] of views) {
      await page.evaluate(([p, y, pi, d]) => {
        window.__buildingDebug[p]();
        window.__gameDebug.setCamera(y * Math.PI / 180, pi * Math.PI / 180, d);
      }, [place, yawDeg, pitchDeg, dist]);
      await page.waitForTimeout(900);

      const file = path.join(outDir, `${kind}-${timeName}-${label}.png`);
      const buf = await page.screenshot();
      fs.writeFileSync(file, buf);

      const overlays = await overlayReport();
      const st = await imageStats(buf);
      const stats = await page.evaluate(() => window.__gameStats ?? {});
      const bad = [];
      if (overlays.length > 0) bad.push(`overlay ${overlays.join(',')}`);
      // A lit interior is never flat: no contrast means we photographed a wall
      // an inch from the lens, or nothing at all.
      if (st.std < 6) bad.push(`flat image std=${st.std.toFixed(1)}`);
      if (st.mean < 3) bad.push(`black image mean=${st.mean.toFixed(1)}`);
      if (pageErrors.length > 0) bad.push(`pageerror ${pageErrors[0]}`);

      results.push({
        kind, time: timeName, view: label, file,
        mean: +st.mean.toFixed(1), std: +st.std.toFixed(1),
        fps: stats.fps ?? null, ok: bad.length === 0, bad,
      });
      if (bad.length > 0) failures++;
      console.log(`${bad.length ? 'FAIL' : ' ok '} ${kind}/${timeName}/${label}`
        + `  mean=${st.mean.toFixed(1)} std=${st.std.toFixed(1)} fps=${stats.fps ?? '?'}`
        + (bad.length ? `  <- ${bad.join('; ')}` : ''));
    }

    if (timeName === 'day') {
      console.log(`     ${kind}: ${info.b.grid[0]}x${info.b.grid[1]} cells, `
        + `${info.b.furniture} furniture, ${info.b.decor} decor, ${info.b.lights} lights, `
        + `${info.b.draws} draws, ${info.b.propVerts} verts, `
        + `build ${info.b.buildMs.toFixed(1)} ms  rooms=[${info.b.rooms.join(' | ')}]`);
    }
  }
}

// ---- bed rental, end to end ------------------------------------------------
//
// Walks the real interaction: stand by a rentable bed, read the prompt the HUD
// would show, press E, read the notice, press E again. Nothing here reads the
// manager's internals — it is exactly what a player does.

if (!kindFilter || kindFilter === 'tavern') {
  pageErrors = [];
  await page.goto('http://localhost:5173/game.html?director=off&interior=tavern&tod=0.5&weather=clear',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(1_200);

  const rent = await page.evaluate(async () => {
    const dbg = window.__gameDebug;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const press = () => document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }));
    dbg.teleportToNearestSettlementSign();
    if (!dbg.enterNearestBuilding()) return { err: 'could not enter' };
    if (window.__buildingDebug.kind !== 'tavern') {
      return { err: `entered a ${window.__buildingDebug.kind}` };
    }
    const beds = window.__buildingDebug.furniture;
    if (!dbg.buildingTeleportToBed()) return { err: 'no bed', beds };
    await wait(400);
    const before = window.__gameStats.interactPrompt;
    const goldBefore = dbg.countItem('gold_small');
    press();
    await wait(400);
    const noticeAfterPay = window.__gameStats.notice;
    const promptAfterPay = window.__gameStats.interactPrompt;
    const goldAfter = dbg.countItem('gold_small');
    press();
    await wait(400);
    return {
      before, noticeAfterPay, promptAfterPay,
      noticeAfterSleep: window.__gameStats.notice,
      promptAfterSleep: window.__gameStats.interactPrompt,
      goldBefore, goldAfter,
      rented: window.__buildingDebug.rentedRooms(),
    };
  });

  const okRent = !rent.err
    && /rent this bed/i.test(rent.before ?? '')
    && /tavern keeper/i.test(rent.noticeAfterPay ?? '')
    && /sleep until morning/i.test(rent.promptAfterPay ?? '')
    && /sleep soundly/i.test(rent.noticeAfterSleep ?? '');
  console.log(`\n${okRent ? ' ok ' : 'FAIL'} bed rental: ${JSON.stringify(rent)}`);
  if (!okRent) failures++;
}

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(results, null, 1));
console.log(`\n${results.length - failures}/${results.length} shots clean, ${failures} problems`);
await browser.close();
process.exitCode = failures > 0 ? 1 : 0;
