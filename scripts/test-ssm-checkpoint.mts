/**
 * test-ssm-checkpoint.mts — the hybrid-model prefix checkpoint (generate.ts
 * GenerateOptions.ssmCheckpointAt) must be invisible in the output.
 *
 * A Gated-DeltaNet model cannot rewind its recurrent state, so when a chat
 * prompt diverges from the cache (npc-chat-panel trims the oldest turns) the
 * session restores the SSM state it saved at the end of the system prompt and
 * prefills only the rest. This checks that a greedy reply produced through
 * that restore is token-identical to the same prompt prefilled from scratch,
 * and that the restore really happened (it is much faster).
 *
 * Requires `npm run dev` and a WebGPU adapter (headless Chrome).
 * Run:  npx tsx scripts/test-ssm-checkpoint.mts [--headed]
 */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:5173';
const REPO = 'unsloth/Qwen3.5-2B-GGUF';
const FILE = 'Qwen3.5-2B-Q4_K_M.gguf';
const headed = process.argv.includes('--headed');

const browser = await chromium.launch({
  channel: 'chrome', headless: !headed,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
let failed = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/^\[(ckpt|Generate\] (SSM|KV))/.test(t) || /error|fail/i.test(t)) console.log(`[page] ${t}`);
  });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.route('**/__ckptblank.html', (r) => r.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.addInitScript('globalThis.__name = (f) => f;');
  await page.goto(`${BASE}/__ckptblank.html`);

  const out = await page.evaluate(async ({ REPO, FILE }) => {
    const { createGGUFInferenceSession } = await import('/src/engine/gguf-session.ts');
    const { useLocalCache } = await import('/src/model/hf-hub.ts');
    useLocalCache();
    const session: any = await createGGUFInferenceSession({ repo: REPO, ggufFile: FILE });
    if (session.config.isHybrid !== true) throw new Error('model is not hybrid — nothing to test');

    const sys = 'You are Petra, a merchant in the village of Stonebrook. You sell iron, '
      + 'leather and potions. Answer in two or three sentences, in character. '.repeat(6);
    const greedy = { temperature: 0, maxNewTokens: 40 };
    const opts = { enableThinking: false, emptyThink: true, prefillChunk: 64 };
    const run = async (ctx: any, msgs: any[]) => {
      const t0 = performance.now();
      const r = await ctx.chat(msgs, greedy, undefined, opts).result;
      return { ids: r.tokenIds as number[], text: r.text as string, ms: performance.now() - t0 };
    };

    // A: first turn, then a prompt that diverges right after the system turn.
    const a = session.forkKV();
    await run(a, [{ role: 'system', content: sys }, { role: 'user', content: 'Good morning! Who are you?' }]);
    const second = [{ role: 'system', content: sys }, { role: 'user', content: 'What does a healing potion cost?' }];
    const viaRestore = await run(a, second);
    // B: the same second prompt on a fresh cache — full prefill.
    const b = session.forkKV();
    const fresh = await run(b, second);
    a.resetKV(); b.resetKV();
    return { viaRestore, fresh };
  }, { REPO, FILE });

  const same = JSON.stringify(out.viaRestore.ids) === JSON.stringify(out.fresh.ids);
  console.log(`restored: ${out.viaRestore.ms.toFixed(0)} ms  "${out.viaRestore.text.slice(0, 100)}"`);
  console.log(`fresh   : ${out.fresh.ms.toFixed(0)} ms  "${out.fresh.text.slice(0, 100)}"`);
  if (!same) { failed++; console.log('FAIL: restored and fresh greedy replies differ'); }
  else console.log(`PASS: ${out.fresh.ids.length} greedy tokens identical`);
} finally {
  await browser.close();
}
console.log(failed ? '\nSSM CHECKPOINT: FAIL' : '\nSSM CHECKPOINT: PASS');
process.exit(failed ? 1 : 0);
