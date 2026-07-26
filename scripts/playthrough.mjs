/**
 * Play-session harness — drives the game with real input and records what a
 * player would actually see.
 *
 *   node scripts/playthrough.mjs <outDir> [sessionFilter]
 *
 * Why this exists: every other check in this repo is programmatic (tests pass,
 * fps is 60, no GPU errors) or a single frame from a frozen camera. All of
 * those reported green while the game was rendering a black screen on the
 * owner's machine. A screenshot of a stationary camera cannot tell you whether
 * a world feels alive, whether you can find anything in it, or whether moving
 * through it reads clearly.
 *
 * So this walks. It presses W, turns the camera while moving, streams chunks,
 * and captures a filmstrip plus a per-frame log of what was actually around —
 * entity counts, interact prompts, biome, weather, vitals. The output is meant
 * to be reviewed the way a player experiences the game: as a sequence, in
 * motion, from angles nobody hand-picked.
 *
 * Keyboard input is not gated on pointer lock (only mousemove is), which is
 * what makes this possible headlessly.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/play';
const filter = process.argv[3] || '';

/**
 * Each session is a scripted route. `beats` run in order; a beat either moves
 * the player, waits, or looks around. The camera pans continuously throughout
 * so no frame is from a pose someone chose to flatter.
 */
const SESSIONS = [
  {
    name: 'wilds',
    q: 'tod=0.42&weather=clear',
    start: [244, -304],
    beats: [
      { hold: 'KeyW', seconds: 6, pan: 55, note: 'walk out across open ground' },
      { hold: 'KeyW', seconds: 6, pan: -80, note: 'keep walking, sweep the camera' },
      { hold: 'KeyW', seconds: 5, pan: 130, shift: true, note: 'sprint' },
      { wait: 3, pan: 200, note: 'stop and look around' },
    ],
  },
  {
    name: 'forest',
    q: 'tod=0.62&weather=clear',
    resource: 'tree',
    beats: [
      { wait: 2, pan: 40, note: 'arrive among trees' },
      { hold: 'KeyW', seconds: 6, pan: 90, note: 'walk through the treeline' },
      { hold: 'KeyA', seconds: 4, pan: 60, note: 'strafe' },
      { wait: 3, pan: 180, note: 'look up and around' },
    ],
  },
  {
    name: 'village',
    q: 'tod=0.55&weather=clear',
    village: true,
    beats: [
      { wait: 2, pan: 30, note: 'arrive at the settlement' },
      { hold: 'KeyW', seconds: 6, pan: 110, note: 'walk in among the buildings' },
      { hold: 'KeyD', seconds: 4, pan: 70, note: 'circle a structure' },
      { wait: 3, pan: 160, note: 'stand and look' },
    ],
  },
  {
    name: 'creatures',
    q: 'tod=0.50&weather=clear',
    start: [244, -304],
    spawn: [['deer', 5, 4], ['wolf', -6, 5], ['cow', 8, -3], ['rabbit', 2, 6],
            ['bird', -4, -5], ['horse', 10, 6]],
    beats: [
      { wait: 3, pan: 90, note: 'creatures idle around the player' },
      { hold: 'KeyW', seconds: 4, pan: 60, note: 'approach them' },
      { wait: 4, pan: 200, note: 'watch them move' },
    ],
  },
  {
    name: 'dusk-storm',
    q: 'tod=0.76&weather=rain',
    start: [-260, 120],
    beats: [
      { wait: 2, pan: 45, note: 'dusk, rain' },
      { hold: 'KeyW', seconds: 7, pan: 120, note: 'walk through weather' },
      { wait: 3, pan: 190, note: 'look around in the storm' },
    ],
  },
  {
    name: 'dungeon',
    q: 'tod=0.5',
    dungeon: true,
    beats: [
      { wait: 2, pan: 60, note: 'inside' },
      { hold: 'KeyW', seconds: 5, pan: 100, note: 'walk the corridor' },
      { wait: 3, pan: 200, note: 'look around the room' },
    ],
  },
];

const SHOT_MS = 900;   // filmstrip interval

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 300)}`);
  }
});

const report = [];

for (const s of SESSIONS) {
  if (filter && !s.name.includes(filter)) continue;
  process.stdout.write(`\n=== ${s.name} ===\n`);
  const dir = path.join(outDir, s.name);
  fs.mkdirSync(dir, { recursive: true });

  await page.goto(`http://localhost:5173/game.html?director=off&${s.q}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined,
    { timeout: 60_000 });
  await page.waitForTimeout(1200);

  // Place the player.
  await page.evaluate(async (cfg) => {
    const d = window.__gameDebug;
    if (cfg.dungeon) d.enterNearestDungeon();
    else if (cfg.village) d.teleportToNearestSettlementSign();
    else if (cfg.resource) d.teleportToNearestResource(cfg.resource);
    else if (cfg.start) d.teleport(cfg.start[0], cfg.start[1]);
    for (const [sp, dx, dz] of cfg.spawn ?? []) d.spawnEntity(sp, dx, dz);
    d.setCamera(0, -0.13, 7);
  }, s);
  await page.waitForTimeout(2500);   // let chunks stream in

  let shot = 0;
  let yaw = 0;
  let reloads = 0;
  const log = [];

  for (const beat of s.beats) {
    const ms = (beat.seconds ?? beat.wait ?? 1) * 1000;
    const steps = Math.max(1, Math.round(ms / SHOT_MS));
    const panStep = ((beat.pan ?? 0) * Math.PI / 180) / steps;

    if (beat.hold) await page.keyboard.down(beat.hold);
    if (beat.shift) await page.keyboard.down('ShiftLeft');

    for (let i = 0; i < steps; i++) {
      await page.waitForTimeout(SHOT_MS);
      yaw += panStep;
      // Guarded: a Vite hot-reload (an agent writing a source file mid-run)
      // wipes window.__gameDebug, and an unguarded call takes the whole
      // session down. Record it instead — a reload mid-capture invalidates
      // the frames either side of it.
      const alive = await page.evaluate((y) => {
        if (!window.__gameDebug || !window.__gameReady) return false;
        window.__gameDebug.setCamera(y, -0.13, 7);
        return true;
      }, yaw);
      if (!alive) {
        reloads++;
        await page.waitForFunction(() => window.__gameReady === true, undefined,
          { timeout: 30_000 }).catch(() => {});
        continue;
      }

      const st = await page.evaluate(() => {
        const g = window.__gameStats ?? {};
        return {
          pos: g.playerPos?.map((v) => Math.round(v * 10) / 10),
          fps: Math.round(g.fps ?? 0),
          entities: g.entityCount, drawn: g.entityDrawn, npcs: g.npcCount,
          prompt: g.interactPrompt, weather: g.weather,
          grass: g.grassInstances, lights: g.worldLightCount,
          inside: g.insideDungeon, err: window.__gameError,
        };
      });
      const name = `${String(shot).padStart(3, '0')}.png`;
      await page.screenshot({ path: path.join(dir, name) });
      log.push({ shot: name, beat: beat.note, ...st });
      shot++;
    }

    if (beat.shift) await page.keyboard.up('ShiftLeft');
    if (beat.hold) await page.keyboard.up(beat.hold);
  }

  const moved = log.length > 1 && log[0].pos && log[log.length - 1].pos
    ? Math.hypot(log[log.length - 1].pos[0] - log[0].pos[0],
                 log[log.length - 1].pos[2] - log[0].pos[2]).toFixed(1)
    : '?';
  // Drop non-positive fps samples before taking the minimum.
  //
  // A missing or zero sample is a MEASUREMENT failure — typically the first
  // frame after a scene load, before the counter has two timestamps to divide.
  // Reporting it as "min fps 0" states, in the same format and with the same
  // confidence as a real number, that the game stalled completely. It did not.
  // That is the single most misleading thing this harness has ever printed.
  const fpsSamples = log.map((l) => l.fps).filter((v) => typeof v === 'number' && v > 0);
  const minFps = fpsSamples.length ? Math.min(...fpsSamples) : null;
  const dropped = log.length - fpsSamples.length;

  // A session where the player never moved measured nothing. WASD is delivered
  // through pointer lock, and when that is not acquired the harness happily
  // films a stationary player and reports an fps figure for a scene it never
  // actually played. Say so instead of publishing the number.
  const invalid = moved === '?' || Number(moved) < 1;

  const notes = [];
  if (invalid) {
    notes.push('!! PLAYER NEVER MOVED — session invalid, fps figure means nothing '
      + '(pointer lock not acquired?)');
  }
  if (dropped > 0) notes.push(`(${dropped} unusable fps sample(s) dropped)`);
  if (reloads > 0) {
    notes.push(`!! ${reloads} hot-reload(s) mid-session — capture is unreliable, `
      + 'nothing should be writing source files during a play run');
  }
  const shown = invalid ? 'n/a' : minFps === null ? 'n/a' : minFps;
  console.log(`  ${log.length} frames, moved ${moved} m, min fps ${shown}`
    + (notes.length ? '  ' + notes.join('  ') : ''));
  fs.writeFileSync(path.join(dir, 'session.json'),
    JSON.stringify(log, null, 1), 'utf-8');
  report.push({ session: s.name, frames: log.length, movedM: moved,
    minFps: invalid ? null : minFps, invalid, droppedSamples: dropped, reloads });
}

await browser.close();

fs.writeFileSync(path.join(outDir, 'report.json'),
  JSON.stringify({ sessions: report, errors }, null, 1), 'utf-8');

console.log('\n--- summary ---');
for (const r of report) {
  console.log(`${r.session.padEnd(12)} ${String(r.frames).padStart(3)} frames  ` +
    `moved ${String(r.movedM).padStart(6)} m  min fps ${
      r.invalid ? 'n/a (INVALID)' : r.minFps === null ? 'n/a' : r.minFps}`);
}
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  errors.slice(0, 8).forEach((e) => console.log('  ' + e));
} else {
  console.log('\nno page errors');
}
