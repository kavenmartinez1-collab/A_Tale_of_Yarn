// Minimal WebGPU adapter probe — no dev server needed (about:blank).
// Usage: node scripts/probe-adapter.mjs
import { chromium } from '@playwright/test';

const COMBOS = [
  ['chromium vulkan', undefined, ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan']],
  ['chromium d3d11', undefined, ['--enable-unsafe-webgpu', '--use-angle=d3d11']],
  ['chrome vulkan', 'chrome', ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan']],
  ['chrome d3d11', 'chrome', ['--enable-unsafe-webgpu', '--use-angle=d3d11']],
  ['chrome bare', 'chrome', ['--enable-unsafe-webgpu']],
];

for (const [name, channel, args] of COMBOS) {
  try {
    const browser = await chromium.launch({ channel, headless: true, args });
    const page = await browser.newPage();
    // localhost is a secure context; fulfill via route so no server is needed.
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html><body>probe</body></html>' }));
    await page.goto('http://127.0.0.1:59999/probe.html');
    const result = await page.evaluate(async () => {
      if (!navigator.gpu) return 'no navigator.gpu';
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!a) return 'no adapter';
      const info = a.info ?? {};
      try {
        const d = await a.requestDevice();
        d.destroy();
        return `DEVICE OK: ${info.vendor} ${info.architecture} ${info.description || ''}`;
      } catch (e) {
        return `adapter ok, requestDevice FAILED: ${String(e).slice(0, 120)}`;
      }
    });
    console.log(`[${name}] ${result}`);
    await browser.close();
  } catch (e) {
    console.log(`[${name}] LAUNCH ERROR: ${e.message.split('\n')[0]}`);
  }
}
