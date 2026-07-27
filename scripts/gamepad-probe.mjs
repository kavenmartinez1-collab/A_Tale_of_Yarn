/**
 * gamepad-probe.mjs — the two-minute manual test for the one input question
 * that no amount of code can answer.
 *
 *   node scripts/gamepad-probe.mjs            # opens both windows
 *   node scripts/gamepad-probe.mjs --chrome   # plain Chrome only
 *   node scripts/gamepad-probe.mjs --electron # the Electron wrapper only
 *
 * WHY THIS EXISTS. docs/PORTING.md §2.5: the browser Gamepad API is reported
 * dead under Steam Input on Chromium 114+ — electron#45989 names Electron
 * 26.6.10 as the last known working version, and a Construct developer
 * reproduced it on Deck hardware with "no gamepads work at all — not even the
 * steamdeck's own buttons". Electron 43 is Chromium 150. If that reproduces
 * here, `src/game/input/gamepad.ts` is dead code under Steam and the input path
 * has to become native Steam Input actions read in the main process and
 * forwarded over the `steamBridge` IPC seam — a design decision, not a bug fix,
 * and one worth making in week one.
 *
 * It needs a physical controller and a running Steam client, so it is yours,
 * not the agent's.
 *
 * ─── HOW TO RUN IT ──────────────────────────────────────────────────────────
 *
 * Test 1 — baseline, Steam NOT running.
 *   1. Fully exit Steam (tray icon → Exit, not just close the window).
 *   2. Plug in the controller.
 *   3. `node scripts/gamepad-probe.mjs`
 *   4. Press a face button in EACH window (Chromium will not report a pad
 *      until it sees one button press — that is spec, not a bug).
 *   5. Both windows should say GAMEPAD DETECTED and move as you move sticks.
 *      If they do not, the problem is the pad or the driver, not Steam.
 *
 * Test 2 — the real question, Steam running with Steam Input active.
 *   1. Start Steam.
 *   2. Steam → Library → Add a Game → Add a Non-Steam Game → Browse to
 *        dist-steam\A Tale of Yarn.exe   (build it: node scripts/pack-steam.mjs)
 *      This matters: Steam Input only hooks processes STARTED BY Steam.
 *      Merely having Steam open is not the same test.
 *   3. In that shortcut's Properties → Controller, set "Enable Steam Input".
 *   4. Launch it from Steam, and separately run
 *        node scripts/gamepad-probe.mjs --chrome
 *      so you have a non-Steam control running at the same time.
 *   5. Compare. The failure signature from the bug reports is: the pad works in
 *      plain Chrome and reports NOTHING in the Steam-launched window.
 *
 * Report back four things: whether each window says GAMEPAD DETECTED, the `id`
 * string each reports, whether `mapping` is "standard", and whether the axes
 * move. Anything other than "both detected, both standard, both moving" means
 * the native Steam Input path is required.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(os.tmpdir(), 'yarn-gamepad-probe');
fs.mkdirSync(WORK, { recursive: true });

const args = process.argv.slice(2);
const wantChrome = args.includes('--chrome') || (!args.includes('--electron'));
const wantElectron = args.includes('--electron') || (!args.includes('--chrome'));

// ─── The page ────────────────────────────────────────────────────────────────

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Gamepad probe</title>
<style>
  body { margin:0; background:#0a0e14; color:#cdd6e4;
         font:14px/1.5 Consolas,monospace; padding:16px; }
  h1 { font-size:16px; margin:0 0 4px; color:#8ab4f8; }
  .host { color:#7d8799; margin-bottom:12px; }
  #verdict { font-size:26px; font-weight:bold; padding:12px; border-radius:6px;
             margin-bottom:12px; }
  .yes { background:#123d1e; color:#7ee08a; }
  .no  { background:#3d1212; color:#f08a8a; }
  pre { background:#111721; padding:12px; border-radius:6px; white-space:pre-wrap;
        margin:0 0 12px; }
  .bar { height:14px; background:#1c2432; border-radius:7px; position:relative;
         margin:3px 0 8px; }
  .bar i { position:absolute; top:0; bottom:0; width:3px; background:#8ab4f8;
           border-radius:2px; }
  button { background:#1c2432; color:#cdd6e4; border:1px solid #2f3a4d;
           padding:8px 14px; border-radius:5px; cursor:pointer; font:inherit; }
</style></head><body>
<h1>A Tale of Yarn — Gamepad probe</h1>
<div class="host" id="host"></div>
<div id="verdict" class="no">PRESS ANY BUTTON ON THE CONTROLLER</div>
<pre id="out">waiting…</pre>
<div id="axes"></div>
<button onclick="navigator.clipboard.writeText(document.getElementById('out').textContent)">
  Copy report
</button>
<script>
document.getElementById('host').textContent =
  navigator.userAgent.match(/Electron\\/[\\d.]+/) ? 'ELECTRON WRAPPER — ' + navigator.userAgent
                                                 : 'PLAIN BROWSER — ' + navigator.userAgent;

let sawAny = false;
let maxAxis = 0;
let pressCount = 0;

addEventListener('gamepadconnected', (e) => {
  console.log('[probe] gamepadconnected: index=' + e.gamepad.index
    + ' id=' + JSON.stringify(e.gamepad.id) + ' mapping=' + e.gamepad.mapping);
});
addEventListener('gamepaddisconnected', (e) => {
  console.log('[probe] gamepaddisconnected: index=' + e.gamepad.index);
});

let lastLog = 0;
function frame(t) {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
  const live = pads.filter(Boolean);
  const v = document.getElementById('verdict');
  const out = document.getElementById('out');

  if (live.length === 0) {
    v.className = 'no';
    v.textContent = sawAny ? 'GAMEPAD LOST' : 'NO GAMEPAD — PRESS ANY BUTTON ON IT';
    out.textContent = 'navigator.getGamepads() → ' + pads.length
      + ' slot(s), 0 connected\\n\\n'
      + 'getGamepads present: ' + (!!navigator.getGamepads) + '\\n'
      + 'If this stays empty after pressing buttons AND a plain-Chrome window\\n'
      + 'shows the pad, that is the Steam Input / Chromium 114+ failure\\n'
      + '(docs/PORTING.md §2.5).';
  } else {
    sawAny = true;
    v.className = 'yes';
    v.textContent = 'GAMEPAD DETECTED';
    const lines = live.map((g) => {
      const pressed = [...g.buttons].map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
      pressCount = Math.max(pressCount, pressed.length);
      maxAxis = Math.max(maxAxis, ...g.axes.map(Math.abs));
      return 'index    : ' + g.index + '\\n'
        + 'id       : ' + g.id + '\\n'
        + 'mapping  : ' + g.mapping + (g.mapping === 'standard' ? ' (OK)' : ' (NOT standard!)') + '\\n'
        + 'connected: ' + g.connected + '\\n'
        + 'axes     : ' + g.axes.map((a) => a.toFixed(3).padStart(6)).join(' ') + '\\n'
        + 'buttons  : ' + g.buttons.length + ' total, pressed now: ['
          + pressed.join(', ') + ']\\n'
        + 'timestamp: ' + g.timestamp.toFixed(1);
    });
    out.textContent = lines.join('\\n\\n')
      + '\\n\\n--- session ---\\n'
      + 'max |axis| seen : ' + maxAxis.toFixed(3)
        + (maxAxis > 0.5 ? '  (sticks ARE moving)' : '  (move the sticks)') + '\\n'
      + 'max buttons down: ' + pressCount;

    document.getElementById('axes').innerHTML = live[0].axes.map((a) =>
      '<div class="bar"><i style="left:calc(' + ((a + 1) / 2 * 100) + '% - 1px)"></i></div>'
    ).join('');
  }

  // Mirror to the terminal once a second so the Electron run leaves a
  // transcript, not just a window someone has to describe.
  if (t - lastLog > 1000) {
    lastLog = t;
    console.log('[probe] pads=' + live.length
      + (live[0] ? ' id=' + JSON.stringify(live[0].id)
        + ' mapping=' + live[0].mapping
        + ' axes=' + live[0].axes.map((a) => a.toFixed(2)).join(',') : ''));
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`;

const pagePath = path.join(WORK, 'gamepad-probe.html');
fs.writeFileSync(pagePath, PAGE, 'utf8');

// ─── Electron launcher ───────────────────────────────────────────────────────
//
// Deliberately uses THE SAME Chromium switches as app/steam/main.cjs. The
// overlay switches (--in-process-gpu, --disable-direct-composition) change how
// the process talks to the GPU and the window manager, so a probe without them
// would not be testing the thing we ship.

const MAIN = path.join(WORK, 'probe-main.cjs');
fs.writeFileSync(MAIN, `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-direct-composition');
app.commandLine.appendSwitch('force-high-performance-gpu');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 820, height: 720,
    webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log(msg));
  win.loadFile(${JSON.stringify(pagePath)});
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');

// ─── Chrome launcher ─────────────────────────────────────────────────────────

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

console.log('Gamepad probe — see the header of this file for the full procedure.\n');
console.log(`page: ${pagePath}\n`);

if (wantChrome) {
  const chrome = findChrome();
  if (chrome) {
    console.log(`[chrome]   ${chrome}`);
    spawn(chrome, ['--new-window', `file:///${pagePath.replace(/\\/g, '/')}`],
      { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log('[chrome]   not found — open this file in a browser yourself:');
    console.log(`           file:///${pagePath.replace(/\\/g, '/')}`);
  }
}

if (wantElectron) {
  const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electron)) {
    console.log('[electron] node_modules/electron not found — run npm install');
  } else {
    console.log(`[electron] ${electron}`);
    const child = spawn(electron, [MAIN], { cwd: REPO, stdio: 'inherit' });
    child.on('exit', (code) => {
      console.log(`\n[electron] exited (${code})`);
      console.log('Report: did BOTH windows say GAMEPAD DETECTED, with mapping "standard"');
      console.log('and moving axes? If only the plain-Chrome one did, PORTING §2.5');
      console.log('reproduces and the input path must go native through Steam Input.');
    });
  }
}
