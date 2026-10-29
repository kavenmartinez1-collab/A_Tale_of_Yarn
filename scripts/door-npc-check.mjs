/**
 * In-game check: an NPC standing beside a building can be talked to outdoors.
 *
 *   node scripts/door-npc-check.mjs
 *
 * The door prompt fires anywhere within reach of a building's WALL, and the E
 * chain used to test buildings before NPCs, so a villager by a house was
 * unreachable: the HUD said "Press E to enter" and E walked you inside.
 * npcBeatsBuilding() now lets an NPC within arm's reach (1.8 m) win outdoors.
 *
 * For every outdoor NPC near spawn, stand 1 m from them in eight directions and
 * read the HUD prompt. Pass when no sample with an NPC inside arm's reach shows
 * a door prompt, AND the probe actually stood next to a building with someone
 * there (otherwise it proved nothing) — plus a control: a wall with nobody near
 * still offers the door.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto('http://localhost:5173/game.html?director=off&tod=0.5&weather=clear&wipe=1');
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 180_000 });
const G = (fn, a) => page.evaluate(fn, a);
// Stand in the nearest settlement and let it stream in and its NPCs spawn.
await G(() => window.__gameDebug.teleportToNearestSettlement());
let npcs = [];
for (let i = 0; i < 40 && npcs.length < 3; i++) {
  await page.waitForTimeout(500);
  npcs = await G(() => window.__gameDebug.npcs().filter((n) => !n.indoors)
    .map((n) => ({ id: n.id, name: n.name, x: n.x, z: n.z })));
}
console.log(`outdoor NPCs: ${npcs.length}`);

let nearSamples = 0, doorWithNpc = 0, talkNextToBuilding = 0;
const bad = [];
for (const n of npcs.slice(0, 30)) {
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2;
    const r = await G(async ([id, a]) => {
      const g = window.__gameDebug;
      const me = g.npcs().find((q) => q.id === id);
      if (!me) return null;
      g.teleport(me.x + Math.sin(a) * 1.0, me.z + Math.cos(a) * 1.0);
      await new Promise((res) => setTimeout(res, 150));
      const p = g.playerPos(), now = g.npcs().find((q) => q.id === id);
      // Nearest building wall (settlement blockers), to know the door trigger was live.
      let wall = Infinity;
      for (const b of g.settlementBlockers()) {
        const dx = Math.max(b.x0 - p[0], 0, p[0] - b.x1), dz = Math.max(b.z0 - p[2], 0, p[2] - b.z1);
        wall = Math.min(wall, Math.hypot(dx, dz));
      }
      return { prompt: g.interactPrompt(), d: Math.hypot(now.x - p[0], now.z - p[2]), wall };
    }, [n.id, a]);
    if (!r || r.d >= 1.8) continue;
    nearSamples++;
    // "E — talk to X" while a wall is in reach is the case that used to fail;
    // a door prompt here is the bug.
    if (/Press E to enter/.test(r.prompt ?? '')) { doorWithNpc++; bad.push(`${n.name} @${k}: ${r.prompt} (npc ${r.d.toFixed(2)} m)`); }
    if (/talk to/.test(r.prompt ?? '') && r.wall < 2.5) talkNextToBuilding++;
  }
}

// Control: the door must still work when nobody is there. Walk a ring around the
// first NPC at 6-10 m until a door prompt shows with every NPC > 3 m away.
const control = await G(async (center) => {
  const g = window.__gameDebug;
  for (let r = 4; r <= 30; r += 2) for (let k = 0; k < 24; k++) {
    const a = k / 24 * Math.PI * 2;
    g.teleport(center.x + Math.sin(a) * r, center.z + Math.cos(a) * r);
    await new Promise((res) => setTimeout(res, 60));
    const p = g.playerPos();
    const near = g.npcs().some((q) => Math.hypot(q.x - p[0], q.z - p[2]) < 3);
    if (!near && /Press E to enter/.test(g.interactPrompt() ?? '')) return true;
  }
  return false;
}, npcs[0] ?? { x: 0, z: 0 });

console.log(`samples with an NPC in arm's reach: ${nearSamples}; of those talk-with-a-wall-in-door-reach: ${talkNextToBuilding}; door prompts: ${doorWithNpc}`);
for (const b of bad.slice(0, 10)) console.log(`  BAD ${b}`);
console.log(`control (door with nobody near still offered): ${control}`);
await browser.close();
// talkNextToBuilding > 0 is what makes this a test of the fix: a talk prompt
// won with a building wall inside the door trigger's reach.
const ok = npcs.length > 0 && talkNextToBuilding > 0 && doorWithNpc === 0 && control;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
