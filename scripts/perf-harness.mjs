/**
 * Frame-time harness — the instrument behind the "exceedingly laggy" report.
 *
 *   node scripts/perf-harness.mjs [--base http://127.0.0.1:5173] [--out file.json]
 *                                 [--scenarios boot,teleport,walk,settlement,dungeon,equip]
 *                                 [--profile] [--llm] [--rounds N]
 *
 * Drives the real game in headless Chrome through the same `window.__gameDebug`
 * hooks the other harnesses use, and records every requestAnimationFrame delta
 * from document start — so boot is measured, not just play. Each scenario is a
 * window over that stream and reports frame-time p50/p95/p99, the worst frame,
 * the count of frames over 33 ms and over 100 ms, the hitch budget (ms spent
 * above 16.7 ms in frames over 33 ms) and PerformanceObserver long tasks.
 *
 * Scenarios, in order:
 *   boot        navigation -> first playable frame, then the first 8 s of play
 *               (`--profile-boot` CPU-profiles the boot itself)
 *   teleport    four cold jumps across the map (chunk/resource/settlement
 *               streaming from nothing), 6 s each
 *   walk        a sprint across chunk borders in warmed terrain, 20 s
 *   settlement  arrive at a village, a castle gate, then step into a building
 *   dungeon     enter the nearest dungeon, then leave it
 *   equip       hotbar cycling through six held items, armor swaps, shield on
 *               and off, inventory panel open/close
 *
 * `--profile` wraps every scenario in a CDP CPU profile and prints the top
 * self-time functions, which is what turns a hitch count into a file:line.
 * `--llm` leaves the Director and NPC model on (default is `?director=off`, so
 * rendering and streaming are measured without the GPU being shared).
 * `--uncapped` turns vsync and the frame-rate limit off so a frame's delta is
 * its real cost rather than 16.7 ms; `--viewport 2560x1440` sets the canvas.
 *
 * Numbers, not impressions. Machine noise is real: compare medians across
 * `--rounds`, and treat a single-run difference under ~20 % as nothing.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : (args[i + 1] ?? def);
};
const flag = (name) => args.includes(`--${name}`);

const BASE = opt('base', 'http://127.0.0.1:5173');
const OUT = opt('out', null);
const SCENARIOS = opt('scenarios', 'boot,teleport,walk,settlement,dungeon,equip').split(',');
const PROFILE = flag('profile');
const LLM = flag('llm');
const ROUNDS = Number(opt('rounds', '1'));
const HEADED = flag('headed');
/** Uncapped: rAF runs as fast as the frame allows, so the delta IS the cost. */
const UNCAPPED = flag('uncapped');
const [VW, VH] = opt('viewport', '1280x720').split('x').map(Number);
const PROFILE_BOOT = flag('profile-boot');

const browser = await chromium.launch({
  channel: 'chrome', headless: !HEADED,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11',
    '--autoplay-policy=no-user-gesture-required',
    ...(UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])],
});

/** Stats over a list of frame deltas (ms). */
function stats(deltas) {
  if (deltas.length === 0) return null;
  const v = [...deltas].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  let hitchMs = 0;
  for (const d of v) if (d > 33) hitchMs += d - 16.7;
  return {
    n: v.length,
    p50: q(0.5), p95: q(0.95), p99: q(0.99), max: v[v.length - 1],
    over33: v.filter((d) => d > 33).length,
    over100: v.filter((d) => d > 100).length,
    hitchMs,
  };
}

const fmt = (s, longtasks, label) => {
  if (s === null) return `${label.padEnd(26)} (no frames)`;
  const lt = longtasks ?? { n: 0, ms: 0 };
  return `${label.padEnd(26)} n ${String(s.n).padStart(5)}  p50 ${s.p50.toFixed(1).padStart(6)}`
    + `  p95 ${s.p95.toFixed(1).padStart(6)}  p99 ${s.p99.toFixed(1).padStart(6)}`
    + `  max ${s.max.toFixed(0).padStart(5)}  >33 ${String(s.over33).padStart(4)}`
    + `  >100 ${String(s.over100).padStart(3)}  hitch ${s.hitchMs.toFixed(0).padStart(5)} ms`
    + `  longtasks ${String(lt.n).padStart(3)} / ${lt.ms.toFixed(0).padStart(5)} ms`;
};

const frameKey = (cf) => {
  const file = cf.url ? cf.url.replace(/^.*\/(src|node_modules)\//, '$1/').split('?')[0] : '';
  return `${cf.functionName || '(anon)'}  ${file}:${cf.lineNumber + 1}`;
};

/**
 * Collapse a CDP CPU profile into top self-time functions. `busy` is the
 * sampled time that was not idle — divided by the frame count it is the
 * main-thread cost per frame, which is what says whether a scene is CPU- or
 * GPU-bound when the uncapped frame delta is read next to it.
 */
function topSelf(profile, limit = 18) {
  const { nodes, samples, timeDeltas } = profile;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  let busy = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]);
    const dt = (timeDeltas[i] ?? 0) / 1000;
    total += dt;
    const cf = n.callFrame;
    if (cf.functionName === '(idle)') continue;
    busy += dt;
    const key = frameKey(cf);
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  return { total, busy, rows };
}

/**
 * What ran during one long frame: the profile's samples whose timestamps fall
 * inside [start, end] (page clock, ms), grouped by their TOP-OF-STACK frame
 * and by the nearest game-level caller (first stack frame under src/game),
 * so a hitch reads as "chunk-manager.loadChunk: 31 ms" rather than as a
 * spread of noise() leaves. `offsetMs` maps the profiler clock to the page's.
 */
function duringFrame(profile, offsetMs, start, end) {
  const { nodes, samples, timeDeltas, startTime } = profile;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const n of nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const leaf = new Map();
  const owner = new Map();
  let t = startTime / 1000 + offsetMs;
  let covered = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = (timeDeltas[i] ?? 0) / 1000;
    t += dt;
    if (t < start || t > end) continue;
    const n = byId.get(samples[i]);
    if (n.callFrame.functionName === '(idle)') continue;
    covered += dt;
    const k = frameKey(n.callFrame);
    leaf.set(k, (leaf.get(k) ?? 0) + dt);
    // Walk up to the first frame that lives in src/game and is not a
    // mesh-utils / math leaf — the thing a reader would recognise.
    let id = n.id;
    let o = null;
    while (id !== undefined) {
      const cf = byId.get(id).callFrame;
      if (cf.url && /\/src\/game\//.test(cf.url)
          && !/mesh-utils|\/math\.ts|noise\.ts|creature-parts/.test(cf.url)) {
        o = frameKey(cf);
        break;
      }
      id = parentOf.get(id);
    }
    o ??= '(outside src/game) ' + k;
    owner.set(o, (owner.get(o) ?? 0) + dt);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { covered, leaf: top(leaf), owner: top(owner) };
}

const results = {
  base: BASE, llm: LLM, uncapped: UNCAPPED, viewport: [VW, VH], rounds: [],
  startedAt: new Date().toISOString(),
};

for (let round = 0; round < ROUNDS; round++) {
  const context = await browser.newContext({ viewport: { width: VW, height: VH } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) {
      errors.push(`CONSOLE ${t.slice(0, 200)}`);
    }
  });
  // Other sessions edit this repo live; a Vite reload mid-run would restart
  // the world under the measurement. Swallow HMR.
  await page.routeWebSocket(/^wss?:\/\/[^/]+\/(\?.*)?$/, () => { /* swallow HMR */ });

  // The recorder runs from document start so boot is in the stream too.
  await page.addInitScript(() => {
    const frames = [];       // [t, dt]
    const longtasks = [];    // [start, dur]
    let last = -1;
    const tick = (t) => {
      if (last >= 0) frames.push(t, t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longtasks.push(e.startTime, e.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* no longtask support */ }
    window.__perf = {
      now: () => performance.now(),
      /** Frame deltas + long tasks whose timestamps fall in [t0, t1]. */
      window: (t0, t1) => {
        const deltas = [];
        const long = []; // [end, dt] of every frame over 25 ms
        for (let i = 0; i < frames.length; i += 2) {
          if (frames[i] >= t0 && frames[i] <= t1) {
            deltas.push(frames[i + 1]);
            if (frames[i + 1] > 25) long.push([frames[i], frames[i + 1]]);
          }
        }
        const lt = [];
        for (let i = 0; i < longtasks.length; i += 2) {
          const s = longtasks[i];
          const d = longtasks[i + 1];
          if (s + d >= t0 && s <= t1) lt.push([s, d]);
        }
        return { deltas, long, longtasks: lt };
      },
    };
  });

  const round_ = { scenarios: {}, errors };
  results.rounds.push(round_);

  /** Run `body` while recording; returns the window's stats. */
  async function scenario(name, body, { profile = PROFILE } = {}) {
    if (profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
      await cdp.send('Profiler.start');
    }
    const t0 = await page.evaluate(() => window.__perf.now());
    const extra = (await body()) ?? {};
    const t1 = await page.evaluate(() => window.__perf.now());
    const w = await page.evaluate(([a, b]) => window.__perf.window(a, b), [t0, t1]);
    const s = stats(w.deltas);
    const lt = { n: w.longtasks.length, ms: w.longtasks.reduce((a, [, d]) => a + d, 0) };
    let prof = null;
    let hitches = [];
    if (profile) {
      const { profile: p } = await cdp.send('Profiler.stop');
      const tStop = await page.evaluate(() => window.__perf.now());
      prof = topSelf(p);
      // Profiler clock -> page clock. Profiler.stop returns right after the
      // last sample, so endTime lines up with "now" to within a few ms.
      const offsetMs = tStop - p.endTime / 1000;
      hitches = w.long.map(([end, dt]) => ({ dt, ...duringFrame(p, offsetMs, end - dt, end) }));
    }
    const gs = await page.evaluate(() => {
      const g = window.__gameStats ?? {};
      return { fps: g.fps, chunks: g.chunkCount, npcs: g.npcCount, entities: g.entityCount };
    }).catch(() => ({}));
    round_.scenarios[name] = { stats: s, longtasks: lt, wallMs: t1 - t0, ...extra, game: gs,
      longFrames: w.deltas.filter((d) => d > 33).map((d) => Math.round(d)),
      profile: prof === null ? null : prof.rows.map(([k, ms]) => [k, Math.round(ms * 10) / 10]) };
    console.log(fmt(s, lt, name));
    if (s !== null && s.over33 > 0) {
      console.log(`    long frames (ms): ${w.deltas.filter((d) => d > 33).map((d) => d.toFixed(0)).join(' ')}`);
    }
    if (prof !== null) {
      const perFrame = s === null ? 0 : prof.busy / s.n;
      console.log(`    main thread busy ${prof.busy.toFixed(0)} / ${prof.total.toFixed(0)} ms`
        + ` = ${perFrame.toFixed(2)} ms per frame; top self-time:`);
      for (const [k, ms] of prof.rows) {
        if (ms < prof.busy * 0.02) break;
        console.log(`      ${ms.toFixed(1).padStart(7)} ms  ${k}`);
      }
      for (const h of hitches) {
        console.log(`    hitch ${h.dt.toFixed(0)} ms (${h.covered.toFixed(0)} ms sampled):`);
        for (const [k, ms] of h.owner) console.log(`        ${ms.toFixed(1).padStart(6)} ms  ${k}`);
      }
      round_.scenarios[name].hitches = hitches;
    }
    return s;
  }

  const D = (fn, arg) => page.evaluate(fn, arg);
  const settle = (ms) => page.waitForTimeout(ms);

  // --- boot ----------------------------------------------------------------
  const url = `${BASE}/game.html?wipe=1&tod=0.45&weather=clear${LLM ? '' : '&director=off'}`;
  const navT0 = Date.now();
  if (PROFILE_BOOT) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
    await cdp.send('Profiler.start');
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 120_000 });
  const readyMs = Date.now() - navT0;
  const marks = await D(() => window.__gameDebug.bootTimings());
  console.log(`\n=== round ${round + 1} === ${VW}x${VH}${UNCAPPED ? ' uncapped' : ' vsync'}${LLM ? ' llm' : ' director=off'}`);
  console.log(`boot: navigation -> first frame ${readyMs} ms`);
  console.log(`  ${marks.map(([n, ms]) => `${n} ${ms}ms`).join(' -> ')}`);
  round_.boot = { readyMs, marks };
  if (PROFILE_BOOT) {
    const { profile: p } = await cdp.send('Profiler.stop');
    const prof = topSelf(p, 30);
    round_.boot.profile = prof.rows.map(([k, ms]) => [k, Math.round(ms * 10) / 10]);
    console.log(`  boot: ${prof.busy.toFixed(0)} ms busy of ${prof.total.toFixed(0)} ms sampled; top self-time:`);
    for (const [k, ms] of prof.rows) {
      if (ms < prof.busy * 0.01) break;
      console.log(`    ${ms.toFixed(1).padStart(7)} ms  ${k}`);
    }
  }
  // Dismiss the overlay the way a player does: a click locks the pointer and
  // the loader gate switches to one slice per frame. Headless has no pointer
  // lock, so the class is toggled directly on failure.
  await page.mouse.click(640, 360).catch(() => {});
  await D(() => { document.getElementById('overlay')?.classList.add('hidden'); });

  if (SCENARIOS.includes('boot')) {
    // Frames from the first playable frame onwards. The recorder has been
    // running since document start, so the window begins at `ready`.
    await scenario('boot:first-8s', async () => { await settle(8000); });
  }

  // --- teleport ------------------------------------------------------------
  if (SCENARIOS.includes('teleport')) {
    const spots = [[820, 790], [-960, 640], [1480, -1210], [330, -1990]];
    for (const [x, z] of spots) {
      await scenario(`teleport:${x},${z}`, async () => {
        await D(([a, b]) => window.__gameDebug.teleport(a, b), [x, z]);
        await settle(6000);
      });
    }
  }

  // --- walk ----------------------------------------------------------------
  if (SCENARIOS.includes('walk')) {
    await D(() => window.__gameDebug.teleport(244, -304));
    await settle(8000); // let streaming finish so this measures border crossings
    await D(() => window.__gameDebug.setCamera(0.7, 0.3, 5.5));
    await scenario('walk:sprint-20s', async () => {
      await page.keyboard.down('ShiftLeft');
      await page.keyboard.down('KeyW');
      await settle(20000);
      await page.keyboard.up('KeyW');
      await page.keyboard.up('ShiftLeft');
      const p = await D(() => window.__gameDebug.playerPos());
      return { endPos: p.map((v) => Math.round(v)) };
    });
  }

  // --- settlement ----------------------------------------------------------
  if (SCENARIOS.includes('settlement')) {
    await scenario('settlement:village', async () => {
      const ok = await D(() => window.__gameDebug.teleportToNearestSettlement('village'));
      await settle(8000);
      return { ok };
    });
    await scenario('settlement:castle', async () => {
      const ok = await D(() => window.__gameDebug.teleportToNearestSettlement('castle'));
      await settle(8000);
      return { ok };
    });
    await scenario('settlement:building', async () => {
      await D(() => window.__gameDebug.teleportToNearestSettlement('village'));
      await settle(4000);
      const ok = await D(() => window.__gameDebug.enterNearestBuilding());
      await settle(3000);
      await page.keyboard.press('KeyE'); // leave
      await settle(3000);
      return { ok };
    });
  }

  // --- dungeon -------------------------------------------------------------
  if (SCENARIOS.includes('dungeon')) {
    await D(() => window.__gameDebug.teleport(244, -304));
    await settle(3000);
    const near = await D(() => window.__gameDebug.teleportToNearestEntrance());
    await settle(4000);
    await scenario('dungeon:enter', async () => {
      const ok = await D(() => window.__gameDebug.enterNearestDungeon());
      await settle(6000);
      return { ok, near };
    });
    await scenario('dungeon:leave', async () => {
      await D(() => window.__gameDebug.teleportToExitPortal());
      await settle(500);
      await page.keyboard.press('KeyE');
      await settle(5000);
      const inside = await D(() => window.__gameStats.insideDungeon);
      return { inside };
    });
  }

  // --- equip ---------------------------------------------------------------
  if (SCENARIOS.includes('equip')) {
    await D(() => window.__gameDebug.teleport(244, -304));
    await settle(5000);
    const kit = ['iron_sword', 'hunter_bow', 'iron_axe', 'torch', 'oak_staff'];
    for (let i = 0; i < kit.length; i++) {
      await page.keyboard.press(`Digit${i + 1}`);
      await D((id) => window.__gameDebug.equipItem(id, id === 'torch' ? 5 : 1), kit[i]);
    }
    await settle(1500);
    await scenario('equip:hotbar-cycle', async () => {
      for (let k = 0; k < 30; k++) {
        await page.keyboard.press(`Digit${(k % 5) + 1}`);
        await settle(330);
      }
    });
    await scenario('equip:armor-swaps', async () => {
      const sets = [
        { head: 'iron_helm', body: 'iron_chest', legs: 'iron_legs' },
        { head: 'leather_cap', body: 'leather_tunic', legs: 'leather_leggings' },
        { head: null, body: null, legs: null },
        { head: 'fiber_hood', body: 'fiber_tunic', legs: 'fiber_leggings' },
      ];
      for (let k = 0; k < 12; k++) {
        await D((s) => window.__gameDebug.setArmor(s), sets[k % sets.length]);
        await settle(500);
      }
    });
    await scenario('equip:shield-toggle', async () => {
      for (let k = 0; k < 10; k++) {
        await D((t) => window.__gameDebug.giveShield(t), k % 2 === 0 ? 'iron' : null);
        await settle(500);
      }
    });
    await scenario('equip:inventory-panel', async () => {
      for (let k = 0; k < 4; k++) {
        await page.keyboard.press('Tab');
        await settle(700);
        await page.keyboard.press('Escape');
        await settle(700);
      }
    });
  }

  if (errors.length > 0) {
    console.log(`page errors (${errors.length}):`);
    for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
  }
  await context.close();
}

await browser.close();

if (OUT !== null) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT}`);
}
