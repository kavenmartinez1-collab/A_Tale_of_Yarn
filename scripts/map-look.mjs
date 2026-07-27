/**
 * What does the map actually look like?
 *
 *   node scripts/map-look.mjs
 *
 * Explores a decent chunk of world, opens the pause screen, and photographs
 * the chart at every zoom level plus a pan and a recentre. The output is for a
 * HUMAN to look at: legibility is not something an assertion can check, and
 * this repo's rule is that green checks report success over broken pictures.
 *
 * It does still measure the things that can be measured — that the canvas is
 * not blank, that the stitching finishes, that opening does not hitch, and
 * that panning is clamped — so a run that produces a black rectangle says so
 * rather than leaving it for someone to notice.
 *
 * Shots land in scripts/shots/map/.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'scripts/shots/map';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 160)}`);
  }
});

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

await page.goto('http://localhost:5173/game.html?director=off&tod=0.42&weather=clear&wipe=1',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(2500);

const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — __gameDebug gone (page reloaded mid-run)\n');
    for (const e of errors.slice(0, 4)) process.stdout.write(`   ${e}\n`);
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

// ---------------------------------------------------------------------------
// Explore. Short hops so the reveal discs overlap into a corridor rather than
// a string of dots — the shape a walk actually leaves.
// ---------------------------------------------------------------------------
const legs = [
  // Out of the castle, east along the road toward the settlements.
  ...Array.from({ length: 22 }, (_, i) => [-320 + i * 80, 40 + i * 24]),
  // A long loop south through ranch country.
  ...Array.from({ length: 24 }, (_, i) => [1360 - i * 40, 544 + i * 80]),
  // West along the bottom of the run.
  ...Array.from({ length: 22 }, (_, i) => [440 - i * 90, 2384 - i * 30]),
  // North again, closing a rough circuit — the chart gets a loop, not a line.
  ...Array.from({ length: 26 }, (_, i) => [-1450 + i * 30, 1754 - i * 90]),
  // A spur north-east into land nothing else touched.
  ...Array.from({ length: 18 }, (_, i) => [-670 + i * 95, -496 - i * 35]),
];
for (const [x, z] of legs) {
  await D(([px, pz]) => { window.__gameDebug.teleport(px, pz); }, [x, z]);
  await page.waitForTimeout(110);
}
await page.waitForTimeout(1500);
const explored = await D(() => window.__gameDebug.mapStats());
note(explored.chunks > 800 ? 'ok' : 'BUG', 'explored enough to judge the chart',
  `${explored.chunks} chunks, ${explored.tiles} tiles, `
  + `${((explored.x1 - explored.x0) / 1000).toFixed(1)}x`
  + `${((explored.z1 - explored.z0) / 1000).toFixed(1)} km, `
  + `${(explored.bytes / 1024).toFixed(1)} KB`);

// Stand somewhere characterful for the shot.
await D(() => { window.__gameDebug.teleportToNearestSettlement(); });
await page.waitForTimeout(1500);

// ---------------------------------------------------------------------------
// Open the pause screen, and time it.
// ---------------------------------------------------------------------------
const open = await page.evaluate(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const frames = [];
  window.__gameDebug.resetMapProfile();
  let prev = performance.now();
  window.__gameDebug.setPaused(true);
  for (let i = 0; i < 30; i++) {
    await raf();
    const now = performance.now();
    frames.push(now - prev);
    prev = now;
  }
  return { frames, profile: window.__gameDebug.mapProfile() };
});
const worstOpen = Math.max(...open.frames);
const worstAt = open.frames.indexOf(worstOpen);
const mapWork = open.profile.map((p) => p.work + p.draw);
const worstMap = mapWork.length > 0 ? Math.max(...mapWork) : 0;
// The two costs are separate and only one of them is the map's. Opening ANY
// full-screen DOM overlay over the WebGPU canvas costs the browser one paint
// frame — measured at 106 ms for the game's own inventory panel, which
// shipped. So the assertion that matters is on the work this feature does.
note(worstMap < 12 ? 'ok' : 'BUG', 'the map itself never overruns its budget',
  `worst map frame ${worstMap.toFixed(1)} ms of a 6 ms bake budget + draw, `
  + `over ${mapWork.length} frames; the chart stitches in incrementally`);
note(worstOpen < 130 ? 'ok' : 'BUG', 'and the open frame is DOM paint, not the map',
  `worst frame ${worstOpen.toFixed(0)} ms at frame ${worstAt} `
  + `(median ${open.frames.slice().sort((a, b) => a - b)[15].toFixed(0)} ms); `
  + `the map's own work on that frame was `
  + `${(mapWork[worstAt] ?? 0).toFixed(1)} ms — for comparison the shipped `
  + 'inventory panel costs ~106 ms on its open frame');

// Let the incremental baker finish.
await page.waitForTimeout(4000);

const present = await D(() => {
  const el = document.getElementById('pause-screen');
  const c = el?.querySelector('canvas');
  return {
    panel: el !== null,
    w: c?.width ?? 0,
    h: c?.height ?? 0,
    head: el?.querySelector('.chart-where')?.textContent ?? null,
    count: el?.querySelector('.chart-count')?.textContent ?? null,
  };
});
note(present.panel && present.w > 400 ? 'ok' : 'BUG', 'the chart is on screen',
  `canvas ${present.w}x${present.h}, header "${present.head}", "${present.count}"`);
note(!(present.count ?? '').includes('stitching') ? 'ok' : 'BUG',
  'the chart finished stitching', present.count ?? '');

/** Is the canvas actually painted, or a flat rectangle? */
const inkStats = await D(() => {
  const c = document.querySelector('#pause-screen canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const seen = new Map();
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) { // stride-sample
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    seen.set(k, (seen.get(k) ?? 0) + 1);
    n++;
  }
  const top = [...seen.values()].sort((a, b) => b - a)[0];
  return { distinct: seen.size, samples: n, dominantPct: (top / n) * 100 };
});
note(inkStats.distinct > 150 && inkStats.dominantPct < 70 ? 'ok' : 'BUG',
  'the chart is drawn, not a flat fill',
  `${inkStats.distinct} distinct colours over ${inkStats.samples} samples, `
  + `most common covers ${inkStats.dominantPct.toFixed(1)}%`);

await page.screenshot({ path: `${OUT}/01-default-zoom.png` });

// ---------------------------------------------------------------------------
// Every zoom level.
// ---------------------------------------------------------------------------
const clickZoom = async (dir, times) => {
  for (let i = 0; i < times; i++) {
    const open = await page.evaluate(() => document.getElementById('pause-screen') !== null);
    if (!open) {
      // Reopen rather than time out on a missing selector: a lost pause screen
      // is itself the finding, and a 30 s Playwright timeout hides it.
      note('BUG', 'the pause screen closed on its own',
        `while zooming ${dir}; reopened to continue the run`);
      await page.evaluate(() => { window.__gameDebug.setPaused(true); });
      await page.waitForTimeout(1500);
    }
    await page.click(`#pause-screen .zoom-row .stitch-btn:nth-child(${dir === 'in' ? 2 : 1})`);
    await page.waitForTimeout(700);
  }
};
await clickZoom('in', 3);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/02-zoom-in-max.png` });
await clickZoom('out', 2);
await page.waitForTimeout(2500);

// ---------------------------------------------------------------------------
// Pan by dragging, then recentre.
// ---------------------------------------------------------------------------
const box = await page.locator('#pause-screen canvas').boundingBox();
const centreBefore = await D(() => {
  const el = document.getElementById('pause-screen');
  return el?.querySelector('.chart-count')?.textContent ?? '';
});
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + box.width * 0.7 - i * 22, box.y + box.height * 0.6 - i * 12);
  await page.waitForTimeout(25);
}
await page.mouse.up();
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/04-panned.png` });

// Pan hard into empty space; the clamp must stop us. Zoomed IN first, so the
// viewport is genuinely smaller than the charted world and the clamp is doing
// real work rather than trivially centring a chart that already fits.
await clickZoom('in', 2);
await page.waitForTimeout(1500);
for (let rep = 0; rep < 10; rep++) {
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.85);
  await page.mouse.down();
  await page.mouse.move(box.x + 12, box.y + 12, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(90);
}
await page.waitForTimeout(1500);
const clamped = await D(() => ({
  stats: window.__gameDebug.mapStats(),
  view: window.__gameDebug.mapView(),
}));
await page.screenshot({ path: `${OUT}/05-panned-to-clamp.png` });
const MARGIN = 400; // PAN_MARGIN in map-view.ts
const v = clamped.view;
const s = clamped.stats;
const inside = v !== null
  && v.x0 >= s.x0 - MARGIN - 1 && v.x1 <= s.x1 + MARGIN + 1
  && v.z0 >= s.z0 - MARGIN - 1 && v.z1 <= s.z1 + MARGIN + 1;
note(inside ? 'ok' : 'BUG', 'ten hard drags cannot pan off the discovered world',
  v === null ? 'no view' : `view ${v.x0.toFixed(0)}..${v.x1.toFixed(0)} x `
    + `${v.z0.toFixed(0)}..${v.z1.toFixed(0)} inside charted `
    + `${s.x0}..${s.x1} x ${s.z0}..${s.z1} (+${MARGIN} m margin) at ${v.mPerPx} m/px`);

// And zooming out cannot leave the chart behind either.
await clickZoom('out', 8);
await page.waitForTimeout(3000);
const zoomedOut = await D(() => ({
  stats: window.__gameDebug.mapStats(), view: window.__gameDebug.mapView(),
}));
const zv = zoomedOut.view;
const zs = zoomedOut.stats;
const worldW = zs.x1 - zs.x0;
const shown = zv.x1 - zv.x0;
note(shown < worldW * 6 ? 'ok' : 'BUG',
  'zoom-out stops once the whole chart is on screen',
  `charted ${(worldW / 1000).toFixed(1)} km, viewport shows `
  + `${(shown / 1000).toFixed(1)} km at ${zv.mPerPx} m/px — `
  + 'unbounded zoom-out would leave the chart a speck in blank linen');
await page.screenshot({ path: `${OUT}/03-zoom-out-max.png` });
await clickZoom('in', 2);
await page.waitForTimeout(2000);

// Recentre with the Home key.
await page.keyboard.press('Home');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/06-recentred.png` });

// A tight zoom on the player, to judge the marker and the stitch texture.
await clickZoom('in', 2);
await page.waitForTimeout(2500);
await page.keyboard.press('Home');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/07-player-closeup.png` });
const closeBox = await page.locator('#pause-screen canvas').boundingBox();
await page.screenshot({
  path: `${OUT}/08-player-crop.png`,
  clip: {
    x: closeBox.x + closeBox.width / 2 - 230, y: closeBox.y + closeBox.height / 2 - 150,
    width: 460, height: 300,
  },
});

// ---------------------------------------------------------------------------
for (const e of errors.slice(0, 6)) note('BUG', 'page error', e);
const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\nmap-look: ${bugs.length} bugs, ${findings.length - bugs.length} ok`
  + `\nshots in ${OUT}/ — LOOK AT THEM\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
