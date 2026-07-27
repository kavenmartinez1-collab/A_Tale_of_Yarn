/**
 * A Tale of Yarn — Steam (Windows) main process.
 *
 * Boots the built game inside Electron 43 (Chromium 150) against a loopback
 * origin that also serves the model weights from the depot. This is the
 * productionised form of scripts/_probe-electron-main.cjs, which proved the
 * path; everything here that looks like a magic constant traces to a measured
 * claim in docs/PORTING.md and carries the section number.
 *
 * Layout it expects when packaged (see scripts/pack-steam.mjs):
 *
 *   <app>/A Tale of Yarn.exe
 *   <app>/steam_appid.txt
 *   <app>/resources/app/            ← this file
 *   <app>/resources/dist/           ← the built game
 *   <app>/resources/models/         ← GGUF weights + tokenizer
 *
 * Run from the dev tree with:  npx electron app/steam/main.cjs
 */
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { createLocalServer } = require('./local-server.cjs');
const steam = require('./steam.cjs');

// Valve's public Spacewar test app id. Replace with the real app id at partner
// setup — it goes here AND in steam_appid.txt next to the executable.
const STEAM_APP_ID = Number(process.env.YARN_STEAM_APPID || 480);

// ─── Roots ───────────────────────────────────────────────────────────────────

/** Packaged: resources/{dist,models}. Dev tree: repo root. */
function resolveRoots() {
  if (app.isPackaged) {
    return {
      distDir: path.join(process.resourcesPath, 'dist'),
      modelsDir: process.env.YARN_MODELS_DIR || path.join(process.resourcesPath, 'models'),
    };
  }
  const repo = path.resolve(__dirname, '..', '..');
  return {
    distDir: process.env.YARN_DIST_DIR || path.join(repo, 'dist'),
    modelsDir: process.env.YARN_MODELS_DIR || path.join(repo, 'models'),
  };
}

// ─── Chromium switches — all three are load-bearing ──────────────────────────

// §2.4 + §2.9(4): --in-process-gpu and --disable-direct-composition are what
// let the Steam overlay hook D3D device creation in a Chromium. WebGPU survives
// both [MEASURED-HERE]. Applied through steam.cjs so steamworks.js's own
// electronEnableSteamOverlay() and ours cannot both append them.
steam.applyOverlaySwitches(app);

// §2.9(5): on dual-GPU laptops Chromium ignores `powerPreference` and runs on
// the iGPU — a documented cause of "poor reviews from players". Fixed upstream
// in Chromium 145+; we are on 150, so the switch is available and cheap.
app.commandLine.appendSwitch('force-high-performance-gpu');

// NOT --enable-unsafe-webgpu. §2.1: Electron 43 reports webgpu:enabled with no
// flags at all on Windows/D3D12, so the switch in the old probe was redundant —
// and shipping a flag named "unsafe" invites questions and can in principle
// enable non-conformant behaviour we do not want.

// A game must keep simulating and painting when it loses focus (an alt-tab
// during a dungeon fight must not stall the sim clock).
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ─── Network audit / offline enforcement ─────────────────────────────────────
//
// Always counts external requests; only cancels them when YARN_BLOCK_EXTERNAL=1.
// Same instrumentation serves both halves of the offline proof: a control run
// (weights missing → CDN attempts observed) and the real run (zero attempts).

const netAudit = { attempted: 0, blocked: 0, urls: [] };

function installNetworkAudit(localOrigin) {
  const enforce = process.env.YARN_BLOCK_EXTERNAL === '1';
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const internal = url.startsWith(localOrigin) || url.startsWith('devtools:')
      || url.startsWith('chrome-extension:') || url.startsWith('blob:')
      || url.startsWith('data:') || url.startsWith('file:');
    if (internal) return callback({ cancel: false });
    netAudit.attempted++;
    if (netAudit.urls.length < 50) netAudit.urls.push(url);
    if (enforce) {
      netAudit.blocked++;
      console.log(`[net-block] BLOCKED ${url}`);
      return callback({ cancel: true });
    }
    console.log(`[net-audit] EXTERNAL ${url}`);
    return callback({ cancel: false });
  });
}

// ─── Permissions ─────────────────────────────────────────────────────────────
//
// Electron's DEFAULT is to grant every permission a renderer asks for, with no
// prompt. That was survivable while the game asked for nothing; push-to-talk
// asks for the microphone, so the default is now a real answer to a real
// question and it is the wrong one — it would also hand out the camera,
// geolocation, notifications and the rest to any code that ended up running in
// this window, including a 1.7B model's output rendered into the DOM.
//
// So: deny by default, allow `media` — audio only — and only for our own
// loopback origin. There is nothing else in this app that legitimately needs a
// device.
//
// Both handlers are installed on purpose. `setPermissionRequestHandler` covers
// the asking path (`getUserMedia`), `setPermissionCheckHandler` the synchronous
// query path (`navigator.permissions.query`, and Chromium's own internal
// checks); with only the first, `enumerateDevices` reports empty labels and
// some capture paths fail before ever raising a request.

function installPermissions(localOrigin) {
  const sameOrigin = (url) => {
    if (!url) return false;
    try { return new URL(url).origin === localOrigin; } catch { return false; }
  };

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    // `requestingUrl` is absent on some internal requests; fall back to the
    // frame's own URL rather than trusting an empty string.
    const origin = details?.requestingUrl || wc?.getURL();
    const ok = permission === 'media'
      && sameOrigin(origin)
      // `mediaTypes` is absent for a plain getUserMedia({audio:true}) on some
      // Electron versions, so an omitted list is treated as audio-only. A list
      // that names video is refused: nothing here wants a camera.
      && !(details?.mediaTypes ?? []).includes('video');
    console.log(`[perm] ${ok ? 'GRANT' : 'DENY '} ${permission}`
      + `${details?.mediaTypes ? ` [${details.mediaTypes}]` : ''} ← ${origin || 'unknown'}`);
    callback(ok);
  });

  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission !== 'media') return false;
    if (!sameOrigin(requestingOrigin)) return false;
    return details?.mediaType !== 'video';
  });

  // Device-level gate for `navigator.mediaDevices.selectAudioOutput` and
  // friends. Nothing in the game calls them; refuse rather than inherit a
  // default that may change between Electron majors.
  session.defaultSession.setDevicePermissionHandler(() => false);
}

// ─── Window ──────────────────────────────────────────────────────────────────

let win = null;

function createWindow(startUrl) {
  const startFullscreen = process.env.YARN_FULLSCREEN === '1'
    || process.argv.includes('--start-fullscreen');

  win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    fullscreen: startFullscreen,
    backgroundColor: '#0a0e14', // matches game.html so there is no white flash
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed. A sandboxed preload still gets `contextBridge` and
      // `ipcRenderer`, which is all preload.cjs uses — and this renderer runs
      // a 1.7B model's output through the DOM, so the OS-level sandbox is
      // worth more here than the convenience of full Node in the preload.
      sandbox: true,
      // A game must keep running while unfocused.
      backgroundThrottling: false,
      // devtools only outside a packaged build — see the F12 handler below.
      devTools: !app.isPackaged || process.env.YARN_DEVTOOLS === '1',
    },
  });

  // No File/Edit/View menu on a game window.
  Menu.setApplicationMenu(null);

  // The app is a single page against a single origin. Anything that tries to
  // navigate or open a window elsewhere is either a bug or hostile; send real
  // external links to the system browser and refuse everything else.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(startUrl.split('/game.html')[0])) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // F11 / Alt+Enter toggle fullscreen. Escape is NOT bound — the game uses it
  // to pause, and stealing it would break the pause harness.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const toggle = input.key === 'F11' || (input.alt && input.key === 'Enter');
    if (toggle) {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12' && (!app.isPackaged || process.env.YARN_DEVTOOLS === '1')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // --in-process-gpu means a GPU/driver fault takes the whole process with it
  // (§2.4). Nothing here can prevent that; logging it is the difference between
  // a diagnosable crash report and a silent disappearance.
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`[fatal] renderer gone: ${d.reason} (exitCode ${d.exitCode})`);
  });
  app.on('child-process-gone', (_e, d) => {
    console.error(`[fatal] child process gone: ${d.type}/${d.reason}`);
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadURL(startUrl);
  return win;
}

// ─── IPC seam ────────────────────────────────────────────────────────────────

function installIpc() {
  ipcMain.handle('steam:status', () => steam.status());
  ipcMain.handle('steam:floatingKeyboard', (_e, rect) => steam.showFloatingKeyboard(rect || {}));
  ipcMain.handle('steam:textInput', (_e, opts) => steam.showGamepadTextInput(opts || {}));
  ipcMain.handle('window:setFullscreen', (_e, on) => { if (win) win.setFullScreen(on); return true; });
  ipcMain.handle('window:isFullscreen', () => (win ? win.isFullScreen() : false));
  ipcMain.handle('net:audit', () => ({ ...netAudit, urls: netAudit.urls.slice() }));
  ipcMain.handle('server:stats', () => (serverHandle ? { ...serverHandle.stats } : null));
}

// ─── Boot ────────────────────────────────────────────────────────────────────

let serverHandle = null;

app.whenReady().then(async () => {
  const { distDir, modelsDir } = resolveRoots();

  if (!fs.existsSync(path.join(distDir, 'game.html'))) {
    console.error(`[fatal] no game.html under ${distDir} — run \`npm run build\` (or repack).`);
    app.quit();
    return;
  }
  if (!fs.existsSync(modelsDir)) {
    // Not fatal: the game boots and plays without the LLM, it just cannot talk.
    // Being loud here beats a mystery 404 storm an hour into a playtest.
    console.warn(`[warn] no models dir at ${modelsDir} — NPC dialogue will fail to load.`);
  }

  serverHandle = await createLocalServer({
    distDir,
    modelsDir,
    log: (line) => console.log(`[weights] ${line}`),
  });
  console.log(`[server] serving dist=${distDir} models=${modelsDir} on ${serverHandle.origin}`);

  installNetworkAudit(serverHandle.origin);
  installPermissions(serverHandle.origin);
  installIpc();

  // Steam init is deliberately after the server and before the window: it must
  // not be able to delay or prevent the game appearing.
  steam.init(STEAM_APP_ID);

  createWindow(`${serverHandle.origin}/game.html${process.env.YARN_GAME_QUERY || ''}`);
});

app.on('window-all-closed', () => app.quit());

app.on('quit', () => {
  if (serverHandle) {
    const s = serverHandle.stats;
    console.log(`[server] ${s.requests} requests, ${s.ranges} ranges, `
      + `${(s.bytesServed / 1048576).toFixed(1)} MB served, ${s.notFound} 404s`);
    serverHandle.close();
  }
  console.log(`[net-audit] external attempted=${netAudit.attempted} blocked=${netAudit.blocked}`);
});
