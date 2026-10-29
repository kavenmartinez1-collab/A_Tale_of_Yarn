/**
 * stream-pilot-logic.mjs — the reloadable half of stream-pilot.mjs (POST /reload).
 *
 * The playing AI is slow (seconds per decision), so it does not drive the keys.
 * It sets GOALS; this module's tick (~8 Hz) plays continuously in between:
 * steering with smooth camera turns, getting unstuck, fighting back, respawning,
 * walking out of buildings, and logging EVENTS the narrator can react to.
 *
 * Goals (POST /goal):
 *   {type:"idle"}                                   stand, look around
 *   {type:"travel", x, z, label?, sprint?, within?}  go somewhere (arrival = event)
 *   {type:"explore"}                                 wander the world, heading changing slowly
 *   {type:"hunt", species?}                          find the nearest creature and fight it
 *   {type:"talk", name?}                             walk to an NPC and open the chat; stays
 *                                                    open for {do:"talk",text} lines via /act
 *   {type:"leave"}                                   get out of the building you are in
 *   {type:"dungeon", name?}                          walk into the nearest (or named) dungeon,
 *                                                    then hunt inside it
 */

const TAU = Math.PI * 2;
const wrap = (a) => { a = (a + Math.PI) % TAU; return a < 0 ? a + TAU - Math.PI : a - Math.PI; };
const yawTo = (p, x, z) => Math.atan2(-(x - p[0]), -(z - p[2]));
const now = () => Date.now();
// entity-types.ts aggro:false — not worth a fight on stream unless asked for by name.
const PASSIVE = new Set(['rabbit', 'deer', 'bird', 'horse', 'cow', 'donkey']);

export async function init(ctx) {
  ctx.mem.held ??= new Set();
  ctx.mem.last ??= null;
  ctx.mem.nav ??= {};
}

// ── keys ──────────────────────────────────────────────────────────────
async function hold(ctx, want) {
  const w = new Set(want);
  for (const k of [...ctx.mem.held]) if (!w.has(k)) { await ctx.page.keyboard.up(k); ctx.mem.held.delete(k); }
  for (const k of w) if (!ctx.mem.held.has(k)) { await ctx.page.keyboard.down(k); ctx.mem.held.add(k); }
}
const release = (ctx) => hold(ctx, []);

// ── snapshot (cheap, every tick) ──────────────────────────────────────
async function snap(ctx) {
  return ctx.G(() => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const v = g.vitals();
    const s = g.nearestSettlement();
    const cam = g.cameraState();
    const ents = (g.entities() || [])
      .filter((e) => (e.hp ?? 1) > 0 && !String(e.id).startsWith('castle:'))
      .map((e) => ({ id: e.id, species: e.species, hp: e.hp, x: e.x, y: e.y ?? p[1], z: e.z,
        dist: Math.hypot(e.x - p[0], (e.y ?? p[1]) - p[1], e.z - p[2]) }))
      .filter((e) => Math.abs(e.y - p[1]) <= 4 && e.dist < 120)
      .sort((a, b) => a.dist - b.dist).slice(0, 10);
    const npcs = (g.npcs() || []).map((n) => ({ id: n.id, name: n.name, role: n.role, x: n.x, z: n.z,
      dist: Math.hypot(n.x - p[0], n.z - p[2]) })).sort((a, b) => a.dist - b.dist).slice(0, 8);
    return {
      swim: !!g.playerMotion?.().swimming,
      slot: g.inventory().selected + 1,
      slot5: g.inventory().hotbar[4]?.id ?? null,
      bow: /bow$/.test(g.inventory().hotbar[3]?.id ?? '') && ((g.inventory().pack ?? []).some((it) => it?.id === 'flint_arrow' || it?.id === 'arrow')),
      // environment.ts: DAY_LENGTH_S 900, main.ts TOD_START 0.30, night < 0.26 or >= 0.74
      night: (() => { const tod = (g.simTime() / 900 + 0.30) % 1; return tod < 0.26 || tod >= 0.74; })(),
      p, hp: v.hp, alive: v.alive, deathCause: v.deathCause, stamina: v.stamina,
      inside: g.insideBuilding(), chatOpen: g.chatOpen(), reply: g.lastNpcReply(),
      paused: g.paused(), prompt: g.interactPrompt(),
      settlement: s ? { name: s.name, kind: s.kind, x: s.x, z: s.z, dist: Math.hypot(s.x - p[0], s.z - p[2]) } : null,
      boom: cam.boom, fwd: cam.forward, ents, npcs,
    };
  });
}

// ── public state (for the AI) ─────────────────────────────────────────
export async function state(ctx) {
  const s = await snap(ctx);
  const extra = await ctx.G(() => {
    const g = window.__gameDebug; const p = g.playerPos();
    const inv = g.inventory();
    const fmt = (it) => it ? `${it.id}${(it.count ?? 1) > 1 ? ' x' + it.count : ''}` : null;
    return {
      landmarks: (g.mapLandmarks?.() ?? []).map((l) => ({ kind: l.kind, name: l.name,
        x: Math.round(l.x), z: Math.round(l.z), dist: Math.round(Math.hypot(l.x - p[0], l.z - p[2])) }))
        .sort((a, b) => a.dist - b.dist).slice(0, 8),
      dungeon: g.nearestDungeonName?.() ?? null,
      hotbar: inv.hotbar.map((it, i) => `${i + 1}:${fmt(it) ?? '-'}`),
      selectedSlot: inv.selected + 1,
      pack: (inv.pack ?? inv.backpack ?? inv.slots ?? []).filter(Boolean).map(fmt),
    };
  });
  const r = (n) => Math.round(n);
  return {
    pos: s.p.map(r), hp: Math.round(s.hp * 10) / 10, alive: s.alive, stamina: r(s.stamina),
    inside: s.inside, paused: s.paused, prompt: s.prompt, chatOpen: s.chatOpen, lastNpcReply: s.reply,
    settlement: s.settlement && { ...s.settlement, x: r(s.settlement.x), z: r(s.settlement.z), dist: r(s.settlement.dist) },
    npcs: s.npcs.map((n) => ({ name: n.name, role: n.role, dist: r(n.dist), x: r(n.x), z: r(n.z) })),
    creatures: s.ents.map((e) => ({ id: e.id, species: e.species, hp: r(e.hp), dist: r(e.dist) })),
    ...extra,
    goal: ctx.goal, nextEvent: ctx.eventSeq, lastError: ctx.lastError,
    nav: { wp: ctx.mem.nav.wp ? [Math.round(ctx.mem.nav.wp.x), Math.round(ctx.mem.nav.wp.z)] : null, path: ctx.mem.nav.path?.length ?? null, aim: ctx.mem.nav.aim ?? null, stuck: ctx.mem.nav.stuck ?? 0,
      held: [...ctx.mem.held], target: ctx.mem.target?.species ?? null, grid: ctx.mem.grid ? [ctx.mem.grid.w, ctx.mem.grid.h] : null },
  };
}

// ── goals ─────────────────────────────────────────────────────────────
export async function setGoal(ctx, g) {
  const types = ['idle', 'travel', 'explore', 'hunt', 'talk', 'leave', 'dungeon'];
  if (!types.includes(g.type)) throw new Error(`goal type must be one of ${types.join(', ')}`);
  if (g.type === 'travel' && !(Number.isFinite(g.x) && Number.isFinite(g.z))) throw new Error('travel needs x and z');
  const s = await snap(ctx);
  if (s.chatOpen && g.type !== 'talk') await ctx.page.keyboard.press('Escape');
  await release(ctx);
  ctx.goal = { ...g, since: now() };
  ctx.mem.nav = {};
  ctx.event('goal', `${g.type}${g.label ? ' ' + g.label : g.name ? ' ' + g.name : g.species ? ' ' + g.species : ''}`);
}

// ── steering ──────────────────────────────────────────────────────────
async function steer(ctx, s, x, z, { sprint = false } = {}) {
  const nav = ctx.mem.nav;
  const t = now();
  // Smooth camera: turn toward the target at most ~3 rad/s (no snapping on stream).
  const want = yawTo(s.p, x, z);
  if (nav.yaw === undefined) nav.yaw = Math.atan2(-s.fwd[0], -s.fwd[2]);
  const d = wrap(want - nav.yaw);
  nav.yaw = wrap(nav.yaw + Math.max(-0.38, Math.min(0.38, d)));
  const boom = Math.max(2.5, Math.min(7, s.boom || 6));
  await ctx.G(([y, b]) => window.__gameDebug.setCamera(y, 0.18, b), [nav.yaw, boom]);

  // Unstick: if holding W but not moving, hop and strafe; three strikes -> detour.
  if (!nav.check || t - nav.check.t > 1200) {
    if (nav.check && Math.hypot(s.p[0] - nav.check.p[0], s.p[2] - nav.check.p[2]) < 0.6 && nav.walking) {
      nav.stuck = (nav.stuck ?? 0) + 1;
      nav.stuckTotal = (nav.stuckTotal ?? 0) + 1;
      nav.unstickUntil = t + 700;
      nav.strafe = nav.stuck % 2 ? 'KeyA' : 'KeyD';
      await ctx.page.keyboard.press('Space');
      if (nav.stuck >= 3) {
        const side = nav.stuck % 2 ? 1 : -1;
        const a = want + side * Math.PI / 2;
        nav.detour = { x: s.p[0] - Math.sin(a) * 10, z: s.p[2] - Math.cos(a) * 10, until: t + 3500 };
        nav.stuck = 0;
      }
    } else if (nav.check) nav.stuck = 0;
    nav.check = { t, p: s.p };
  }
  const keys = Math.abs(d) < 1.2 ? ['KeyW'] : [];   // turn first when facing away
  if (nav.unstickUntil > t) keys.push(nav.strafe);
  if (sprint && s.stamina > 25) keys.push('ShiftLeft');
  nav.walking = keys.includes('KeyW');
  await hold(ctx, keys);
}

// ── dungeon pathfinding ───────────────────────────────────────────────
// Dungeons are mazes of 1 m cells; straight-line steering pins the player in a
// corner. The game exposes the cell grid (__gameDebug.dungeonGrid), so plan A*
// over it and steer at the farthest path point in clear line of sight.
async function dungeonGrid(ctx, s) {
  if (s.p[1] > -200) return null;   // dungeon slots live at y = -300
  const m = ctx.mem;
  const c = m.grid;
  if (c && s.p[0] >= c.origin[0] && s.p[0] < c.origin[0] + c.w && s.p[2] >= c.origin[2] && s.p[2] < c.origin[2] + c.h) return c;
  m.grid = await ctx.G(() => window.__gameDebug.dungeonGrid());
  return m.grid;
}
const open = (g, cx, cz) => cx >= 0 && cz >= 0 && cx < g.w && cz < g.h && g.cells[cz * g.w + cx] !== 0;
function clearLine(g, ax, az, bx, bz) {   // grid-local metres; capsule-ish clearance 0.4 m
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25);
  for (let i = 1; i <= n; i++) {
    const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
    for (const [ox, oz] of [[0.4, 0.4], [-0.4, 0.4], [0.4, -0.4], [-0.4, -0.4]])
      if (!open(g, Math.floor(x + ox), Math.floor(z + oz))) return false;
  }
  return true;
}
function astar(g, sx, sz, tx, tz) {
  const W = g.w, H = g.h, N = W * H;
  const key = (x, z) => z * W + x;
  // Snap a blocked target (a creature hugging a wall) to the nearest open cell.
  if (!open(g, tx, tz)) {
    let best = null;
    for (let r = 1; r < 13 && !best; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++)
      if (!best && open(g, tx + dx, tz + dz)) best = [tx + dx, tz + dz];
    if (!best) return null; [tx, tz] = best;
  }
  const wallCost = (x, z) => { let k = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!open(g, x + dx, z + dz)) k++; return k ? 1.5 : 0; };
  const gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const heap = [];   // tiny binary heap of [f, key]
  const push = (f, k) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const s0 = key(sx, sz), goal = key(tx, tz);
  gs[s0] = 0; push(0, s0);
  let expanded = 0;
  while (heap.length && expanded < 40000) {
    const [, k] = pop();
    if (done[k]) continue; done[k] = 1; expanded++;
    if (k === goal) break;
    const x = k % W, z = (k / W) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = x + dx, nz = z + dz;
      if (!open(g, nx, nz)) continue;
      if (dx && dz && (!open(g, x + dx, z) || !open(g, x, z + dz))) continue;   // no corner cutting
      const nk = key(nx, nz);
      const ng = gs[k] + (dx && dz ? 1.414 : 1) + wallCost(nx, nz);
      if (ng < gs[nk]) { gs[nk] = ng; from[nk] = k; push(ng + Math.hypot(tx - nx, tz - nz), nk); }
    }
  }
  if (from[goal] < 0 && goal !== s0) return null;
  const path = [];
  for (let k = goal; k >= 0 && k !== s0; k = from[k]) path.push([(k % W) + 0.5, ((k / W) | 0) + 0.5]);
  return path.reverse();
}
/** Next steering point toward (x, z) inside a dungeon, or null to steer straight. */
function dungeonWaypoint(ctx, g, s, x, z) {
  const nav = ctx.mem.nav, t = now();
  const lx = s.p[0] - g.origin[0], lz = s.p[2] - g.origin[2];
  const tx = x - g.origin[0], tz = z - g.origin[2];
  if (clearLine(g, lx, lz, tx, tz)) { nav.path = null; return null; }
  if (!nav.path || t - nav.pathAt > 1500 || Math.hypot(nav.pathGoal[0] - tx, nav.pathGoal[1] - tz) > 2) {
    nav.path = astar(g, Math.floor(lx), Math.floor(lz), Math.floor(tx), Math.floor(tz));
    nav.pathAt = t; nav.pathGoal = [tx, tz];
    if (!nav.path) return null;
  }
  // Drop reached points, then aim at the farthest one in clear sight (smooth corners).
  while (nav.path.length > 1 && Math.hypot(nav.path[0][0] - lx, nav.path[0][1] - lz) < 0.8) nav.path.shift();
  let aim = nav.path[0];
  for (let i = Math.min(nav.path.length - 1, 12); i > 0; i--)
    if (clearLine(g, lx, lz, nav.path[i][0], nav.path[i][1])) { aim = nav.path[i]; break; }
  nav.aim = [Math.round(aim[0] * 10) / 10, Math.round(aim[1] * 10) / 10, Math.round(lx * 10) / 10, Math.round(lz * 10) / 10];
  return [aim[0] + g.origin[0], aim[1] + g.origin[2]];
}

// ── water ─────────────────────────────────────────────────────────────
// Swimming drains stamina, then drowning drains HP. Probe the terrain on 24
// rays: how far each stays above sea level (0), and how far to the first land.
async function probeWater(ctx, s) {
  return ctx.G(([px, pz]) => {
    const h = window.__gameDebug.heightAt;
    const rays = [];
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2, sx = -Math.sin(a), sz = -Math.cos(a);
      let dry = 0, land = null;
      for (let d = 2; d <= 30; d += 2) {
        const wet = h(px + sx * d, pz + sz * d) < 0.4;
        if (!wet && land === null) land = d;
        if (wet) break; dry = d;
      }
      for (let d = 2; land === null && d <= 60; d += 2) if (h(px + sx * d, pz + sz * d) >= 0.4) land = d;
      rays.push({ a, dry, land });
    }
    return rays;
  }, [s.p[0], s.p[2]]);
}
/** A yaw-safe steering point toward (x, z) that avoids water, or null for straight. */
async function waterDetour(ctx, s, x, z) {
  const nav = ctx.mem.nav, t = now();
  if (nav.waterAt && t - nav.waterAt < 400) return nav.waterWp ?? null;   // ~2.5 Hz is enough
  nav.waterAt = t;
  const rays = await probeWater(ctx, s);
  const want = yawTo(s.p, x, z);
  const dist = Math.hypot(x - s.p[0], z - s.p[2]);
  let wp = null;
  if (s.swim) {   // in the water: straight to the nearest shore
    const best = rays.filter((r) => r.land !== null).sort((a, b) => a.land - b.land)[0];
    if (best && (s.stamina < 60 || Math.abs(wrap(best.a - want)) > 1.6)) wp = best;
  } else {
    const ahead = rays.reduce((b, r) => Math.abs(wrap(r.a - want)) < Math.abs(wrap(b.a - want)) ? r : b);
    if (ahead.dry < Math.min(20, dist - 2)) {   // water ahead: the dry ray closest to the heading
      wp = rays.filter((r) => r.dry >= 16).sort((a, b) => Math.abs(wrap(a.a - want)) - Math.abs(wrap(b.a - want)))[0] ?? null;
    }
  }
  nav.waterWp = wp ? [s.p[0] - Math.sin(wp.a) * 12, s.p[2] - Math.cos(wp.a) * 12] : null;
  return nav.waterWp;
}

// ── outdoor local planner ─────────────────────────────────────────────
// Walls, houses and town gates: once straight steering gets stuck, sample the
// game's own collision (settlementSolidAt) and water (heightAt) into a 1 m grid
// around the player and the target, then follow an A* path through it.
async function localGrid(ctx, s, x, z, pad = 24) {
  // Bounding box of player and target plus `pad` (gates can be far round a wall).
  const ox = Math.floor(Math.min(s.p[0], x) - pad), oz = Math.floor(Math.min(s.p[2], z) - pad);
  const w = Math.min(220, Math.ceil(Math.abs(x - s.p[0]) + pad * 2));
  const h = Math.min(220, Math.ceil(Math.abs(z - s.p[2]) + pad * 2));
  return ctx.G(([ox, oz, w, h]) => {
    const g = window.__gameDebug, cells = new Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const wx = ox + i + 0.5, wz = oz + j + 0.5, y = g.heightAt(wx, wz);
      cells[j * w + i] = y < 0.4 || g.settlementSolidAt(wx, wz, 0.3, y + 0.9) ? 0 : 1;
    }
    return { w, h, origin: [ox, 0, oz], cells };
  }, [ox, oz, w, h]);
}

async function travelTo(ctx, s, x, z, opts) {
  const nav = ctx.mem.nav;
  if (!(s.p[1] < -200) && (nav.stuckTotal ?? 0) >= 2) {
    if (!nav.local || now() - nav.local.at > 20000) {
      // Widen until A* finds a way (the gate may be round the far side).
      for (const pad of [24, 60, 100]) {
        const g = await localGrid(ctx, s, x, z, pad);
        const lx = Math.floor(s.p[0] - g.origin[0]), lz = Math.floor(s.p[2] - g.origin[2]);
        const path = astar(g, lx, lz, Math.floor(x - g.origin[0]), Math.floor(z - g.origin[2]));
        nav.local = { at: now(), g, ok: !!path };
        nav.path = path; nav.pathAt = now(); nav.pathGoal = [x - g.origin[0], z - g.origin[2]];
        if (path) break;
      }
      ctx.event('plan', nav.local.ok ? `blocked, found a ${nav.path.length} m way around` : 'blocked and no way around found');
    }
    const g = nav.local.g, inside = (px, pz) => px >= g.origin[0] && pz >= g.origin[2] && px < g.origin[0] + g.w && pz < g.origin[2] + g.h;
    if (inside(s.p[0], s.p[2])) {
      const tx = Math.max(g.origin[0] + 1, Math.min(g.origin[0] + g.w - 2, x)), tz = Math.max(g.origin[2] + 1, Math.min(g.origin[2] + g.h - 2, z));
      const wp = dungeonWaypoint(ctx, g, s, tx, tz);
      if (wp) return steer(ctx, s, wp[0], wp[1], opts);
    }
  }
  const g = await dungeonGrid(ctx, s);
  if (g) {
    const wp = dungeonWaypoint(ctx, g, s, x, z);
    if (wp) return steer(ctx, s, wp[0], wp[1], opts);
  } else if (!opts?.swim) {
    const wp = await waterDetour(ctx, s, x, z);
    if (wp) return steer(ctx, s, wp[0], wp[1], { ...opts, sprint: false });
  }
  if (nav.detour && now() < nav.detour.until) {
    if (Math.hypot(nav.detour.x - s.p[0], nav.detour.z - s.p[2]) > 2) return steer(ctx, s, nav.detour.x, nav.detour.z, opts);
  }
  nav.detour = null;
  return steer(ctx, s, x, z, opts);
}

// ── the tick ──────────────────────────────────────────────────────────
export async function tick(ctx) {
  const s = await snap(ctx);
  const m = ctx.mem;
  const last = m.last;
  m.last = s;
  const t = now();
  // Per-creature speed (m/s) from the previous snapshot, for the bow.
  if (last) {
    const dt = Math.max(0.05, (t - (m.lastT ?? t - 120)) / 1000);
    const prev = new Map(last.ents.map((e) => [e.id, e]));
    for (const e of s.ents) { const q = prev.get(e.id); e.speed = q ? Math.hypot(e.x - q.x, e.z - q.z) / dt : 0; }
  }
  m.lastT = t;

  // Events
  if (last) {
    if (last.alive && !s.alive) ctx.event('died', `died (${s.deathCause ?? 'unknown'})`);
    if (!last.alive && s.alive) ctx.event('respawned', 'back on my feet');
    if (s.alive && last.alive && last.hp - s.hp >= 1.5) {
      const near = s.ents[0];
      ctx.event('hurt', `took ${Math.round((last.hp - s.hp) * 10) / 10} damage (hp ${Math.round(s.hp)})${near && near.dist < 6 ? ' from a ' + near.species : ''}`);
      m.hurtAt = t; m.attacker = near && near.dist < 6 ? near.id : null;
    }
    if (s.reply && s.reply !== last.reply) ctx.event('npc', s.reply);
    if (s.settlement && s.settlement.dist < 60 && m.inSettlement !== s.settlement.name) {
      m.inSettlement = s.settlement.name;
      ctx.event('arrived', `entered ${s.settlement.name} (${s.settlement.kind})`);
    } else if (s.settlement && s.settlement.dist > 90 && m.inSettlement === s.settlement.name) {
      ctx.event('left', `left ${s.settlement.name}`); m.inSettlement = null;
    }
    if (last.p[1] > -200 && s.p[1] < -200) { m.dungeonEntry = [s.p[0], s.p[2]]; m.lastFoeAt = t; }
    if (s.ents.some((e) => !PASSIVE.has(e.species)) || !m.lastFoeAt) m.lastFoeAt = t;
    if (last.inside !== s.inside) ctx.event(s.inside ? 'inside' : 'outside', s.inside ? 'went inside a building' : 'stepped outside');
    const jumped = Math.hypot(s.p[0] - last.p[0], s.p[2] - last.p[2]) > 10;   // respawn / doorway cut
    if (m.target && (jumped || !s.alive)) m.target = null;
    if (m.target && !s.ents.find((e) => e.id === m.target.id) && last.ents.find((e) => e.id === m.target.id)) {
      // Only a kill if it vanished within bow range; far targets just drop off the top-10 list.
      const gone = last.ents.find((e) => e.id === m.target.id);
      if (gone.dist < 40) ctx.event('kill', `the ${gone.species} is down`);
      m.target = null;
    }
  }

  if (s.paused) {
    await release(ctx);
    // The game pauses itself when the window is hidden for a moment; only the
    // producer's pause (Stream PAUSE.cmd -> /producer/pause) should stick.
    m.pausedSince ??= t;
    if (!m.producerPaused && t - m.pausedSince > 3000
        && await ctx.G(() => document.visibilityState === 'visible')) {
      await ctx.G(() => window.__gameDebug.setPaused(false));
      ctx.event('unpaused', 'the game paused itself (window hidden); resumed');
      m.pausedSince = null;
    }
    return;
  }
  m.pausedSince = null;
  if (!s.alive) {
    await release(ctx);
    m.deadSince ??= t;
    if (t - m.deadSince > 3500) {
      const btn = ctx.page.getByRole('button', { name: /respawn/i }).first();
      if (await btn.count()) await btn.click().catch(() => {});
      m.deadSince = null;
    }
    return;
  }
  m.deadSince = null;

  // Heal: below 9 HP, drink a healing potion from hotbar slot 3 (staged there by
  // /producer/loadout), then back to the sword. Hits too small for a "hurt" event
  // (archer plinks) still add up, so this watches HP directly.
  if (s.hp < 10 && !(s.swim && s.stamina < 5) && (!m.healAt || t - m.healAt > 2500)) {
    // Slot 3 is the heal slot: refill it from the pack (a MOVE, not a spawn) —
    // potions first, then cooked meat. The pack stack is cleared and the same
    // stack set on slot 3 via equipItem, which also refreshes the hotbar UI.
    let potions = await ctx.G(() => {
      const h = window.__gameDebug.inventory().hotbar[2];
      return ['healing_potion', 'meat_cooked'].includes(h?.id) ? (h.count ?? 1) : 0;
    });
    if (!potions) {
      await ctx.page.keyboard.press('Digit3'); await ctx.sleep(120);
      const moved = await ctx.G(() => {
        const g = window.__gameDebug, inv = g.inventory();
        if (inv.selected !== 2 || inv.hotbar[2]) return null;   // never overwrite a real item
        for (const id of ['healing_potion', 'meat_cooked']) {
          const i = inv.pack.findIndex((it) => it?.id === id);
          if (i >= 0) { const st = inv.pack[i]; inv.pack[i] = null; g.equipItem(st.id, st.count); return st; }
        }
        return null;
      });
      if (moved) { ctx.event('restock', `took ${moved.count} ${moved.id} from the pack`); potions = moved.count; }
      else await ctx.page.keyboard.press('Digit1');
    }
    if (potions > 0) {
      m.healAt = t;
      await release(ctx);
      await ctx.page.keyboard.press('Digit3'); await ctx.sleep(150);
      await ctx.page.keyboard.press('KeyE'); await ctx.sleep(450);
      await ctx.page.keyboard.press('Digit1');
      ctx.event('heal', `healed at ${Math.round(s.hp)} hp (${potions - 1} left)`);
      return;
    }
  }

  // Self-defense: something just hit us and is close -> fight it, whatever the goal.
  // Focus fire: in a crowd, finish the weakest enemy in sword reach first —
  // switching to whoever hit last spreads the damage and kills nothing.
  if (m.hurtAt && t - m.hurtAt < 4000 && m.attacker && ctx.goal.type !== 'talk') {
    const reach = s.ents.filter((e) => e.dist < 3.2 && !PASSIVE.has(e.species));
    const cur = reach.find((e) => e.id === m.target?.id);
    const a = cur ?? reach.sort((x, y) => x.hp - y.hp)[0] ?? s.ents.find((e) => e.id === m.attacker);
    if (a) return fight(ctx, s, a);
  }

  // An NPC opened a conversation on us (a gate guard's challenge): stop moving —
  // held keys would type into the chat box — and hand it to the AI.
  if (s.chatOpen && ctx.goal.type !== 'talk') {
    await release(ctx);
    if (!last?.chatOpen) ctx.event('chat', `an NPC started talking to me: ${s.reply ?? ''}`);
    return;
  }

  // Light: a held torch is the only light at night (and it only burns while
  // held). Torch out of combat in the dark; fight() switches to the sword.
  const dark = s.night || s.p[1] < -200;
  const fighting = m.fightAt && t - m.fightAt < 3000;
  const wantSlot = dark && !fighting && s.slot5 === 'torch' && ctx.goal.type !== 'talk' ? 5 : 1;
  if (!fighting && s.slot !== wantSlot && (s.slot === 1 || s.slot === 4 || s.slot === 5) && (!m.slotAt || t - m.slotAt > 800)) {
    m.slotAt = t;
    await ctx.page.keyboard.press(`Digit${wantSlot}`);
  }

  const g = ctx.goal;
  switch (g.type) {
    case 'idle': {
      await release(ctx);
      if (!m.swayAt || t - m.swayAt > 4000) {   // a slow look-around so the stream isn't frozen
        m.swayAt = t;
        const nav = m.nav; if (nav.yaw === undefined) nav.yaw = Math.atan2(-s.fwd[0], -s.fwd[2]);
        nav.yaw = wrap(nav.yaw + (Math.random() - 0.5) * 0.9);
        await ctx.G(([y, b]) => window.__gameDebug.setCamera(y, 0.15, b), [nav.yaw, Math.max(2.5, Math.min(7, s.boom || 6))]);
      }
      return;
    }
    case 'leave': {
      if (s.p[1] < -200 && !s.inside) {   // a dungeon: walk back to where we came in
        if (/leave the dungeon/i.test(s.prompt ?? '')) { await release(ctx); return pressE(ctx); }
        // Where is the exit portal? Not exposed, so read it: teleport there and
        // straight back inside ONE synchronous evaluate — no frame renders in
        // between, so nothing moves on screen.
        if (!m.dungeonExit || m.dungeonExitFor !== m.grid?.origin?.join()) {
          m.dungeonExit = await ctx.G(() => {
            const g = window.__gameDebug, grid = g.dungeonGrid(), p = g.playerPos();
            g.teleportToExitPortal(); const e = g.playerPos();
            g.dungeonPlacePlayer(p[0] - grid.origin[0], p[2] - grid.origin[2]);
            return [e[0], e[2]];
          });
          m.dungeonExitFor = m.grid?.origin?.join();
        }
        return travelTo(ctx, s, m.dungeonExit[0], m.dungeonExit[1], {});
      }
      if (last && last.p[1] < -200 && s.p[1] > -200) { ctx.event('outside', 'back up in the open air'); ctx.goal = { type: 'idle', since: t }; return; }
      return leave(ctx, s, () => { ctx.goal = { type: 'idle', since: t }; });
    }
    case 'dungeon': {
      if (s.p[1] < -200) {   // in: go hunting
        ctx.event('entered', 'went down into the dungeon');
        ctx.goal = { type: 'hunt', since: t }; m.nav = {};
        return;
      }
      if (/enter/i.test(s.prompt ?? '')) { await release(ctx); return pressE(ctx); }
      if (!g.at) {
        g.at = await ctx.G((name) => {
          const g = window.__gameDebug, p = g.playerPos();
          const ds = (g.mapLandmarks?.() ?? []).filter((l) => l.kind === 'dungeon' && (!name || l.name.toLowerCase().includes(name.toLowerCase())));
          ds.sort((a, b) => Math.hypot(a.x - p[0], a.z - p[2]) - Math.hypot(b.x - p[0], b.z - p[2]));
          return ds[0] ? { x: ds[0].x, z: ds[0].z, name: ds[0].name } : null;
        }, g.name ?? null);
        if (!g.at) { ctx.event('goal', 'no dungeon on the map nearby'); ctx.goal = { type: 'idle', since: t }; return; }
      }
      return travelTo(ctx, s, g.at.x, g.at.z, { sprint: Math.hypot(g.at.x - s.p[0], g.at.z - s.p[2]) > 25 });
    }
    case 'travel': {
      if (s.inside) return leave(ctx, s);
      const dist = Math.hypot(g.x - s.p[0], g.z - s.p[2]);
      if (dist < (g.within ?? 4)) {
        await release(ctx);
        ctx.event('arrived', `reached ${g.label ?? `${Math.round(g.x)}, ${Math.round(g.z)}`}`);
        ctx.goal = { type: 'idle', since: t };
        return;
      }
      return travelTo(ctx, s, g.x, g.z, { sprint: g.sprint ?? dist > 25 });
    }
    case 'explore': {
      if (s.inside) return leave(ctx, s);
      const nav = m.nav;
      if (!nav.wp || Math.hypot(nav.wp.x - s.p[0], nav.wp.z - s.p[2]) < 6 || t - nav.wp.t > 40000) {
        // A waypoint on dry land (a sea waypoint can never be reached): try
        // headings fanning out from the current one.
        const base = (nav.heading ?? Math.atan2(-s.fwd[0], -s.fwd[2])) + (Math.random() - 0.5) * 1.6;
        const cands = [];
        for (let k = 0; k < 12; k++) {
          const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5, r = 50 + Math.random() * 50;
          cands.push([a, s.p[0] - Math.sin(a) * r, s.p[2] - Math.cos(a) * r]);
        }
        const ok = await ctx.G((cs) => cs.findIndex(([, x, z]) => window.__gameDebug.heightAt(x, z) > 1), cands);
        const [a, x, z] = cands[Math.max(0, ok)];
        nav.heading = a;
        nav.wp = { x, z, t };
      }
      // Wandering into a creature is the content: engage anything close.
      const close = s.ents.find((e) => e.dist < (s.bow ? 30 : 10) && !PASSIVE.has(e.species) && e.hp <= 60);
      if (close && g.engage !== false) return fight(ctx, s, close);
      return travelTo(ctx, s, nav.wp.x, nav.wp.z, { sprint: false });
    }
    case 'hunt': {
      if (s.inside) return leave(ctx, s);
      // Stay on the current target while it lives; skip bosses (hp > 60) unless asked
      // for by species or {boss:true}; nothing new while HP is low.
      const fits = (e) => g.species ? String(e.species).includes(g.species) : (!PASSIVE.has(e.species) && (g.boss || e.hp <= 60));
      const prey = s.ents.find((e) => e.id === m.target?.id && fits(e))
        ?? s.ents.filter((e) => e.dist < 3.2 && fits(e)).sort((x, y) => x.hp - y.hp)[0]
        ?? (s.hp >= 9 ? s.ents.find(fits) : null);
      // Loot: a chest in reach and nothing hostile close -> open it.
      if (/open the chest/i.test(s.prompt ?? '') && !s.ents.some((e) => e.dist < 10 && !PASSIVE.has(e.species))) {
        await release(ctx); return pressE(ctx);
      }
      if (!prey && s.p[1] < -200 && m.lastFoeAt && t - m.lastFoeAt > 40000) {
        ctx.event('cleared', 'nothing left alive down here; heading out');
        ctx.goal = { type: 'leave', since: t }; m.nav = {};
        return;
      }
      if (!prey) {   // nothing in sight: wander until something shows up
        const nav = m.nav;
        const grid = await dungeonGrid(ctx, s);
        if (grid && (!nav.wp || Math.hypot(nav.wp.x - s.p[0], nav.wp.z - s.p[2]) < 2.5 || t - nav.wp.t > 25000)) {
          // Dungeon: roam to a random reachable floor cell 12-45 m away, preferring
          // places not visited yet (coarse 8 m memory).
          m.seen ??= new Set();
          m.seen.add(`${Math.floor(s.p[0] / 8)},${Math.floor(s.p[2] / 8)}`);
          let pick = null;
          for (let k = 0; k < 400 && !pick; k++) {
            const i = (Math.random() * grid.w) | 0, j = (Math.random() * grid.h) | 0;
            if (!grid.cells[j * grid.w + i]) continue;
            const wx = grid.origin[0] + i + 0.5, wz = grid.origin[2] + j + 0.5, d = Math.hypot(wx - s.p[0], wz - s.p[2]);
            if (d < 12 || d > 45) continue;
            if (k < 300 && m.seen.has(`${Math.floor(wx / 8)},${Math.floor(wz / 8)}`)) continue;
            pick = { x: wx, z: wz, t };
          }
          if (pick) nav.wp = pick;
        }
        if (grid && nav.wp) return travelTo(ctx, s, nav.wp.x, nav.wp.z, { sprint: false });
        if (!nav.wp || Math.hypot(nav.wp.x - s.p[0], nav.wp.z - s.p[2]) < 6) {
          nav.heading = (nav.heading ?? 0) + (Math.random() - 0.5) * 2;
          nav.wp = { x: s.p[0] - Math.sin(nav.heading) * 60, z: s.p[2] - Math.cos(nav.heading) * 60, t };
        }
        return travelTo(ctx, s, nav.wp.x, nav.wp.z, { sprint: false });
      }
      return fight(ctx, s, prey);
    }
    case 'talk': {
      if (s.chatOpen) { await release(ctx); return; }   // conversation in progress: hold still
      const npc = (g.lock && s.npcs.find((n) => n.name + '|' + n.role === g.lock)) || s.npcs.find((n) => (!g.name || String(n.name).toLowerCase().includes(String(g.name).toLowerCase()))
        && (!g.role || n.role === g.role));   // names repeat (two Quills): role disambiguates
      if (!npc) {
        if (s.inside && /talk/i.test(s.prompt ?? '')) { await release(ctx); return pressE(ctx); }
        return;   // nobody here; the AI should pick another goal
      }
      // Stick with the first match so a nearer namesake doesn't steal the goal.
      if (!g.lock) g.lock = npc.name + '|' + npc.role;
      // E does whatever the prompt says: only press it when it offers talk (a door
      // or "leave" trigger also sits on E). Otherwise keep closing in.
      // Indoors the HUD says "E — talk to <name>"; outdoors NPC talk has no prompt,
      // so there E is only safe when nothing else (a door, a sign) is offered.
      const talkPrompt = new RegExp(`talk to ${npc.name}|speak`, 'i').test(s.prompt ?? '');
      if (talkPrompt || (!s.inside && npc.dist < 2.4 && !s.prompt)) { await release(ctx); return pressE(ctx); }
      if (npc.dist > 1.2) return travelTo(ctx, s, npc.x, npc.z, { sprint: npc.dist > 25 });
      await release(ctx);
      return;
    }
  }
}

async function pressE(ctx) {
  const m = ctx.mem;
  if (m.lastE && now() - m.lastE < 1500) return;
  m.lastE = now();
  await ctx.page.keyboard.press('KeyE');
}

// ── the bow ───────────────────────────────────────────────────────────
// 9-35 m with a clear line: stand, draw (BOW_DRAW_S 0.55 s), aim so the game's
// own reticle reads the target, release through the player's release function
// (refire limit intact). Flint is the everyday arrow; Tintreach (item `arrow`,
// the hitscan lightning arrow, a boss drop) only now and again.
async function canShoot(ctx, s, target) {
  if (!s.bow || target.dist < 9 || target.dist > 30) return false;
  const m = ctx.mem;
  // Flint flies an arc (~0.7 s at 25 m): only at something standing or walking.
  // A runner gets the sword, or now and again a hitscan Tintreach bolt.
  const tint = await ctx.G(() => (window.__gameDebug.inventory().pack ?? []).some((it) => it?.id === 'arrow'));
  const flint = await ctx.G(() => (window.__gameDebug.inventory().pack ?? []).some((it) => it?.id === 'flint_arrow'));
  m.forceTint = false;
  if ((target.speed ?? 0) > 2.2 || !flint) {
    // One roll per target, not per tick (8 rolls a second would always win).
    m.tintRoll ??= {};
    m.tintRoll[target.id] ??= Math.random() < 0.25;
    if (!tint || PASSIVE.has(target.species) || !m.tintRoll[target.id]) return false;
    m.forceTint = true;
  }
  // Three arrows without a dent in its HP: something is in the way. Close in.
  if (m.bowMiss?.id === target.id && m.bowMiss.until > now()) return false;
  if (m.bowLog?.id !== target.id) m.bowLog = { id: target.id, hp: target.hp, shots: 0 };
  if (target.hp < m.bowLog.hp) { m.bowLog.hp = target.hp; m.bowLog.shots = 0; }
  if (m.bowLog.shots >= 3) { m.bowMiss = { id: target.id, until: now() + 10000 }; m.bowLog = null; return false; }
  if (s.p[1] > -200) {   // outdoors: no hill between the eye and the target
    const clear = await ctx.G(([p, tx, ty, tz]) => {
      const h = window.__gameDebug.heightAt;
      for (let i = 1; i < 12; i++) {
        const f = i / 12, x = p[0] + (tx - p[0]) * f, z = p[2] + (tz - p[2]) * f;
        if (h(x, z) > p[1] + 1.45 + (ty + 1 - p[1] - 1.45) * f + 0.4 * Math.sin(Math.PI * f) - 0.1) return false;
      }
      return true;
    }, [s.p, target.x, target.y, target.z]);
    if (!clear) return false;
  }
  if (s.p[1] < -200) return ctx.G(([a, b, c, d]) => window.__gameDebug.dungeonSeesFrom(a, b, c, d), [s.p[0], s.p[2], target.x, target.z]);
  return true;
}
async function shoot(ctx, s, target) {
  const m = ctx.mem, t = now();
  await hold(ctx, []);
  if (s.slot !== 4) { m.drawAt = null; await ctx.page.keyboard.press('Digit4'); return; }
  const yaw = yawTo(s.p, target.x, target.z);
  m.nav.yaw = yaw;
  const aim = [yaw, target.x, target.y, target.z, s.p, Math.max(2.5, Math.min(7, s.boom || 6)), target.id];
  // Pitch from boss-kill-real.mjs: eye ~1.45 m, aim ~1 m up the target; the
  // game solves the arc to whatever the reticle is on.
  const aimFn = ([yaw, tx, ty, tz, p, boom, id]) => {
    const g = window.__gameDebug, flat = Math.hypot(tx - p[0], tz - p[2]);
    const base = Math.max(-1.2, Math.min(0.8, -Math.atan2(ty + 1 - (p[1] + 1.45), flat)));
    for (const off of [0, 0.04, -0.04, 0.08, -0.08, 0.12]) {
      g.setCamera(yaw, base + off, boom);
      if (g.aimTarget().id === id) return true;
    }
    g.setCamera(yaw, base, boom);
    return false;
  };
  if (!m.drawAt) {
    if (m.shotAt && t - m.shotAt < 650) { await ctx.G(aimFn, aim); return; }
    const tint = await ctx.G(() => (window.__gameDebug.inventory().pack ?? []).some((it) => it?.id === 'arrow'));
    m.tint = m.forceTint || (tint && !PASSIVE.has(target.species) && Math.random() < (target.hp >= 40 ? 0.4 : 0.15));
    await ctx.G((k) => window.__gameDebug.setAmmo(k), m.tint ? 'tintreach' : 'flint');
    m.drawAt = t;
    await ctx.G(aimFn, aim);
    return;
  }
  const onTarget = await ctx.G(aimFn, aim);
  if (t - m.drawAt < 600 || (!onTarget && t - m.drawAt < 1600)) return;   // full draw, then wait for a clean sight
  // Draw + release in one call: without pointer lock (a streamed window the
  // viewer never clicked) the game cancels a held draw every frame. The aim
  // pause above keeps shots slower than BOW_REFIRE_S (0.6 s) anyway.
  const fired = await ctx.G(() => {
    const g = window.__gameDebug, before = g.projectiles().length;
    g.bowDrawTo(1); g.releaseBow(); g.setAmmo('flint');
    return g.projectiles().length > before || true;
  });
  if (!fired) return;
  m.drawAt = null; m.shotAt = t;
  if (m.bowLog?.id === target.id) m.bowLog.shots++;
  m.shots = (m.shots ?? 0) + 1;
  if (m.tint) ctx.event('tintreach', `loosed a Tintreach lightning arrow at the ${target.species}`);
  else if (m.shots % 5 === 1) ctx.event("shot", `shooting at the ${target.species} (${Math.round(target.dist)} m${onTarget ? "" : ", no clean sight"})`);
}

async function fight(ctx, s, target) {
  const m = ctx.mem;
  m.fightAt = now();
  if (await canShoot(ctx, s, target)) {
    if (!m.target || m.target.id !== target.id) { m.target = { id: target.id, species: target.species }; ctx.event('fight', `engaging a ${target.species} with the bow`); }
    return shoot(ctx, s, target);
  }
  m.drawAt = null;   // closed in: abandon the aim, no shot
  if (s.slot !== 1 && target.dist < 8) { await ctx.page.keyboard.press('Digit1'); return; }   // sword out
  if (!m.target || m.target.id !== target.id) {
    m.target = { id: target.id, species: target.species };
    ctx.event('fight', `engaging a ${target.species}`);
  }
  if (target.dist > 2.3) return travelTo(ctx, s, target.x, target.z, { sprint: target.dist > 12 });
  const nav = m.nav;
  const want = yawTo(s.p, target.x, target.z);
  nav.yaw = want;
  await ctx.G(([y, b]) => window.__gameDebug.setCamera(y, 0.18, b), [want, Math.max(2.5, Math.min(7, s.boom || 6))]);
  await hold(ctx, []);
  if (!m.swingAt || now() - m.swingAt > 430) {
    m.swingAt = now();
    await ctx.G(() => window.__gameDebug.leftClick());
  }
}

async function leave(ctx, s, done) {
  if (!s.inside) { done?.(); return; }
  await release(ctx);
  const m = ctx.mem;
  if (m.leaveAt && now() - m.leaveAt < 1500) return;
  m.leaveAt = now();
  // Step to the door, then use it (E). A cut, not a walk — interiors have no nav yet.
  await ctx.G(() => window.__gameDebug.buildingTeleportToExit());
  await ctx.sleep(250);
  await ctx.page.keyboard.press('KeyE');
}

// ── immediate actions (POST /act) ─────────────────────────────────────
export async function act(ctx, a) {
  const { page, G, sleep } = ctx;
  await release(ctx);
  switch (a.do) {
    case 'talk': {   // a line to the NPC whose chat is open
      const input = page.locator('#npc-chat-panel .npc-input').first();
      if (await input.count() === 0) throw new Error('no NPC chat is open');
      await input.fill(String(a.text ?? '').slice(0, 300));
      await input.press('Enter');
      return;
    }
    case 'close': return page.keyboard.press('Escape');
    case 'slot': return page.keyboard.press(`Digit${Math.max(1, Math.min(9, a.n | 0))}`);
    case 'jump': return page.keyboard.press('Space');
    case 'interact': return page.keyboard.press('KeyE');
    case 'attack': {
      const until = Date.now() + Math.min(a.ms ?? 600, 8000);
      do { await G(() => window.__gameDebug.leftClick()); await sleep(400); } while (Date.now() < until);
      return;
    }
    case 'look': {
      ctx.mem.nav.yaw = a.yaw;
      return G(([y, p]) => { const g = window.__gameDebug;
        g.setCamera(y, p, Math.max(2.5, Math.min(7, g.cameraState().boom || 6))); }, [a.yaw, a.pitch ?? 0.18]);
    }
    case 'wait': return sleep(Math.min(a.ms ?? 1000, 20000));
    default: throw new Error(`unknown action ${JSON.stringify(a.do)} (talk, close, slot, jump, interact, attack, look, wait)`);
  }
}

// ── producer staging helpers ──────────────────────────────────────────
export async function producer(ctx, name, a) {
  const { G, sleep } = ctx;
  await release(ctx);
  if (name === 'teleport') { await G(([x, z]) => window.__gameDebug.teleport(x, z), [a.x, a.z]); await sleep(1200); return; }
  if (name === 'gridDump') {   // debug: ASCII of the outdoor planner grid -> <shotDir>/grid.txt
    const s = await snap(ctx);
    const g = await localGrid(ctx, s, a.x, a.z);
    const fs = await import('node:fs');
    const px = Math.floor(s.p[0] - g.origin[0]), pz = Math.floor(s.p[2] - g.origin[2]);
    const tx = Math.floor(a.x - g.origin[0]), tz = Math.floor(a.z - g.origin[2]);
    let out = `origin ${g.origin} size ${g.w} player ${px},${pz} target ${tx},${tz}\n`;
    for (let j = 0; j < g.h; j++) { let row = ''; for (let i = 0; i < g.w; i++) row += i === px && j === pz ? 'P' : i === tx && j === tz ? 'T' : g.cells[j * g.w + i] ? '.' : '#'; out += row + '\n'; }
    const path = await import('node:path');
    fs.writeFileSync(path.join(ctx.shotDir, 'grid.txt'), out); return;   // fixed path: never a caller-chosen file
  }
  if (name === 'volume') {   // {music?, sfx?, voice?, master?} 0..1, the game's own settings
    const patch = {};
    for (const [k, key] of [['music', 'volMusic'], ['sfx', 'volSfx'], ['voice', 'volVoice'], ['master', 'volMaster']])
      if (Number.isFinite(a[k])) patch[key] = Math.max(0, Math.min(1, a[k]));
    ctx.mem.volume = await G((p) => { const st = window.__gameDebug.settings(); st.set(p);
      const n = window.__gameDebug.settings(); return { master: n.volMaster, music: n.volMusic, sfx: n.volSfx, voice: n.volVoice }; }, patch);
    ctx.event('volume', JSON.stringify(ctx.mem.volume));
    return;
  }
  if (name === 'loadout') {   // healing potions into hotbar slot 3 (replaces the pickaxe)
    await ctx.page.keyboard.press('Digit3'); await sleep(120);
    await G((n) => window.__gameDebug.equipItem('healing_potion', n), a.potions ?? 10);
    await sleep(120); await ctx.page.keyboard.press('Digit1'); return;
  }
  if (name === 'pause') { ctx.mem.producerPaused = !!a.on; await G((v) => window.__gameDebug.setPaused(!!v), a.on); await sleep(300); return; }
  if (name === 'exit') {
    await G(() => { const g = window.__gameDebug; if (g.insideBuilding()) g.buildingTeleportToExit(); });
    await sleep(300); await ctx.page.keyboard.press('KeyE'); await sleep(800); return;
  }
  throw new Error(`unknown producer action ${name}`);
}
