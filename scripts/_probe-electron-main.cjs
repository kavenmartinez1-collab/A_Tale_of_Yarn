/**
 * Minimal Steam-shaped Electron wrapper for A Tale of Yarn.
 *
 * This is the proof, not the product: a BrowserWindow with WebGPU enabled,
 * loading the PRODUCTION build (vite preview serves dist/ — a shipped wrapper
 * would use a custom app:// protocol or an embedded static server, which is
 * standard practice for Electron games because ESM over bare file:// is
 * blocked by Chromium's null-origin CORS rules).
 */
const { app, BrowserWindow } = require('electron');

// The same switch the dev harnesses pass to Chrome. If Electron's Chromium
// has WebGPU on by default this is redundant and harmless.
app.commandLine.appendSwitch('enable-unsafe-webgpu');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  win.loadURL(process.env.GAME_URL || 'http://localhost:4173/game.html');
});

app.on('window-all-closed', () => app.quit());
