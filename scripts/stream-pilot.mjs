/**
 * stream-pilot.mjs — play A Tale of Yarn on screen for a live stream.
 *
 *   node scripts/stream-pilot.mjs [--port 8790] [--wipe] [--profile <dir>]
 *
 * Opens the game (vite dev server on 127.0.0.1:5173) in a VISIBLE Chrome window —
 * the window the streamer screen-shares — and serves a JSON API on 127.0.0.1 only.
 *
 * Two layers, so the harness can be improved WHILE the stream is live:
 *   - this core: the browser, the HTTP server, the autopilot clock. It never needs a
 *     restart (a restart closes the shared window).
 *   - scripts/stream-pilot-logic.mjs: state, actions, goals, the autopilot tick and the
 *     event feed. POST /reload re-imports it in place; the game keeps running.
 *
 *   GET  /state            what the player sees (logic.state)
 *   GET  /events?since=N   things that happened (kills, damage, arrivals, NPC replies...)
 *   GET  /shot             screenshot -> { path }
 *   POST /goal {...}       give the autopilot a goal (logic.setGoal) — it keeps playing
 *   POST /act  {do: ...}   one immediate action (logic.act)
 *   POST /reload           re-import the logic module
 *   POST /producer/{teleport|pause|exit|volume|loadout|gridDump}   staging/debug helpers
 *
 * Only plain local clients (curl, scripts) are served: requests a browser makes
 * for a web page are refused, so no website can drive the game through this.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1] ?? d; };
const PORT = Number(opt('port', '8790'));
const GAME = opt('game', 'http://127.0.0.1:5173/game.html');
const PROFILE = opt('profile', path.join(os.tmpdir(), 'yarn-stream-profile')); // warm shader cache
const SHOT_DIR = opt('shots', path.join(os.tmpdir(), 'yarn-stream-shots'));
const LOGIC = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'stream-pilot-logic.mjs')).href;
fs.mkdirSync(SHOT_DIR, { recursive: true });

const browserCtx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport: null,
  args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,900', '--window-position=40,40'],
});
const page = browserCtx.pages()[0] ?? await browserCtx.newPage();
await page.goto(GAME + (args.includes('--wipe') ? '?wipe=1' : ''));
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 180_000 });
await page.mouse.click(800, 450).catch(() => {});
await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
console.log('[pilot] game ready');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Shared, survives logic reloads. */
const ctx = {
  page, sleep,
  G: (fn, a) => page.evaluate(fn, a),
  events: [], eventSeq: 0,
  event(kind, text, extra) {
    const e = { n: ++ctx.eventSeq, t: Date.now(), kind, text, ...(extra ?? {}) };
    ctx.events.push(e);
    if (ctx.events.length > 300) ctx.events.splice(0, ctx.events.length - 300);
    console.log(`[event] ${kind}: ${text}`);
  },
  goal: { type: 'idle' }, mem: {}, busy: false, lastError: null, shotDir: SHOT_DIR,
};

let logic = null;
let logicVersion = 0;
async function loadLogic() {
  const mod = await import(`${LOGIC}?v=${++logicVersion}`);
  logic = mod;
  await logic.init?.(ctx);
  console.log(`[pilot] logic v${logicVersion} loaded`);
}
await loadLogic();

// The autopilot clock: ~8 ticks a second, never overlapping, never fatal.
let ticking = false;
setInterval(async () => {
  if (ticking || ctx.busy || !logic?.tick) return;
  ticking = true;
  try { await logic.tick(ctx); ctx.lastError = null; }
  catch (e) {
    const msg = String(e?.message ?? e);
    if (msg !== ctx.lastError) console.log(`[pilot] tick error: ${msg}`);
    ctx.lastError = msg;
  } finally { ticking = false; }
}, 120);

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // Loopback is not a security boundary against the browser: any web page can
  // fire a "simple" POST at 127.0.0.1, and DNS rebinding can make it same-origin.
  // So: the Host must be our loopback address (no rebinding), and requests a
  // browser made for a page (Origin / Sec-Fetch-Site) are refused. curl and the
  // pause/resume scripts send neither.
  const host = String(req.headers.host ?? '');
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(403, { error: 'bad host' });
  if (req.headers.origin !== undefined || (req.headers['sec-fetch-site'] ?? 'none') !== 'none') {
    return send(403, { error: 'browser requests are not accepted' });
  }
  const body = async () => {
    let b = '';
    for await (const chunk of req) b += chunk;
    return JSON.parse(b || '{}');
  };
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/state') return send(200, await logic.state(ctx));
    if (req.method === 'GET' && url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(200, { next: ctx.eventSeq, events: ctx.events.filter((e) => e.n > since) });
    }
    if (req.method === 'GET' && url.pathname === '/shot') {
      const file = path.join(SHOT_DIR, `shot-${Date.now()}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
      return send(200, { path: file });
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      await loadLogic();
      return send(200, { version: logicVersion });
    }
    if (req.method === 'POST' && url.pathname === '/goal') {
      await logic.setGoal(ctx, await body());
      return send(200, { goal: ctx.goal, state: await logic.state(ctx) });
    }
    if (req.method === 'POST' && url.pathname === '/act') {
      if (ctx.busy) return send(409, { error: 'an action is still running' });
      const a = await body();
      ctx.busy = true;
      try {
        // Let a tick that is mid-flight finish before taking the keys.
        while (ticking) await sleep(20);
        console.log('[pilot] act', JSON.stringify(a));
        await logic.act(ctx, a);
      } finally { ctx.busy = false; }
      return send(200, await logic.state(ctx));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/producer/')) {
      await logic.producer(ctx, url.pathname.slice('/producer/'.length), await body());
      return send(200, await logic.state(ctx));
    }
    send(404, { error: 'GET /state /events /shot, POST /goal /act /reload /producer/*' });
  } catch (e) {
    send(500, { error: String(e?.message ?? e) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[pilot] API on http://127.0.0.1:${PORT}`));
page.on('close', () => { server.close(); process.exit(0); });
