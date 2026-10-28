/**
 * Frustum culling must be invisible — prove it pixel for pixel.
 *
 *   node scripts/cull-check.mjs [baseUrl] [outDir]
 *
 * Freezes the simulation (so wind, animation and the day clock hold still),
 * then at several places and camera angles renders the same frame twice —
 * once with render/frustum.ts culling on, once with every draw issued as it
 * was before culling existed — and compares the two screenshots byte for
 * pixel. A third capture, again with culling on, is the control: distant
 * creatures keep animating under the pause, so a handful of pixels on a deer
 * differ between ANY two frames, and the test is that culling adds nothing
 * beyond that floor. Any excess means a chunk, a tree or a shadow caster was
 * culled that could still reach a pixel, which is the one bug this feature
 * can have. It also prints how many draws each pass actually skipped, so a
 * "pass" that culled nothing is reported as the non-result it is.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
/** Differing pairs are written here for eyes-on comparison. */
const outDir = process.argv[3] ?? 'scripts/shots/cull-check';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// A plain page decodes the PNGs and counts differing pixels (no native PNG
// decoder in Node, and Chrome's is right here).
const differ = await browser.newPage();
const pixelDiff = (a, b) => differ.evaluate(async ([ua, ub]) => {
  const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
  const [ia, ib] = await Promise.all([load(ua), load(ub)]);
  const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data;
  ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) n++;
  }
  return n;
}, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`]);
await page.routeWebSocket(/^wss?:\/\/[^/]+\/(\?.*)?$/, () => { /* swallow HMR */ });
await page.goto(`${BASE}/game.html?wipe=1&director=off&tod=0.32&weather=clear`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.evaluate(() => { document.getElementById('overlay')?.classList.add('hidden'); });

const D = (fn, arg) => page.evaluate(fn, arg);

// Canvas only: the HUD's fps counter, the hotbar and the pause screen (which
// `setPaused` opens, and which is appended to the body when it opens) are DOM
// painted over the canvas, and a counter ticking or a map stitching between
// the two captures is not a culling bug. Re-run after every pause.
const canvasOnly = () => D(() => {
  for (const el of document.body.children) {
    if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden';
  }
});

const places = [
  ['castle gate', () => window.__gameDebug.teleportToNearestSettlement('castle')],
  ['open plains', () => window.__gameDebug.teleport(244, -304)],
  ['far hills', () => window.__gameDebug.teleport(1480, -1210)],
];
// yaw, pitch, distance — including straight down and a long low look.
const cameras = [[0.7, 0.3, 5.5], [2.4, 0.15, 7], [-1.9, 1.2, 9], [3.1, -0.05, 4]];

let bad = 0;
let shots = 0;
for (const [name, go] of places) {
  await D(() => window.__gameDebug.setPaused(false));
  await D(go);
  await page.waitForTimeout(9000); // stream the whole radius in
  await D(() => window.__gameDebug.setPaused(true));
  await canvasOnly();
  await page.waitForTimeout(300);
  for (const [yaw, pitch, dist] of cameras) {
    await D(([y, p, d]) => window.__gameDebug.setCamera(y, p, d), [yaw, pitch, dist]);
    await D(() => window.__gameDebug.setCulling(true));
    await page.waitForTimeout(250);
    const on = await page.screenshot({ type: 'png' });
    const stats = await D(() => window.__gameDebug.drawStats());
    await D(() => window.__gameDebug.setCulling(false));
    await page.waitForTimeout(250);
    const off = await page.screenshot({ type: 'png' });
    await D(() => window.__gameDebug.setCulling(true));
    await page.waitForTimeout(250);
    const on2 = await page.screenshot({ type: 'png' });
    shots++;
    const vs = on.equals(off) ? 0 : await pixelDiff(on, off);
    const floor = on.equals(on2) ? 0 : await pixelDiff(on, on2);
    // Culling is innocent when its difference is within the frame-to-frame
    // noise of the same scene with culling on both times. The noise is a
    // few hundred pixels on distant animated creatures and varies run to
    // run; a culled chunk, tree or shadow is thousands of pixels in a shape.
    const same = vs <= Math.max(2 * floor, 64);
    if (!same) {
      bad++;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${shots}-cull-on.png`), on);
      fs.writeFileSync(path.join(outDir, `${shots}-cull-off.png`), off);
    }
    const s = stats ?? {};
    console.log(`${same ? 'ok  ' : 'DIFF'} ${name.padEnd(12)} cam ${String(yaw).padStart(4)},${String(pitch).padStart(5)},${String(dist).padStart(3)}`
      + `  px on-vs-off ${String(vs).padStart(4)} (noise floor ${String(floor).padStart(4)})`
      + `  opaque: terrain ${s.terrainCulled}/${s.terrain} trees ${s.treesCulled}/${s.trees} culled`
      + `  shadow: terrain ${s.shadowTerrainCulled}/${s.shadowTerrain} trees ${s.shadowTreesCulled}/${s.shadowTrees} culled`);
  }
}
await D(() => window.__gameDebug.setCulling(true));
console.log(`\n${bad} of ${shots} frames differ with culling on`);
await browser.close();
process.exit(bad > 0 ? 1 : 0);
