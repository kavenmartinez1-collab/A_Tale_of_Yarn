/**
 * test-director-live.mts — the Dungeon Director against the REAL model.
 * Requires `npm run dev`.
 *
 * test-director.mts covers the prompt/extract/retry/store logic with canned
 * transcripts; this runs the shipped GGUF through the game's own session with
 * the Director's exact sampling and template options, for a spread of seeds
 * and dungeon locations, and reports how often the model's spec validates
 * (source 'llm') versus falling back to FALLBACK_SPEC — the number that
 * decides whether players ever see a generated dungeon. A model swap must
 * not quietly turn the Director into a fixture server.
 *
 * Run:  npx tsx scripts/test-director-live.mts [--model=qwen35|qwen] [--n=8]
 *       [--temp=0.7] [--topk=20] [--topp=0.8] [--pp=0] [--emptythink=0|1]
 *       (override DIRECTOR_SAMPLING / the template for A/B runs)
 */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:5173';
const argModel = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] ?? 'qwen35';
const n = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 8);
const headed = process.argv.includes('--headed');
const argNum = (k: string) => {
  const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  return v === undefined ? undefined : Number(v);
};
const override: Record<string, number> = {};
for (const [k, key] of [['temp', 'temperature'], ['topk', 'topK'], ['topp', 'topP'], ['pp', 'presencePenalty']] as const) {
  if (argNum(k) !== undefined) override[key] = argNum(k)!;
}
const emptyThink = argNum('emptythink') === undefined ? true : argNum('emptythink') === 1;

const MODELS: Record<string, { repo: string; file: string }> = {
  qwen35: { repo: 'unsloth/Qwen3.5-2B-GGUF', file: 'Qwen3.5-2B-Q4_K_M.gguf' },
  qwen: { repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf' },
};
const model = MODELS[argModel];
if (model === undefined) throw new Error(`unknown --model=${argModel}`);
/** At least this share of briefs must produce a valid spec from the model. */
const MIN_LLM_RATE = 0.75;

const browser = await chromium.launch({
  channel: 'chrome', headless: !headed,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
let ok = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/^\[(director-live|Tokenizer|GGUF)\]/.test(t) || /error|Error|fail/i.test(t)) console.log(`[page] ${t}`);
  });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.route('**/__dirblank.html', (r) => r.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.addInitScript('globalThis.__name = (f) => f;');
  await page.goto(`${BASE}/__dirblank.html`);

  const out = await page.evaluate(async ({ model, n, override, emptyThink }) => {
    const log = (m: string) => console.log(`[director-live] ${m}`);
    const { createGGUFInferenceSession } = await import('/src/engine/gguf-session.ts');
    const { useLocalCache } = await import('/src/model/hf-hub.ts');
    useLocalCache();
    const { buildBrief } = await import('/src/game/director/director-prompt.ts');
    const { generateSpecWithRetries, DIRECTOR_SAMPLING } =
      await import('/src/game/director/director-llm.ts');

    const session = await createGGUFInferenceSession({ repo: model.repo, ggufFile: model.file });
    const ctx: any = session.forkKV !== undefined ? session.forkKV() : session;
    // Exactly director.ts's chat adapter options.
    const chat = async (messages: any[]) => {
      const r = await ctx.chat(messages, { ...DIRECTOR_SAMPLING, ...override }, undefined,
        { enableThinking: false, emptyThink, prefillChunk: 64 }).result;
      return { text: r.text, stopReason: r.stopReason };
    };
    const rows: Array<{ seed: number; source: string; attempts: number; ms: number; name?: string; rooms?: number; errors?: string[]; json?: string }> = [];
    for (let i = 0; i < n; i++) {
      const seed = 1000 + i * 7919;
      const brief = buildBrief(seed, i - 3, 2 * i - 5, 4 + (i % 5) * 9);
      const t0 = performance.now();
      const r = await generateSpecWithRetries(chat, brief);
      const ms = performance.now() - t0;
      const spec: any = r.spec;
      rows.push({
        seed, source: r.source, attempts: r.attempts, ms,
        name: r.source === 'llm' ? spec.name : undefined,
        rooms: r.source === 'llm' ? spec.rooms?.length : undefined,
        errors: r.errors,
        json: r.source === 'llm' ? JSON.stringify(spec) : undefined,
      });
      log(`seed ${seed}: ${r.source} after ${r.attempts} attempt(s), ${(ms / 1000).toFixed(1)}s`
        + (r.source === 'llm' ? ` — "${spec.name}", ${spec.rooms?.length} rooms` : ` — ${r.errors?.join('; ')}`));
    }
    session.destroy();
    return rows;
  }, { model, n, override, emptyThink });

  const llm = out.filter((r) => r.source === 'llm').length;
  const firstTry = out.filter((r) => r.source === 'llm' && r.attempts === 1).length;
  const avg = out.reduce((s, r) => s + r.ms, 0) / out.length / 1000;
  console.log(`\nmodel ${argModel} (${model.repo})  overrides ${JSON.stringify(override)} emptyThink ${emptyThink}`);
  console.log(`valid specs from the model: ${llm}/${out.length} (first try ${firstTry}), avg ${avg.toFixed(1)}s per dungeon`);
  // A few specs verbatim, so a model swap can be judged on content too.
  for (const r of out.filter((x) => x.json !== undefined).slice(0, 3)) {
    console.log(`\nspec (seed ${r.seed}): ${r.json!.length > 700 ? `${r.json!.slice(0, 700)}…` : r.json}`);
  }
  ok = llm / out.length >= MIN_LLM_RATE;
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'} (need >= ${MIN_LLM_RATE * 100}% valid)`);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
