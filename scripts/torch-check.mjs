/**
 * torch-check.mjs — does a held torch actually do anything?
 *
 *   npx vite            # dev server on :5173
 *   node scripts/torch-check.mjs [baseUrl] [outDir]
 *
 * "A light was added to the list" is not evidence. Every lighting beat here is
 * judged by MEASURING PIXELS: the same scene is rendered twice, once with the
 * torch in hand and once with it swapped for a stick, and the beat passes only
 * if the lit frame is measurably brighter. Screenshots are written out so the
 * numbers can be checked by eye afterwards.
 *
 * Burn, warmth and pause beats are judged against `__gameDebug.torchState()`
 * and `vitals()`, not against the HUD — the bar is a view of the fuel, so
 * asserting the bar would be asserting the wrong thing.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'scripts/shots/torch';
fs.mkdirSync(OUT, { recursive: true });

const bugs = [];
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, ok, detail) => {
  log(`  ${ok ? 'ok  ' : 'BUG '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bugs.push(name);
};

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
page.on('pageerror', (e) => log(`  [pageerror] ${e.message.slice(0, 200)}`));

// Cut vite's HMR socket before anything loads. Other agents work in this repo
// while harnesses run, and every file they save makes vite push a full-page
// reload — which restarts the world in the middle of a measurement and turns a
// beat into a reading of a fresh spawn. Stubbing the socket (never calling
// connectToServer) leaves `import.meta.hot` intact and simply means no update
// ever arrives. The boot counter below still guards against everything else.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

await page.goto(`${BASE}/game.html?director=off&tod=0.02&weather=clear`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(1500);

// Reload detection. A reload wipes the boot counter, and every beat after that
// would be measuring a fresh spawn instead of the state we set up — which is
// exactly how a filmstrip in this repo ended up with every frame at spawn and
// the beats filed as successes.
await page.evaluate(() => { window.__torchBoot = (window.__torchBoot ?? 0) + 1; });
const bootOk = async (phase) => {
  const v = await page.evaluate(() => window.__torchBoot ?? null);
  if (v !== 1) {
    log(`\n!! RUN INVALID — page reloaded during "${phase}" (boot counter ${v})`);
    await browser.close();
    process.exit(2);
  }
};
const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    log('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

/** Mean luminance 0..255 of a PNG buffer, via an offscreen canvas. */
async function meanLuma(buf) {
  const p = await browser.newPage();
  const v = await p.evaluate(async (d) => {
    const img = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${d}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, img.width, img.height).data;
    let s = 0;
    for (let i = 0; i < px.length; i += 4) {
      s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    }
    return s / (px.length / 4);
  }, buf.toString('base64'));
  await p.close();
  return v;
}

/**
 * Every measurement below is void if the player is dead: the death overlay
 * dims the whole frame, and the fixed-step vitals block that burns torch fuel
 * sits inside `if (!isDead)`. The first version of this harness measured a
 * corpse in the castle and reported both "the torch lights nothing" and "fuel
 * does not drain" — neither was true.
 */
const revive = async (where) => {
  const v = await D(() => {
    const g = window.__gameDebug;
    g.setVitals({ hp: 20, thirst: 100, stamina: 100, alive: true });
    g.healPlayer(20);
    return g.vitals();
  });
  if (!v.alive) {
    log(`  !! could not revive before "${where}" — measurements would be void`);
    bugs.push(`dead during ${where}`);
  }
  return v.alive;
};

/**
 * Put exactly `inHand` torches in the selected slot and `spare` in the pack,
 * clearing every other torch in the inventory first.
 *
 * The starting kit puts 20 torches in hotbar slot 5 and `giveItem` tops up
 * existing stacks, so "give the player one torch" is not a thing you can say
 * without this. Two beats of this harness scored false bugs purely because a
 * forgotten stack elsewhere in the inventory kept restocking the hand.
 */
const stockTorches = (inHand, spare) => D(([h, sp]) => {
  const g = window.__gameDebug;
  const inv = g.inventory();
  for (const arr of [inv.pack, inv.hotbar]) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== null && arr[i].id === 'torch') arr[i] = null;
    }
  }
  g.equipItem('torch', h);
  if (sp > 0) {
    const idx = inv.pack.findIndex((x) => x === null);
    if (idx >= 0) inv.pack[idx] = { id: 'torch', count: sp };
  }
  return g.torchState();
}, [inHand, spare]);

const shot = async (name) => {
  const buf = await page.screenshot();
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  return buf;
};

/**
 * Render the same scene with and without a lit torch and report the pixel
 * difference. The "off" case swaps to a stick rather than dropping the torch
 * so the hand is not empty (an empty hand changes the mesh, not the light).
 */
async function lightDelta(tag) {
  await revive(tag);
  await D(() => { window.__gameDebug.equipItem('sticks'); });
  await page.waitForTimeout(500);
  const off = await shot(`${tag}-off`);
  await revive(tag);
  await D(() => {
    window.__gameDebug.equipItem('torch', 20);
    window.__gameDebug.setTorchFuel(160);
  });
  await page.waitForTimeout(500);
  const on = await shot(`${tag}-on`);
  const [a, b] = await Promise.all([meanLuma(off), meanLuma(on)]);
  return { off: a, on: b, gain: b / Math.max(a, 0.01) };
}

// ---------------------------------------------------------------------------
log('\n== 1. the torch lights the world at night ==');
await D(() => {
  window.__gameDebug.teleport(244, -304);
  window.__gameDebug.giveItem('torch', 20);
  window.__gameDebug.giveItem('sticks', 5);
  window.__gameDebug.setCamera(0.6, -0.05, 6);
});
await page.waitForTimeout(1200);

{
  const d = await lightDelta('1-night');
  check('a lit torch measurably brightens a night scene',
    d.on > d.off * 1.12,
    `mean luma ${d.off.toFixed(2)} unlit -> ${d.on.toFixed(2)} lit (x${d.gain.toFixed(2)})`);

  const st = await D(() => window.__gameDebug.torchState());
  const lights = await D(() => window.__gameDebug.worldLights());
  const near = st.flame === null ? null : lights.find((l) => {
    const dx = l.pos[0] - st.flame[0], dy = l.pos[1] - st.flame[1], dz = l.pos[2] - st.flame[2];
    return dx * dx + dy * dy + dz * dz < 0.25 * 0.25;
  });
  check('the world-light set carries a light at the flame',
    near !== undefined && near !== null,
    st.flame === null ? 'no flame anchor'
      : `flame [${st.flame.map((v) => v.toFixed(2)).join(', ')}], ${lights.length} lights uploaded`);

  const pos = await D(() => window.__gameDebug.playerPos());
  check('the flame is at the hand, not at the feet or inside the head',
    st.flame !== null
      && st.flame[1] - pos[1] > 1.4 && st.flame[1] - pos[1] < 2.0
      && Math.hypot(st.flame[0] - pos[0], st.flame[2] - pos[2]) > 0.3,
    st.flame === null ? 'null'
      : `${(st.flame[1] - pos[1]).toFixed(2)} m up, `
        + `${Math.hypot(st.flame[0] - pos[0], st.flame[2] - pos[2]).toFixed(2)} m out`);
}
await bootOk('night lighting');

// ---------------------------------------------------------------------------
log('\n== 2. the torch lights a dungeon ==');
await D(() => { window.__gameDebug.enterNearestDungeon(); });
await page.waitForTimeout(2500);
{
  const inside = await D(() => window.__gameDebug.nearestDungeonName());
  const d = await lightDelta('2-dungeon');
  check('a lit torch measurably brightens a dungeon corridor',
    d.on > d.off * 1.12,
    `${inside ?? '?'}: mean luma ${d.off.toFixed(2)} -> ${d.on.toFixed(2)} (x${d.gain.toFixed(2)})`);
}
await bootOk('dungeon lighting');
await D(() => { window.__gameDebug.teleportToExitPortal(); });
await page.waitForTimeout(600);
await page.keyboard.press('KeyE');
await page.waitForTimeout(1800);

// ---------------------------------------------------------------------------
log('\n== 3. the torch lights the castle undercroft ==');
{
  const markers = await D(() => window.__gameDebug.castleMarkers());
  // Prefer an interior marker; the undercroft is the darkest place the castle
  // has and it renders on the OUTDOOR path, so it is the hardest case.
  const want = ['undercroft', 'cellar', 'keepGround', 'hall', 'keep']
    .find((m) => markers.includes(m)) ?? markers[0];
  await D((m) => {
    window.__gameDebug.castleTeleport(m);
    // The garrison and the boss will happily kill the subject of the
    // experiment; a dead player dims the frame to near black and would be
    // scored as "the torch lights nothing".
    window.__gameDebug.castleSetAlarm('dormant');
  }, want);
  await page.waitForTimeout(1600);
  await revive('castle lighting');
  await D(() => { window.__gameDebug.setCamera(0.0, 0.0, 5); });
  await page.waitForTimeout(400);
  const d = await lightDelta('3-castle');
  check('a lit torch measurably brightens the castle interior',
    d.on > d.off * 1.06,
    `marker "${want}": mean luma ${d.off.toFixed(2)} -> ${d.on.toFixed(2)} (x${d.gain.toFixed(2)})`);
}
await bootOk('castle lighting');

// ---------------------------------------------------------------------------
log('\n== 4. burn rate, auto-relight and stack depletion ==');
await D(() => {
  window.__gameDebug.teleport(244, -304);
  // A stack, not the default 1: `equipItem` puts ONE of the item in the slot,
  // so a relight test that skips the count is really testing the last torch.
  // That is how the first run of this harness scored three false bugs.
  window.__gameDebug.equipItem('torch', 6);
});
await page.waitForTimeout(1200);
await revive('burn rate');
{
  const before = await D(() => {
    window.__gameDebug.setTorchFuel(120);
    return window.__gameDebug.torchState();
  });
  const t0 = Date.now();
  await page.waitForTimeout(4000);
  const after = await D(() => window.__gameDebug.torchState());
  const wall = (Date.now() - t0) / 1000;
  const burned = before.fuelS - after.fuelS;
  check('fuel drains at about one second per second while held',
    burned > wall * 0.75 && burned < wall * 1.25,
    `${burned.toFixed(2)} s of fuel over ${wall.toFixed(2)} s wall`);
  check('the declared burn time is the one being used',
    Math.abs(after.burnS - 180) < 0.001, `TORCH_BURN_S = ${after.burnS}`);

  const n0 = after.count;
  await D(() => { window.__gameDebug.setTorchFuel(1.0); });
  await page.waitForTimeout(2500);
  const relit = await D(() => window.__gameDebug.torchState());
  check('a spent torch is replaced from the stack',
    relit.count === n0 - 1 && relit.lit && relit.fuelS > relit.burnS * 0.9,
    `${n0} -> ${relit.count} in hand, next one at ${relit.fuelS.toFixed(1)}/${relit.burnS} s`);
}
await bootOk('burn rate');

// ---------------------------------------------------------------------------
log('\n== 5. fuel does not burn while paused ==');
{
  await D(() => {
    window.__gameDebug.equipItem('torch', 6);
    window.__gameDebug.setTorchFuel(90);
  });
  await page.waitForTimeout(300);
  const before = await D(() => {
    window.__gameDebug.setPaused(true);
    return window.__gameDebug.torchState();
  });
  await page.waitForTimeout(3500);
  const during = await D(() => window.__gameDebug.torchState());
  await D(() => { window.__gameDebug.setPaused(false); });
  await page.waitForTimeout(2500);
  const after = await D(() => window.__gameDebug.torchState());
  check('a paused game burns no fuel',
    Math.abs(during.fuelS - before.fuelS) < 0.1,
    `${before.fuelS.toFixed(3)} -> ${during.fuelS.toFixed(3)} s over 3.5 s paused`);
  check('and it starts burning again on resume',
    before.fuelS - after.fuelS > 1.5,
    `${during.fuelS.toFixed(2)} -> ${after.fuelS.toFixed(2)} s over 2.5 s live`);
}
await bootOk('pause');

// ---------------------------------------------------------------------------
log('\n== 6. a torch keeps you warm ==');
{
  // Cold: a snow biome at deep night. Warmth is the max-not-sum model, so the
  // measurement only means anything with armour off and no fire near.
  const cold = await D(() => {
    window.__gameDebug.setArmor({ head: null, body: null, legs: null });
    return null;
  }).catch(() => null);
  void cold;
  // Find real snow rather than trusting a hard-coded spot.
  const spot = await D(() => {
    const g = window.__gameDebug;
    for (let r = 400; r <= 2400; r += 200) {
      for (let a = 0; a < 12; a++) {
        const x = Math.cos((a / 12) * Math.PI * 2) * r;
        const z = Math.sin((a / 12) * Math.PI * 2) * r;
        if (g.heightAt(x, z) > 46) return [x, z, g.heightAt(x, z)];
      }
    }
    return null;
  });
  if (spot === null) {
    check('found somewhere cold to test warmth in', false, 'no high ground within 2.4 km');
  } else {
    await D(([x, z]) => { window.__gameDebug.teleport(x, z); }, spot);
    await page.waitForTimeout(1500);
    await D(() => { window.__gameDebug.equipItem('sticks'); });
    await page.waitForTimeout(1200);
    const tOff = (await D(() => window.__gameDebug.vitals())).temperature;
    await D(() => {
      window.__gameDebug.equipItem('torch', 20);
      window.__gameDebug.setTorchFuel(160);
    });
    await page.waitForTimeout(1200);
    const tOn = (await D(() => window.__gameDebug.vitals())).temperature;
    check('holding a lit torch raises body temperature in the cold',
      tOn > tOff + 0.05,
      `${tOff.toFixed(3)} -> ${tOn.toFixed(3)} at altitude ${spot[2].toFixed(0)} m, night`);

    // ...and the warmth has to STOP when the light does. The old code warmed
    // you for merely having the item selected, fuel or no fuel. Note there is
    // no "unlit stub in hand" state to test: burning out with anything left
    // lights the next one, so the only way to lose the warmth is to run out
    // altogether — in hand AND in the pack.
    await stockTorches(1, 0);
    await D(() => { window.__gameDebug.setTorchFuel(0.3); });
    await page.waitForTimeout(2000);
    const outState = await D(() => window.__gameDebug.torchState());
    const tDead = (await D(() => window.__gameDebug.vitals())).temperature;
    check('and the warmth stops when the last torch does',
      !outState.lit && Math.abs(tDead - tOff) < 0.05,
      `lit ${outState.lit}: ${tDead.toFixed(3)} vs ${tOff.toFixed(3)} unlit-hand baseline`);
  }
}
await bootOk('warmth');

// ---------------------------------------------------------------------------
log('\n== 7. the last torch ==');
{
  // One in hand, ten in the pack. The pack MUST save you: "the next torch
  // lights" has to mean the next torch you own, or a player goes dark with a
  // bag full of them and reads it as a bug rather than as inventory
  // management.
  const start = await stockTorches(1, 10);
  await D(() => { window.__gameDebug.setTorchFuel(0.4); });
  await page.waitForTimeout(1500);
  const st = await D(() => window.__gameDebug.torchState());
  check('an empty slot restocks from the pack rather than going dark',
    st.lit && st.count > 0 && st.spare < start.spare,
    `${start.count} in hand + ${start.spare} spare -> ${st.count} in hand + `
      + `${st.spare} spare, lit ${st.lit}`);

  // Now the genuine last one, with nothing anywhere to fall back on.
  await stockTorches(1, 0);
  await D(() => { window.__gameDebug.setTorchFuel(0.4); });
  await page.waitForTimeout(1500);
  const dead = await D(() => window.__gameDebug.torchState());
  check('burning the genuine last torch leaves you with nothing lit',
    dead.count === 0 && !dead.lit && dead.flame === null,
    `count ${dead.count}, spare ${dead.spare}, lit ${dead.lit}, `
      + `flame ${dead.flame === null ? 'null' : 'still set'}`);
  // The bar fades over 0.18 s; reading opacity immediately catches it mid-way.
  await page.waitForTimeout(500);
  const barHidden = await page.evaluate(() => {
    const el = document.querySelector('#torch-bar');
    return el === null ? 'missing' : getComputedStyle(el).opacity;
  });
  check('and the burn bar goes away with it',
    barHidden === '0', `#torch-bar opacity ${barHidden}`);
}
await bootOk('last torch');

// ---------------------------------------------------------------------------
log('\n== 8. frame cost ==');
{
  await D(() => {
    window.__gameDebug.teleport(244, -304);
    window.__gameDebug.giveItem('torch', 20);
    window.__gameDebug.equipItem('sticks');
  });
  await page.waitForTimeout(1500);
  const sample = async () => page.evaluate(async () => {
    const t = [];
    let last = performance.now();
    await new Promise((res) => {
      let n = 0;
      const step = () => {
        const now = performance.now();
        t.push(now - last);
        last = now;
        if (++n < 150) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
    t.sort((a, b) => a - b);
    return { mean: t.reduce((a, b) => a + b, 0) / t.length, p95: t[Math.floor(t.length * 0.95)] };
  });
  const off = await sample();
  await D(() => {
    window.__gameDebug.equipItem('torch');
    window.__gameDebug.setTorchFuel(160);
  });
  await page.waitForTimeout(800);
  const on = await sample();
  log(`  frame ms  no torch: mean ${off.mean.toFixed(2)} p95 ${off.p95.toFixed(2)}`);
  log(`  frame ms  torch:    mean ${on.mean.toFixed(2)} p95 ${on.p95.toFixed(2)}`);
  check('a held torch does not cost a measurable slice of the frame budget',
    on.mean < off.mean + 1.2,
    `+${(on.mean - off.mean).toFixed(2)} ms mean`);
}
await bootOk('frame cost');

log(`\n${bugs.length === 0 ? 'ALL CLEAR' : `${bugs.length} BUG(S)`}`);
for (const b of bugs) log(`  - ${b}`);
log(`shots in ${OUT}`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
