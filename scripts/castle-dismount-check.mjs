/**
 * Dismount coverage on multi-storey geometry.
 *
 *   node scripts/castle-dismount-check.mjs
 *
 * WHY THIS EXISTS. "Hopping off of mounts falls you through the floor now."
 * Every dismount test in the repo ran on open terrain, where there is exactly
 * one ground plane and `groundHeight(x, z, r)` cannot be wrong about which
 * storey it means. `scripts/mount-air-check.mjs` teleports to open wilderness
 * before it starts, so it reported 0 bugs throughout — it is structurally
 * incapable of catching this and its passing is not evidence here.
 *
 * The castle is the only place in the game with floors above floors, so it is
 * the only place the bug is reachable: `CastleCollider` resolves the storey
 * from `probeY()`, which castle-manager binds to the player's live `pos[1]`,
 * and during a dismount that is still SADDLE height. On a big mount the query
 * therefore asked about a body 4-5 m above the floor — over the parapet, over
 * the merlons — so those sides read as free and the rider was posted off the
 * edge.
 *
 * A previous attempt at this probe reported "mounted=false" on every storey
 * and was nearly filed as a pass: `spawnEntity` snaps the animal to terrain
 * height, which under the keep is the motte hillside ~28 m below the floor, so
 * there was never a mount to get off. `__gameDebug.placeEntity` exists for
 * this reason. If `mounted` is false the storey is reported as NO MOUNT, never
 * as ok.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

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

await page.goto('http://localhost:5173/game.html?director=off&tod=0.45&weather=clear',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__probeBoot = (window.__probeBoot ?? 0) + 1; });

/** A parallel agent hot-reloading the page has silently corrupted runs here. */
const bootOk = async (phase) => {
  const v = await page.evaluate(() => window.__probeBoot ?? null);
  if (v !== 1) {
    process.stdout.write(`\n!! RUN INVALID — page reloaded during "${phase}" (boot=${v})\n`);
    await browser.close();
    process.exit(2);
  }
};

/**
 * Every game call goes through here so a hot reload is an INVALID RUN rather
 * than a stack trace half way down the results — or, worse, a partial result
 * that reads like a pass. A castle filmstrip in this repo was once filed as a
 * success with every frame at the spawn point for exactly this reason.
 */
const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

const markers = await D(() => window.__gameDebug.castleMarkers());
// Every marker that is a place you could plausibly be sitting on an animal.
const storeys = markers.filter((m) => /hall|throne|arena|court|roof|gate|undercroft|ward|bailey/i.test(m));
process.stdout.write(`\ncastle markers: ${storeys.join(', ')}\n`);

/**
 * Ride and step off at one marker, on one species.
 *
 * The mount is PLACED at the player's own feet height, not spawned, so it
 * stands on the storey rather than in the motte 28 m below.
 */
async function trial(marker, species) {
  // Keep the castle asleep AND the rider alive. Both matter because DEATH
  // AUTO-DISMOUNTS, so anything that kills the player looks from here like a
  // mount that would not hold. The wild dragon this probe places is
  // `aggro: true` and mauls the player between trials: after four dragon
  // storeys the vitals dump read `hp: 0, deathCause: "animal"`, and the seven
  // storeys after it were reported as collision bugs for two hours.
  await D(() => window.__gameDebug.castleSetAlarm('dormant'));
  await D(() => window.__gameDebug.healPlayer());
  if (!await D((m) => window.__gameDebug.castleTeleport(m), marker)) return null;
  // `castleTeleport` drops the player 0.4 m above the marker and lets gravity
  // seat them. 900 ms was enough in the halls and not in the courtyards, where
  // more geometry is streaming — so the probe placed the mount 0.4 m off the
  // floor and the trial came apart later for reasons that looked like a game
  // bug. Wait for the fall to finish rather than for a fixed time.
  await page.waitForTimeout(600);
  for (let i = 0; i < 30; i++) {
    const m = await D(() => ({
      y: window.__gameDebug.playerPos()[1],
      g: window.__gameDebug.playerMotion().grounded,
      v: window.__gameDebug.playerMotion().velY,
    }));
    if (m.g && Math.abs(m.v) < 0.01) break;
    await page.waitForTimeout(100);
  }
  // Settle, then take the floor height the player is actually standing on.
  const before = await D(() => ({
    pos: window.__gameDebug.playerPos(),
    grounded: window.__gameDebug.playerMotion().grounded,
  }));
  if (!before.grounded) return { marker, species, skipped: 'player not grounded after teleport' };

  // Place AND mount in one evaluate: no frame runs between them, so the
  // animal never gets an AI tick to flee with. Measured, a horse left alone
  // for 500 ms after placement was 14 m away and a storey lower, and the run
  // was then measuring "the horse ran off the roof", not the dismount.
  const placed = await D(([sp, p]) => {
    const eid = window.__gameDebug.placeEntity(sp, p[0] + 1.6, p[1], p[2]);
    if (eid === null) return { id: null, why: 'placeEntity returned null' };
    const ok = window.__gameDebug.mountEntity(eid);
    const e = window.__gameDebug.entities().find((k) => k.id === eid);
    return {
      id: ok ? eid : null,
      why: ok ? '' : `mountEntity false; entity=${e ? `${e.species}/${e.mode}` : 'MISSING'}`
        + `, count=${window.__gameDebug.entities().length}`,
      strayId: eid,
    };
  }, [species, before.pos]);
  const id = placed.id;
  if (id === null) {
    if (placed.strayId) await D((i) => window.__gameDebug.removeEntity(i), placed.strayId);
    return { marker, species, noMount: true, why: placed.why, floor: before.pos[1] };
  }
  await page.waitForTimeout(250);
  let mountedId = await D(() => window.__gameDebug.mounted());
  if (mountedId === null) {
    // One retry. The subject is `doDisMount`; a mount that did not take is a
    // harness problem and must not be silently reported as a passing storey.
    await D((i) => window.__gameDebug.mountEntity(i), id);
    await page.waitForTimeout(250);
    mountedId = await D(() => window.__gameDebug.mounted());
  }
  if (mountedId === null) {
    await D((i) => window.__gameDebug.removeEntity(i), id);
    return {
      marker, species, noMount: true, floor: before.pos[1],
      why: 'mount did not hold for 250 ms, twice; vitals='
        + JSON.stringify(await D(() => window.__gameDebug.vitals())),
    };
  }
  // The floor the ANIMAL is standing on when the rider steps off is the
  // reference — not where the player teleported in, which the mount may have
  // drifted from.
  const mount = await D((i) => {
    const e = window.__gameDebug.entities().find((x) => x.id === i);
    return e ? { x: e.x, y: e.y, z: e.z } : null;
  }, id);

  // NOT KeyE: inside the castle that loots the escape chest instead (the
  // interact prompt outranks dismounting in the priority chain), which raises
  // the alarm and gets the rider shot by the garrison. Call the function under
  // test.
  await D(() => window.__gameDebug.dismount());
  await page.waitForTimeout(300);
  const immediate = await D(() => ({
    pos: window.__gameDebug.playerPos(),
    m: window.__gameDebug.playerMotion(),
  }));
  // Let gravity have its say — the reported failure is falling THROUGH, which
  // takes a moment, not being placed wrong on frame one.
  await page.waitForTimeout(2500);
  const settled = await D(() => ({
    pos: window.__gameDebug.playerPos(),
    m: window.__gameDebug.playerMotion(),
  }));
  await D((i) => window.__gameDebug.removeEntity(i), id);
  await page.waitForTimeout(200);

  const floor = mount === null ? before.pos[1] : mount.y;
  return {
    marker, species,
    floor,
    immediateY: immediate.pos[1],
    settledY: settled.pos[1],
    grounded: settled.m.grounded,
    drop: floor - settled.pos[1],
    horiz: mount === null ? 0
      : Math.hypot(settled.pos[0] - mount.x, settled.pos[2] - mount.z),
  };
}

/** A dismount may step down, but never off the building. */
const DROP_TOLERANCE = 3.0;

for (const species of ['horse', 'dragon']) {
  process.stdout.write(`\n=== dismounting a ${species} on each storey ===\n`);
  for (const marker of storeys) {
    const r = await trial(marker, species);
    if (r === null) { note('ok', `${marker}: no such marker`, ''); continue; }
    if (r.skipped) { note('ok', `${marker}: skipped`, r.skipped); continue; }
    if (r.noMount) {
      note('BUG', `${marker} / ${species}: never mounted`,
        `floor y=${r.floor.toFixed(1)} — ${r.why ?? 'unknown'}; storey UNTESTED`);
      continue;
    }
    const label = `${marker} / ${species}`;
    const detail = `floor y=${r.floor.toFixed(1)} -> off at ${r.immediateY.toFixed(1)}`
      + ` -> settled ${r.settledY.toFixed(1)} (drop ${r.drop.toFixed(1)} m,`
      + ` moved ${r.horiz.toFixed(1)} m, grounded=${r.grounded})`;
    if (r.drop > DROP_TOLERANCE) note('BUG', `${label}: fell off the storey`, detail);
    else if (!r.grounded) note('BUG', `${label}: still falling`, detail);
    else note('ok', label, detail);
  }
  await bootOk(`dismount ${species}`);
}

process.stdout.write('\n=== summary ===\n');
const bugs = findings.filter((f) => f.severity === 'BUG');
for (const e of errors.slice(0, 6)) process.stdout.write(`  page error: ${e}\n`);
process.stdout.write(`${bugs.length} bugs across ${findings.length} checks\n`);
for (const b of bugs) process.stdout.write(`  - ${b.title}: ${b.detail}\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
