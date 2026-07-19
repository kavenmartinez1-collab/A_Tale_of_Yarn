/**
 * M0 — Director model coherence gate, automated. Requires `npm run dev`.
 *
 * Launches headless Chrome (real GPU), imports the engine + director modules
 * in-page through vite, loads the real model once, then runs:
 *   (a) a plain-chat sanity prompt (coherent? stops at EOS?)
 *   (b) the 5 seed-derived director briefs through the REAL retry loop
 *       (generateSpecWithRetries → extract → validateSpec → retry ≤2)
 *
 * Pass bar (plan M0): ≥3/5 trials produce a validating spec with ≤1 retry
 * (source 'llm', attempts ≤ 2).
 *
 * Run: npx tsx scripts/m0-coherence.mts
 */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:5173';
const SEED = 1337; // WORLD_SEED, src/game/main.ts:63

// dcx, dcz, entranceY — same cells as scripts/m0-director-prompts.txt.
const CELLS: [number, number, number][] = [
  [0, 1, 25], [2, -3, 12], [-1, 4, 3], [5, 5, 30], [-4, -2, 9],
];

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});

try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  // Blank page on the vite origin: secure context + module imports resolve.
  await page.route('**/__m0blank.html', (r) => r.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  // tsx/esbuild injects __name() helpers into the serialized evaluate fn.
  await page.addInitScript('globalThis.__name = (f) => f;');
  await page.goto(`${BASE}/__m0blank.html`);

  const result = await page.evaluate(async ({ seed, cells }) => {
    const log = (m: string) => console.log(`[m0] ${m}`);
    const { createGGUFInferenceSession } = await import('/src/engine/gguf-session.ts');
    const { useLocalCache } = await import('/src/model/hf-hub.ts');
    useLocalCache(); // local/ repo lives on the dev server, not the HF CDN
    const { buildBrief } = await import('/src/game/director/director-prompt.ts');
    const { generateSpecWithRetries, DIRECTOR_SAMPLING } =
      await import('/src/game/director/director-llm.ts');

    log('loading model…');
    const t0 = performance.now();
    let lastStatus = '';
    const session = await createGGUFInferenceSession({
      repo: 'local/flux2-te-qwen3-4b-q4_k_m',
      ggufFile: 'flux2-te-qwen3-4b-q4_k_m.gguf',
      onStatus: (s: string) => { if (s !== lastStatus) { lastStatus = s; log(`status: ${s}`); } },
    });
    const loadSecs = (performance.now() - t0) / 1000;
    log(`model loaded in ${loadSecs.toFixed(1)}s`);

    const chat = async (messages: { role: string; content: string }[]) => {
      const h = session.chat(messages as never, DIRECTOR_SAMPLING, undefined,
        { enableThinking: false, emptyThink: true });
      const r = await h.result;
      return { text: r.text, stopReason: r.stopReason };
    };

    // (a) plain-chat sanity
    const sh = session.chat(
      [{ role: 'user', content: 'Name three chess openings, one per line.' }] as never,
      { temperature: 0, maxNewTokens: 120 }, undefined,
      { enableThinking: false, emptyThink: true });
    const sanity = await sh.result;
    log(`sanity stop=${sanity.stopReason}: ${sanity.text.slice(0, 120).replace(/\n/g, ' | ')}`);

    // (b) director trials through the real retry loop
    const trials = [];
    for (const [dcx, dcz, y] of cells) {
      const brief = buildBrief(seed, dcx, dcz, y);
      const ts = performance.now();
      const r = await generateSpecWithRetries(chat, brief);
      const secs = (performance.now() - ts) / 1000;
      trials.push({
        cell: `${dcx},${dcz}`, theme: brief.themeHint, flavor: brief.flavorWords,
        source: r.source, attempts: r.attempts, errors: r.errors ?? null,
        chatError: r.chatError ?? false, name: r.spec.name, spec: r.spec,
        secs: Number(secs.toFixed(1)),
      });
      log(`cell ${dcx},${dcz}: ${r.source} (${r.attempts} attempt${r.attempts > 1 ? 's' : ''}, ${secs.toFixed(0)}s) — "${r.spec.name}"`);
    }
    return { loadSecs, sanity: { text: sanity.text, stopReason: sanity.stopReason }, trials };
  }, { seed: SEED, cells: CELLS });

  console.log('\n=== M0 RESULTS ===');
  console.log(`model load: ${result.loadSecs.toFixed(1)}s`);
  console.log(`\n--- sanity (stop=${result.sanity.stopReason}) ---\n${result.sanity.text}\n`);
  let passCount = 0;
  for (const t of result.trials) {
    const ok = t.source === 'llm' && t.attempts <= 2;
    if (ok) passCount++;
    console.log(`--- cell ${t.cell} theme=${t.theme} flavor=[${t.flavor}] → ${ok ? 'PASS' : 'FAIL'} (${t.source}, attempts=${t.attempts}, ${t.secs}s)`);
    if (t.errors) console.log(`    last errors: ${JSON.stringify(t.errors)}`);
    console.log(`    ${JSON.stringify(t.spec)}`);
  }
  console.log(`\nM0 pass bar: ${passCount}/5 valid with ≤1 retry (need ≥3) → ${passCount >= 3 ? 'PASS' : 'FAIL'}`);
  process.exitCode = passCount >= 3 ? 0 : 1;
} finally {
  await browser.close();
}
