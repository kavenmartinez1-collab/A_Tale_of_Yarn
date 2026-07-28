/**
 * Mount / dismount / air-combat glitch hunt.
 *
 *   node scripts/mount-air-check.mjs [outDir]
 *
 * The user reports that "jumping on and off the wyvern is glitchy" and that
 * riding and air combat glitch. This drives the real game and asserts what a
 * player would notice, rather than what the code intends:
 *
 *   - can you mount a flier that is 30 m over your head?
 *   - where do you end up when you dismount, and is it inside geometry?
 *   - does dismounting mid-air drop you, and do you survive it?
 *   - does mount state leak across repeated mount/dismount cycles?
 *   - does the mount's breath weapon actually damage anything?
 *
 * Every probe reports numbers, because "glitchy" is not a bug report until it
 * is a measurement.
 *
 * NOTE: this repo has had harness runs silently corrupted by a parallel agent
 * hot-reloading the page mid-capture — every frame came out at the spawn point
 * and the beats were filed as real successes. So the boot id is checked after
 * every phase and the run is marked INVALID rather than reported as a result.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/mount-air';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  // The autoplay flag lets the AudioContext run without a user gesture, so
  // the wingbeat-sample counter below counts what would really have sounded.
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
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

// Get clear of the castle first. The opening now spawns the player inside the
// keep, ~25 m above the surrounding terrain — a terrible place to measure mount
// mechanics, and it made an early run read as "mounted a flier 25 m below me"
// when the truth was simply that the player starts high up.
await page.evaluate(() => window.__gameDebug.teleport(244, -304));
await page.waitForTimeout(2500);

// Stamp a boot id so a hot reload mid-run is detectable rather than silent.
await page.evaluate(() => { window.__probeBoot = (window.__probeBoot ?? 0) + 1; });
const bootOk = async (phase) => {
  const v = await page.evaluate(() => window.__probeBoot ?? null);
  if (v !== 1) {
    process.stdout.write(`\n!! RUN INVALID — page reloaded during "${phase}" (boot=${v})\n`);
    await browser.close();
    process.exit(2);
  }
};

const D = (fn) => page.evaluate(fn);

// ---------------------------------------------------------------------------
// 1. Mounting a flier that is directly overhead
// ---------------------------------------------------------------------------
process.stdout.write('\n=== 1. mounting reach ===\n');

await D(() => window.__gameDebug.spawnEntity('wyvern', 2, 0));
await page.waitForTimeout(1200);

let s = await D(() => {
  const d = window.__gameDebug;
  const w = d.entities().find((e) => e.species === 'wyvern');
  return { w, pos: d.playerPos(), mounted: d.mounted() };
});
note('ok', `wyvern spawned at dy=${(s.w.y - s.pos[1]).toFixed(2)} m`, JSON.stringify(s.w).slice(0, 120));

// Lift it well overhead and try to mount from the ground.
await D(() => {
  const d = window.__gameDebug;
  const w = d.entities().find((e) => e.species === 'wyvern');
  window.__probeId = w.id;
  d.setEntityPos?.(w.id, w.x, w.y + 30, w.z);
});
const lifted = await D(() => {
  const w = window.__gameDebug.entities().find((e) => e.id === window.__probeId);
  return w ? w.y : null;
});
if (lifted === null) {
  note('ok', 'no setEntityPos hook — overhead-reach probe skipped');
} else {
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(400);
  const m = await D(() => ({
    mounted: window.__gameDebug.mounted(),
    pos: window.__gameDebug.playerPos(),
    w: window.__gameDebug.entities().find((e) => e.id === window.__probeId),
    probeId: window.__probeId,
  }));
  const window0 = { probeId: m.probeId };
  const dy = m.w ? m.w.y - m.pos[1] : 0;
  // It must be the LIFTED wyvern that got mounted, not just "something".
  //
  // The demo parks a tamed wyvern beside the player in `follow` mode, so it is
  // always within arm's reach — and this probe was reporting "mounted a flier
  // from far below it, player snapped 19.8 m up" every run while the player
  // had in fact mounted the companion standing next to them and the 19.8 m was
  // the distance to a completely different animal.
  const mountedProbe = m.mounted !== null && m.mounted === window0.probeId;
  if (mountedProbe && Math.abs(dy) > 6) {
    note('BUG', 'mounted a flier from far below it',
      `player snapped ${dy.toFixed(1)} m; tryMount has no vertical reach check`);
  } else if (m.mounted !== null && !mountedProbe) {
    note('ok', `overhead mount refused (mounted the companion instead, `
      + `probe was ${dy.toFixed(1)} m away)`);
  } else {
    note('ok', `overhead mount refused (dy ${dy.toFixed(1)} m, mounted=${m.mounted})`);
  }
  if (m.mounted !== null) { await page.keyboard.press('KeyE'); await page.waitForTimeout(300); }
}
await bootOk('mounting reach');

// ---------------------------------------------------------------------------
// 2. Ground mount / dismount cycles — state leaks and placement
// ---------------------------------------------------------------------------
process.stdout.write('\n=== 2. mount/dismount cycles ===\n');

await D(() => {
  const d = window.__gameDebug;
  const p = d.playerPos();
  const w = d.entities().find((e) => e.id === window.__probeId);
  if (w && d.setEntityPos) d.setEntityPos(w.id, p[0] + 2, p[1], p[2]);
});
await page.waitForTimeout(600);

const cycles = [];
for (let i = 0; i < 5; i++) {
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(450);
  const on = await D(() => ({ m: window.__gameDebug.mounted(), p: window.__gameDebug.playerPos() }));
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(450);
  const off = await D(() => ({
    m: window.__gameDebug.mounted(),
    p: window.__gameDebug.playerPos(),
    ground: window.__gameDebug.heightAt(window.__gameDebug.playerPos()[0], window.__gameDebug.playerPos()[2]),
    motion: window.__gameDebug.playerMotion(),
    hp: window.__gameDebug.vitals().hp,
  }));
  cycles.push({ i, mountedOk: on.m !== null, offOk: off.m === null,
    grounded: off.motion.grounded, velY: off.motion.velY, y: off.p[1], hp: off.hp });
}
for (const c of cycles) {
  process.stdout.write(`       cycle ${c.i}: mount=${c.mountedOk} dismount=${c.offOk} ` +
    `grounded=${c.grounded} velY=${c.velY.toFixed(2)} y=${c.y.toFixed(2)} hp=${c.hp}\n`);
}
if (cycles.some((c) => !c.mountedOk)) {
  note('BUG', 'a mount attempt failed mid-cycle', 'state leaks across mount/dismount');
} else if (cycles.some((c) => !c.grounded)) {
  // Judged on the controller's OWN grounded flag. An earlier version of this
  // probe compared against __gameDebug.heightAt, which is the RAW heightfield
  // and ignores the settlement/castle geometry the player is actually standing
  // on — it reported a 5.9 m "float" that was simply a paved street.
  note('BUG', 'dismount leaves the player airborne',
    `grounded=false after ${cycles.filter((c) => !c.grounded).length} of 5 dismounts`);
} else {
  note('ok', '5 mount/dismount cycles clean, player lands on the ground each time');
}
// Control for the background drain before blaming the dismount.
//
// Hunger and thirst take health continuously, so ANY probe that runs for ten
// seconds sees hp fall. This one reported "dismounting on flat ground costs
// health, hp 16.04 -> 14.72" about a 1.32 hp loss that turned out to be
// starvation ticking at the same rate whether the player dismounted or not.
// Measure an idle window of the same length and only report the difference.
const hpLostCycling = cycles[0].hp - cycles[cycles.length - 1].hp;
const hpIdle0 = await D(() => window.__gameDebug.vitals().hp);
await page.waitForTimeout(cycles.length * 900);
const hpIdle1 = await D(() => window.__gameDebug.vitals().hp);
const hpLostIdle = hpIdle0 - hpIdle1;
process.stdout.write(`       hp lost while cycling ${hpLostCycling.toFixed(2)}, `
  + `while idle for the same time ${hpLostIdle.toFixed(2)}
`);
if (hpLostCycling > hpLostIdle + 1.0) {
  note('BUG', 'dismounting on flat ground costs health',
    `${hpLostCycling.toFixed(2)} hp cycling vs ${hpLostIdle.toFixed(2)} idle`);
} else {
  note('ok', `dismount costs no health beyond the background drain `
    + `(${hpLostCycling.toFixed(2)} vs ${hpLostIdle.toFixed(2)} idle)`);
}
await bootOk('cycles');

// ---------------------------------------------------------------------------
// 3. Flight, then a mid-air dismount
// ---------------------------------------------------------------------------
process.stdout.write('\n=== 3. flight + mid-air dismount ===\n');

await D(() => window.__gameDebug.setVitals({ hp: 100, alive: true }));
await page.keyboard.press('KeyE');
await page.waitForTimeout(500);
const mountedNow = await D(() => window.__gameDebug.mounted());

if (mountedNow === null) {
  note('BUG', 'could not remount for the flight test', 'aborting phase 3');
} else {
  // Climb — and count wingbeats while we do. The beat rides the animator's
  // wing clock (EntityRenderer.onWingbeat), so a powered climb must produce a
  // stately few, not a machine-gun: the old walkPhase-keyed trigger fired
  // three times a second the moment the player held a movement key.
  const wb0 = await D(() => window.__gameDebug.sampleEvents('wingbeat_wyvern'));
  await page.keyboard.down('Space');
  await page.waitForTimeout(3500);
  await page.keyboard.up('Space');
  await page.waitForTimeout(300);
  const air = await D(() => {
    const d = window.__gameDebug;
    const p = d.playerPos();
    return { pos: p, ground: d.heightAt(p[0], p[2]), mounted: d.mounted(), hp: d.vitals().hp };
  });
  const alt = air.pos[1] - air.ground;
  const wb1 = await D(() => window.__gameDebug.sampleEvents('wingbeat_wyvern'));
  const beats = wb1 - wb0;
  process.stdout.write(`       wingbeats voiced during 3.8 s of powered climb: ${beats}\n`);
  if (beats < 1) {
    note('BUG', 'a climbing wyvern makes no wing sound',
      `${beats} sample events — trigger, serving path or decode is broken`);
  } else if (beats > 8) {
    note('BUG', 'wingbeat sound machine-guns in flight',
      `${beats} events in 3.8 s against a ~0.6 Hz visible flap`);
  } else {
    note('ok', `wingbeats at a stately cadence (${beats} in 3.8 s)`);
  }
  process.stdout.write(`       altitude after 3.5 s of climb: ${alt.toFixed(1)} m\n`);
  if (alt < 3) {
    note('BUG', 'holding Space on a flier barely climbs', `${alt.toFixed(1)} m in 3.5 s`);
  } else {
    note('ok', `climbed to ${alt.toFixed(1)} m`);
  }
  await page.screenshot({ path: path.join(outDir, '01-airborne.png') });

  // Dismount in mid-air.
  const hpBefore = air.hp;
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(400);
  const justOff = await D(() => {
    const d = window.__gameDebug;
    const p = d.playerPos();
    return { pos: p, ground: d.heightAt(p[0], p[2]), motion: d.playerMotion(), hp: d.vitals().hp };
  });
  process.stdout.write(`       right after dismount: ${(justOff.pos[1] - justOff.ground).toFixed(1)} m up, ` +
    `velY=${justOff.motion.velY.toFixed(1)}, grounded=${justOff.motion.grounded}\n`);

  // Let the fall resolve.
  await page.waitForTimeout(4000);
  const landed = await D(() => {
    const d = window.__gameDebug;
    const p = d.playerPos();
    return { pos: p, ground: d.heightAt(p[0], p[2]), motion: d.playerMotion(),
      hp: d.vitals().hp, alive: d.vitals().alive };
  });
  const restY = landed.pos[1] - landed.ground;
  process.stdout.write(`       4 s later: ${restY.toFixed(2)} m above ground, ` +
    `grounded=${landed.motion.grounded}, hp ${hpBefore} -> ${landed.hp}, alive=${landed.alive}\n`);
  await page.screenshot({ path: path.join(outDir, '02-after-midair-dismount.png') });

  if (!landed.motion.grounded) {
    note('BUG', 'player never lands after a mid-air dismount',
      `grounded=false 4 s later, velY=${landed.motion.velY.toFixed(1)}`);
  } else {
    note('ok', `landed after mid-air dismount (hp ${hpBefore} -> ${landed.hp})`);
  }
  if (landed.hp === hpBefore && alt > 15) {
    note('BUG', 'a fall from altitude costs nothing',
      `dropped ${alt.toFixed(0)} m with no damage — free descent`);
  }
  await bootOk('flight');

  // Where did the wyvern go?
  await page.waitForTimeout(6000);   // give the landing lerp a fair chance
  // Grounded silence: its wings fold (idle FlapAmp 0.30 sits under the 0.4
  // gate), so a settled wyvern must stop beating. One straggler is allowed
  // for a landing flap still in flight when the window opened.
  {
    const g0 = await D(() => window.__gameDebug.sampleEvents('wingbeat_wyvern'));
    await page.waitForTimeout(3000);
    const g1 = await D(() => window.__gameDebug.sampleEvents('wingbeat_wyvern'));
    if (g1 - g0 > 1) {
      note('BUG', 'a grounded wyvern keeps making wingbeat sounds',
        `${g1 - g0} events in 3 s while landed`);
    } else {
      note('ok', `grounded wyvern is silent (${g1 - g0} events in 3 s)`);
    }
  }
  const flier = await D(() => {
    const d = window.__gameDebug;
    const w = d.entities().find((e) => e.id === window.__probeId);
    return w ? { y: w.y, ground: d.heightAt(w.x, w.z), mode: w.mode } : null;
  });
  if (flier !== null) {
    const fa = flier.y - flier.ground;
    process.stdout.write(`       abandoned wyvern: ${fa.toFixed(1)} m up, mode=${flier.mode}\n`);
    if (fa > 12) {
      note('BUG', 'the abandoned flier stays stranded at altitude',
        `${fa.toFixed(1)} m up — unmountable, you cannot get your mount back`);
    } else {
      note('ok', `abandoned flier descending (${fa.toFixed(1)} m up)`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Air combat — does the breath actually hurt anything?
// ---------------------------------------------------------------------------
process.stdout.write('\n=== 4. air combat ===\n');

// Get ON something first, and VERIFY it, before spawning a target.
//
// This used to move the probe wyvern next to the player, press E once and hope.
// A single E can be swallowed by whatever else is in the interact priority
// chain, and the probe then reported "could not set up the air-combat probe"
// with no idea whether the weapon worked. Retry, and confirm through
// `mounted()` rather than through the keystroke.
await D(() => {
  const d = window.__gameDebug;
  d.setVitals({ hp: 100, alive: true, stamina: 100 });
});
for (let attempt = 0; attempt < 6; attempt++) {
  const already = await D(() => window.__gameDebug?.mounted() ?? null);
  if (already !== null) break;
  await D(() => {
    const d = window.__gameDebug;
    const p = d.playerPos();
    // Any mountable flier will do; put the nearest one right beside the player.
    const w = d.entities().find((e) => e.id === window.__probeId)
      ?? d.entities().find((e) => e.species === 'wyvern');
    if (w && d.setEntityPos) d.setEntityPos(w.id, p[0] + 1.6, p[1], p[2]);
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(500);
}
await page.waitForTimeout(300);
// Spawn the target close, and remember WHICH deer it is.
//
// `__gameDebug.spawnEntity(species, dx, dz)` takes an offset FROM THE PLAYER,
// not world coordinates. This passed `(0, 6)` originally — which is actually
// correct — and then picked "the first deer in the list", which found an
// ambient one 15.3 m away, outside a wyvern's 8.4 m reach
// (BREATH_RANGE 20 x reach 0.42). The probe was reporting "breath does no
// damage" about a target the weapon cannot reach by design. Passing world
// coordinates here made it worse: 402 m.
//
// 5 m is comfortably inside the reach, and inside the near-field band that
// used to be a total dead spot regardless of aim.
await D(() => {
  const d = window.__gameDebug;
  const e = d.spawnEntity('deer', 0, -5);
  window.__probeDeer = e && e.id ? e.id : null;
});
await page.waitForTimeout(900);

const combat = await D(() => {
  const d = window.__gameDebug;
  const targets = d.entities().filter((e) =>
    window.__probeDeer ? e.id === window.__probeDeer : e.species === 'deer');
  return { mounted: d.mounted(), targets: targets.map((t) => ({ id: t.id, hp: t.hp })) };
});
process.stdout.write(`       mounted=${combat.mounted !== null}, targets=${combat.targets.length}\n`);

if (combat.mounted !== null && combat.targets.length > 0) {
  // Aim at the target, then hold F.
  await D(() => {
    const d = window.__gameDebug;
    const t = d.entities().find((e) => e.id === window.__probeDeer)
      ?? d.entities().find((e) => e.species === 'deer');
    const p = d.playerPos();
    d.setCamera(Math.atan2(-(t.x - p[0]), -(t.z - p[2])), 0.0, 5);
    window.__probeTarget = { id: t.id, d: Math.hypot(t.x - p[0], t.z - p[2]) };
  });
  const aim = await D(() => window.__probeTarget);
  process.stdout.write(`       target ${aim.d.toFixed(1)} m away, camera aimed at it
`);
  await page.keyboard.down('KeyF');
  const samples = [];
  for (let i = 0; i < 10; i++) {
    // Re-aim AND re-pin the target every sample.
    //
    // A deer flees at 12 m and this probe aimed once: by the time the breath
    // was lit the target had run to 10.8 m XZ / 13.4 m slant, against a wyvern
    // range of 8.4 m, and 23 degrees off the aim axis. The measurement was of
    // a deer outrunning a jet, not of a weapon. Pinning it makes this a test of
    // the WEAPON, which is what the beat claims to be about.
    await D(() => {
      const d = window.__gameDebug;
      const p = d.playerPos();
      const t = d.entities().find((e) => e.id === window.__probeDeer);
      if (!t) return;
      const yaw = d.mounted() !== null
        ? (d.entities().find((e) => e.id === d.mounted()) || {}).yaw || 0 : 0;
      // Four metres straight in front of the mount's own nose.
      const fx = Math.sin(yaw), fz = -Math.cos(yaw);
      const tx = p[0] + fx * 4;
      const tz = p[2] + fz * 4;
      const ty = d.heightAt(tx, tz);
      d.setEntityPos(t.id, tx, ty, tz);
      // AIM AT IT, including the pitch.
      //
      // This held pitch 0.0 — dead level — and then reported that the breath
      // missed a deer four metres ahead and two metres below the mouth. Of
      // course it did: level is not aiming. Positive pitch looks DOWN
      // (`OrbitCamera.forward` is `-sin(pitch)` in y), so the pitch that puts
      // the crosshair on the target is `atan2(eyeY - targetY, horizontal)`.
      const eyeY = p[1] + 0.85;
      const pitch = Math.atan2(eyeY - (ty + 0.6), 4);
      d.setCamera(Math.atan2(-(fx * 4), -(fz * 4)), pitch, 5);
    });
    await page.waitForTimeout(700);
    samples.push(await D(() => {
      const d = window.__gameDebug;
      const t = d.entities().find((e) => e.id === window.__probeDeer)
        ?? d.entities().find((e) => e.species === 'deer');
      const m = d.entities().find((e) => e.id === d.mounted());
      // The cone geometry, so a miss says WHY instead of only "hp unchanged".
      const probe = d.breathProbe ? d.breathProbe() : null;
      const row = probe && t
        ? (probe.targets || []).find((x) => x.id === t.id) : null;
      return { hp: t ? t.hp : null, stamina: m ? m.stamina : null, geom: row };
    }));
  }
  await page.keyboard.up('KeyF');
  const g = samples.map((x) => x.geom).find((x) => x);
  if (g) process.stdout.write(`       cone: ${JSON.stringify(g)}
`);
  await page.screenshot({ path: path.join(outDir, '03-breath.png') });

  process.stdout.write(`       target hp: ${samples.map((x) => x.hp === null ? 'dead' : x.hp.toFixed(0)).join(' -> ')}\n`);
  process.stdout.write(`       mount stamina: ${samples.map((x) => x.stamina === null ? '-' : x.stamina.toFixed(0)).join(' -> ')}\n`);

  const first = samples[0].hp, last = samples[samples.length - 1].hp;
  // A target that reached 0 is the SUCCESS case, and it has to be checked
  // before the "stopped damaging" heuristic — otherwise the tail of a run that
  // killed the deer in the first two seconds is a flat line of zeroes and gets
  // filed as the exhaustion-flicker bug. That is how this probe reported a
  // working weapon as broken while printing `8 -> 2 -> 0 -> 0` directly above
  // the verdict.
  const killed = samples.some((x) => x.hp === 0 || x.hp === null);
  const tail = samples.slice(6).filter((x) => x.hp !== null && x.hp > 0);
  const tailDrop = tail.length >= 2 ? tail[0].hp - tail[tail.length - 1].hp : null;
  if (killed) {
    note('ok', 'breath kills what it is aimed at',
      `target hp ${first} -> 0 in ${samples.findIndex((x) => x.hp === 0 || x.hp === null) + 1} sample(s)`);
  } else if (last !== null && first !== null && last >= first) {
    note('BUG', 'breath does no damage at all', `target hp unchanged at ${first}`);
  } else if (tailDrop === 0) {
    note('BUG', 'breath stops damaging after a few seconds',
      'damage in the first seconds, zero in the last 2.8 s — the exhaustion flicker');
  } else {
    note('ok', `breath damages over the whole hold (${first} -> ${last ?? 'dead'})`);
  }
} else {
  note('BUG', 'could not set up the air-combat probe',
    `mounted=${combat.mounted !== null} targets=${combat.targets.length}`);
}
await bootOk('air combat');

// ---------------------------------------------------------------------------
// Does opening a panel in flight drop you out of the sky?
//
// Reported from play: "I hit I for inventory or tab when flying and I fall
// through the mount". `tickMount` froze the reins while a panel was up with a
// bare `return`, which also skipped the saddle lock at the bottom of the same
// function — so the controller kept integrating gravity with nothing pinning
// the rider back to the seat. On the ground it is invisible. In flight it is a
// death, and no existing check caught it because none of them ever opened a
// panel while mounted.
//
// Measured by OBSERVATION: altitude and mounted-id before and after, over
// several real seconds with the panel actually open.
// ---------------------------------------------------------------------------
process.stdout.write('\n=== panels while airborne ===\n');

const flyUp = async (seconds) => {
  await page.keyboard.down('Space');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(400);
};

const airState = () => page.evaluate(() => ({
  mounted: window.__gameDebug.mounted(),
  alt: window.__gameDebug.mountAltitude(),
  y: window.__gameDebug.playerPos()[1],
  hp: window.__gameDebug.vitals().hp,
  paused: window.__gameDebug.paused(),
}));

// Specifically a DRAGON, not whatever the combat section left us on:
// `__gameDebug.mountAltitude()` returns null for any other species, and an
// altitude of null silently turns every assertion below into a comparison
// against zero. The earlier section leaves the player on a wyvern.
const remounted = await page.evaluate(() => {
  window.__gameDebug.dismount();
  const p = window.__gameDebug.playerPos();
  const id = window.__gameDebug.placeEntity('dragon', p[0] + 3, p[1], p[2] + 3);
  return id !== null && window.__gameDebug.mountEntity(id);
});
await page.waitForTimeout(1200);
await flyUp(4);

const airborne = await airState();
if (!remounted || airborne.mounted === null || (airborne.alt ?? 0) < 8) {
  note('BUG', 'could not get airborne for the panel test',
    `mounted=${airborne.mounted} alt=${airborne.alt}`);
} else {
  note('ok', 'airborne on a flier',
    `alt ${airborne.alt.toFixed(1)} m, player y ${airborne.y.toFixed(1)}, hp ${airborne.hp}`);

  // Each of the three ways the world can stop being played under a rider.
  const cases = [
    ['inventory (I)', async () => { await page.keyboard.press('KeyI'); }],
    ['crafting (B)', async () => { await page.keyboard.press('KeyB'); }],
    ['the pause screen / map (Esc)',
      async () => { await page.evaluate(() => window.__gameDebug.setPaused(true)); }],
  ];
  for (const [label, open] of cases) {
    const before = await airState();
    await open();
    await page.waitForTimeout(600);
    // Read the DOM, not `__gameStats.panelOpen`: that field is only refreshed
    // on the HUD's 500 ms timer, so polling it right after a keypress reports
    // the previous state and turns every case below into "did not open".
    const opened = await page.evaluate(
      () => document.querySelector('.game-panel') !== null);
    await page.waitForTimeout(4000); // several real seconds with it open
    const during = await airState();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    const after = await airState();

    if (!opened) {
      note('BUG', `${label} did not open`, 'the case below proves nothing');
      continue;
    }
    // Assert on the PLAYER's height, not the mount's.
    //
    // `mountAltitude()` is the dragon's height above terrain, and the dragon is
    // exactly what does NOT move in this bug — the rider slides off it. The
    // first version of this check asserted that number, printed "still at
    // altitude, alt 24.8 -> 24.8 m", and passed cleanly on a build where the
    // player had fallen from y=40.16 to y=11.97 in the same four seconds. It
    // was measuring the horse, not the man on it.
    const fell = before.y - during.y;
    const drifted = (before.alt ?? 0) - (during.alt ?? 0);
    note(during.mounted !== null ? 'ok' : 'BUG',
      `still mounted with ${label} open`, `mounted=${during.mounted}`);
    note(Math.abs(fell) < 1.0 ? 'ok' : 'BUG',
      `the RIDER stays in the saddle with ${label} open`,
      `player y ${before.y.toFixed(2)} -> ${during.y.toFixed(2)} over 4 s `
      + `(fell ${fell.toFixed(2)} m); mount alt ${(before.alt ?? 0).toFixed(1)} `
      + `-> ${(during.alt ?? 0).toFixed(1)} m`);
    note(Math.abs(drifted) < 1.0 ? 'ok' : 'BUG',
      `the mount holds its altitude with ${label} open`,
      `alt ${(before.alt ?? 0).toFixed(1)} -> ${(during.alt ?? 0).toFixed(1)} m`);
    note(during.hp >= before.hp ? 'ok' : 'BUG',
      `no fall damage from ${label}`, `hp ${before.hp} -> ${during.hp}`);
    note(after.mounted !== null ? 'ok' : 'BUG',
      `still mounted after closing ${label}`, `mounted=${after.mounted}`);
  }

  // And the reins still work afterwards — a saddle lock that never lets go
  // would pass every assertion above and leave the player unable to fly.
  const preClimb = await airState();
  await flyUp(2);
  const postClimb = await airState();
  note((postClimb.alt ?? 0) > (preClimb.alt ?? 0) + 1 ? 'ok' : 'BUG',
    'the mount still flies after panels have been opened and closed',
    `alt ${(preClimb.alt ?? 0).toFixed(1)} -> ${(postClimb.alt ?? 0).toFixed(1)} m`);

  // Drop is P now, not Q. Q was also descend, so the old binding had to
  // suppress dropping on a flier entirely — you could not drop anything from
  // dragonback. Tested here because in flight is exactly where it used to be
  // impossible, and because a rebind that silently does nothing is the usual
  // way these go wrong.
  const drop = await page.evaluate(() => {
    window.__gameDebug.giveItem('stone', 5);
    window.__gameDebug.equipItem('stone');
    return window.__gameDebug.countItem('stone');
  });
  await page.waitForTimeout(400);
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(700);
  const afterP = await page.evaluate(() => ({
    stones: window.__gameDebug.countItem('stone'),
    alt: window.__gameDebug.mountAltitude(),
    notice: window.__gameStats.notice ?? null,
  }));
  note(afterP.stones === drop - 1 ? 'ok' : 'BUG',
    'P drops the held item, in flight, on a mount',
    `stone ${drop} -> ${afterP.stones}; notice ${JSON.stringify(afterP.notice)}`);
  // And Q must still be descend, not drop. Restock first: "stone 0 -> 0"
  // would pass whether Q dropped or not.
  const beforeQ = await page.evaluate(() => {
    window.__gameDebug.giveItem('stone', 4);
    window.__gameDebug.equipItem('stone');
    return window.__gameDebug.countItem('stone');
  });
  await page.waitForTimeout(400);
  await page.keyboard.down('KeyQ');
  await page.waitForTimeout(900);
  await page.keyboard.up('KeyQ');
  await page.waitForTimeout(400);
  const afterQ = await page.evaluate(() => ({
    stones: window.__gameDebug.countItem('stone'),
    alt: window.__gameDebug.mountAltitude(),
  }));
  note(afterQ.stones === beforeQ && beforeQ > 0 ? 'ok' : 'BUG',
    'Q no longer drops anything',
    `stone ${beforeQ} -> ${afterQ.stones} (with something in hand to drop)`);
  note((afterQ.alt ?? 0) < (afterP.alt ?? 0) - 1 ? 'ok' : 'BUG',
    'and Q still descends', `alt ${(afterP.alt ?? 0).toFixed(1)} -> ${(afterQ.alt ?? 0).toFixed(1)} m`);

  // The breath must not stay latched behind a panel (tickMountAttack clears
  // breathActive and the jaw before its own panel guard — confirm it).
  const latch = await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
    await raf();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyI' }));
    for (let i = 0; i < 30; i++) await raf();
    const probe = window.__gameDebug.breathProbe();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' }));
    return probe;
  });
  await page.waitForTimeout(600);
  note(latch === null || latch.active !== true ? 'ok' : 'BUG',
    'the breath does not stay latched behind a panel',
    `breathProbe active=${latch === null ? 'null' : String(latch.active)}`);
}
await bootOk('panels while airborne');

// ---------------------------------------------------------------------------
await browser.close();

process.stdout.write('\n--- summary ---\n');
const bugs = findings.filter((f) => f.severity === 'BUG');
for (const b of bugs) process.stdout.write(`BUG  ${b.title} — ${b.detail}\n`);
if (errors.length > 0) {
  process.stdout.write(`\n${errors.length} page/console errors:\n`);
  for (const e of errors.slice(0, 8)) process.stdout.write(`  ${e}\n`);
}
process.stdout.write(`\n${bugs.length} bug(s) found, ${errors.length} page error(s). Shots in ${outDir}\n`);
