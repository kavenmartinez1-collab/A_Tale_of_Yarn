import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  retries: 0,
  // One worker: specs share a single physical GPU — parallel heavy compute
  // (e.g. voice-loop Whisper) starves other specs' dispatches indefinitely.
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    // Real Chrome, not bundled Chromium: headless Chromium fails requestDevice
    // (Dawn can't load dxil.dll — see scripts/probe-adapter.mjs results).
    channel: 'chrome',
    launchOptions: {
      args: [
        // NOTE: '--enable-features=Vulkan --use-angle=vulkan' (inherited from
        // the parent repo) yields NO adapter headless on this machine; d3d11
        // works (see scripts/probe-adapter.mjs).
        '--enable-unsafe-webgpu',
        '--use-angle=d3d11',
      ],
    },
  },
  projects: [
    {
      name: 'chromium-webgpu',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    timeout: 30_000,
    reuseExistingServer: true,
  },
});
