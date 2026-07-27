/**
 * Does push-to-talk actually understand this game's proper nouns?
 *
 *   npx tsx scripts/test-voice-accuracy.mts            # both arms, both passes
 *   npx tsx scripts/test-voice-accuracy.mts --no-bias  # skip the biased pass
 *   npx tsx scripts/test-voice-accuracy.mts --only=6   # one utterance
 *
 * ## What is measured
 *
 * `scripts/gen-voice-fixture.mts` synthesises 18 offline, deterministic 16 kHz
 * WAVs through the vendored Piper voice, split into two arms:
 *
 *   control — plain English, no game vocabulary. If this arm degrades, the
 *             HARNESS is broken, not the vocabulary. It is the only reason the
 *             game arm's number means anything.
 *   game    — real proper nouns from the real tables (Greenholm, Castle
 *             Vhaeron, Tintreach, NPC names, dungeon names).
 *
 * Each arm runs twice: once as Whisper ships, once with the `<|startofprev|>`
 * vocabulary prompt from src/game/voice/vocabulary.ts. Word error rate and
 * per-noun recall are reported for all four cells.
 *
 * ## Why this runs in Node and the latency test does not
 *
 * The game runs these graphs on ORT **wasm** in a worker; this harness runs the
 * same int8 files on onnxruntime-node. The kernels and the weights are the
 * same, so ACCURACY transfers and the iteration loop is seconds instead of
 * minutes. LATENCY does not transfer and is deliberately not claimed here —
 * that is measured in the packaged app by scripts/steam-pack-check.mjs.
 *
 * ## Sanity of the instrument
 *
 * Four harnesses in this project lied to their authors before being fixed, so
 * this one tests itself before it reports anything (`--selftest` runs only
 * these):
 *
 *   - a deliberately WRONG reference must score a non-zero WER;
 *   - an identical pair must score exactly zero;
 *   - silence must NOT transcribe to any reference (base.en emits " you",
 *     which is asserted explicitly — a transcription test that passes on
 *     silence is measuring nothing);
 *   - every fixture WAV must really be 16 kHz mono, because Whisper's frontend
 *     will happily accept 22 kHz samples and quietly transcribe a chipmunk;
 *   - the proper-noun tables copied into vocabulary.ts must still match the
 *     tables they were copied FROM. That copy exists because the sources do
 *     not export them; this is what stops it rotting.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWavHeader } from './gen-voice-fixture.mts';
import {
  buildVoicePrompt, NPC_NAMES, SETTLEMENT_PREFIX, SETTLEMENT_SUFFIX,
} from '../src/game/voice/vocabulary.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'scripts', 'voice_fixture');
const MODEL = path.join(ROOT, 'models', 'Xenova--whisper-base.en');

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const NO_BIAS = process.argv.includes('--no-bias');
const SELFTEST_ONLY = process.argv.includes('--selftest');
const ONLY = arg('only') ? Number(arg('only')) : null;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
}

// ─── Word error rate ─────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace. */
function norm(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
}

/** Levenshtein over words → {edits, refLen}. */
function wordEdits(ref: string[], hyp: string[]): number {
  const R = ref.length, H = hyp.length;
  let prev = Array.from({ length: H + 1 }, (_, j) => j);
  for (let i = 1; i <= R; i++) {
    const cur = [i];
    for (let j = 1; j <= H; j++) {
      cur[j] = ref[i - 1] === hyp[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[H];
}

function wer(ref: string, hyp: string): { edits: number; refLen: number; rate: number } {
  const r = norm(ref), h = norm(hyp);
  const edits = wordEdits(r, h);
  return { edits, refLen: r.length, rate: r.length ? edits / r.length : (h.length ? 1 : 0) };
}

/** Is a proper noun present in the hypothesis, ignoring case and punctuation? */
function nounHit(noun: string, hyp: string): boolean {
  const n = norm(noun).join(' ');
  return n.length > 0 && norm(hyp).join(' ').includes(n);
}

// ─── WAV ─────────────────────────────────────────────────────────────────────

function readWav(file: string): { audio: Float32Array; info: ReturnType<typeof decodeWavHeader> } {
  const buf = fs.readFileSync(file);
  const info = decodeWavHeader(buf);
  const n = Math.floor(info.dataBytes / 2 / info.numChannels);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < info.numChannels; c++) {
      acc += buf.readInt16LE(44 + (i * info.numChannels + c) * 2);
    }
    audio[i] = acc / info.numChannels / 32768;
  }
  return { audio, info };
}

// ─── Source-table drift guards ───────────────────────────────────────────────
//
// vocabulary.ts carries copies of two tables because neither source exports
// them, and editing those files was out of scope. A copy that silently drifts
// is worse than no copy: the prompt would bias toward names that no longer
// exist while missing the ones that do. So re-read the sources and compare.

function tableFrom(file: string, decl: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`${file}: could not find \`${decl}\` — the source moved`);
  const body = src.slice(at + decl.length, src.indexOf('];', at));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function driftGuards(): void {
  console.log('\n─── source-table drift ───');
  const cases: Array<[string, string, string, readonly string[]]> = [
    ['NPC names', 'src/game/npc/npc-prompt.ts', 'const NAME_TABLE: string[] = [', NPC_NAMES],
    ['settlement prefixes', 'src/game/settlement/settlement-layout.ts',
      'const NAME_PREFIX = [', SETTLEMENT_PREFIX],
    ['settlement suffixes', 'src/game/settlement/settlement-layout.ts',
      'const NAME_SUFFIX = [', SETTLEMENT_SUFFIX],
  ];
  for (const [label, file, decl, copy] of cases) {
    let source: string[] = [];
    let err = '';
    try { source = tableFrom(file, decl); } catch (e) { err = String(e); }
    const same = err === '' && source.length === copy.length
      && source.every((v, i) => v === copy[i]);
    ok(`vocabulary.ts ${label} match ${path.basename(file)}`, same,
      same ? `${source.length} entries` : err || `source=[${source}] copy=[${copy}]`);
  }
}

// ─── Self-test ───────────────────────────────────────────────────────────────

function selfTestPure(): void {
  console.log('\n─── instrument: word error rate ───');
  ok('identical strings score 0', wer('the quick brown fox', 'The quick brown fox!').rate === 0);
  const wrong = wer('Where can I find the road to Greenholm',
    'I would like to buy a loaf of bread');
  ok('a wrong transcript scores > 0', wrong.rate > 0, `rate=${wrong.rate.toFixed(3)}`);
  ok('one substitution in four words = 0.25',
    Math.abs(wer('a b c d', 'a b x d').rate - 0.25) < 1e-9);
  ok('punctuation and case are ignored',
    wer('Greenholm, please.', 'greenholm please').rate === 0);
  ok('noun hit is case-insensitive', nounHit('Greenholm', 'the road to greenholm is long'));
  ok('noun miss is a miss', !nounHit('Greenholm', 'the road to green home is long'));
}

function selfTestFixture(files: Array<{ file: string; text: string }>): void {
  console.log('\n─── instrument: fixture format ───');
  let bad = '';
  let n = 0;
  for (const u of files) {
    const p = path.join(FIXTURE, u.file);
    if (!fs.existsSync(p)) { bad = `${u.file} missing`; break; }
    const info = decodeWavHeader(fs.readFileSync(p));
    if (info.sampleRate !== 16000) { bad = `${u.file} is ${info.sampleRate} Hz, not 16000`; break; }
    if (info.numChannels !== 1) { bad = `${u.file} has ${info.numChannels} channels`; break; }
    if (info.bitsPerSample !== 16) { bad = `${u.file} is ${info.bitsPerSample}-bit`; break; }
    n++;
  }
  ok('every fixture WAV is 16 kHz mono 16-bit', bad === '', bad || `${n} files`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface Row {
  idx: number; file: string; text: string; arm: 'control' | 'game'; nouns: string[];
  plain: string; biased: string;
}

async function main(): Promise<void> {
  selfTestPure();
  driftGuards();

  const manifestPath = path.join(FIXTURE, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`\nNo fixture at ${manifestPath}`);
    console.error('Generate it first:  npx tsx scripts/gen-voice-fixture.mts');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    utterances: Array<{ file: string; text: string; arm: 'control' | 'game'; nouns?: string[] }>;
  };
  selfTestFixture(manifest.utterances);

  if (SELFTEST_ONLY) { report([]); return; }

  const t: any = await import('@huggingface/transformers');
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;

  process.stdout.write('\nloading whisper-base.en (int8)… ');
  const t0 = Date.now();
  const tokenizer = await t.AutoTokenizer.from_pretrained(MODEL);
  const processor = await t.AutoProcessor.from_pretrained(MODEL);
  const model = await t.WhisperForConditionalGeneration.from_pretrained(MODEL, {
    dtype: 'q8', device: 'cpu',
  });
  console.log(`${Date.now() - t0} ms`);

  const sop = tokenizer.model.convert_tokens_to_ids(['<|startofprev|>'])[0];
  const sot = tokenizer.model.convert_tokens_to_ids(['<|startoftranscript|>'])[0];
  const nots = tokenizer.model.convert_tokens_to_ids(['<|notimestamps|>'])[0];

  // The deployment condition: standing in front of a named NPC in a named
  // town. Every NPC name is in the prompt regardless (vocabulary.ts), so the
  // live context mostly decides ORDER, which is what survives truncation.
  const prompt = buildVoicePrompt({
    npcName: 'Aldric', settlement: 'Greenholm', neighbors: ['Thora', 'Sven'],
  });
  const promptIds: number[] = tokenizer.encode(prompt, { add_special_tokens: false });
  const prefix = [sop, ...promptIds, sot, nots];
  console.log(`bias prompt: ${promptIds.length} tokens`);

  async function run(audio: Float32Array, biased: boolean): Promise<string> {
    const feats = await processor(audio);
    const opts: Record<string, unknown> = { max_new_tokens: 128 };
    if (biased) {
      opts.decoder_input_ids = new t.Tensor(
        'int64', BigInt64Array.from(prefix.map((n) => BigInt(n))), [1, prefix.length]);
    }
    const out = await model.generate({ ...feats, ...opts });
    const seq: number[] = Array.from(
      (out.tolist ? out.tolist()[0] : out[0]) as Iterable<bigint | number>, (v) => Number(v));
    return String(tokenizer.decode(seq.slice(biased ? prefix.length : 0),
      { skip_special_tokens: true })).trim();
  }

  // --- the silence control, run against the real model ----------------------
  console.log('\n─── instrument: silence ───');
  const silence = await run(new Float32Array(16000 * 2), false);
  ok('silence does not produce any fixture reference',
    !manifest.utterances.some((u) => wer(u.text, silence).rate === 0),
    `silence → ${JSON.stringify(silence)}`);

  // --- the arms -------------------------------------------------------------
  const rows: Row[] = [];
  const list = manifest.utterances
    .map((u, i) => ({ ...u, idx: i + 1 }))
    .filter((u) => ONLY === null || u.idx === ONLY);

  console.log(`\n─── transcribing ${list.length} utterance(s) ───`);
  for (const u of list) {
    const { audio } = readWav(path.join(FIXTURE, u.file));
    const plain = await run(audio, false);
    const biased = NO_BIAS ? '' : await run(audio, true);
    rows.push({
      idx: u.idx, file: u.file, text: u.text, arm: u.arm, nouns: u.nouns ?? [], plain, biased,
    });
    const p = wer(u.text, plain).rate;
    const b = NO_BIAS ? NaN : wer(u.text, biased).rate;
    console.log(`  ${String(u.idx).padStart(2)}  ${u.arm.padEnd(7)}`
      + ` plain ${(p * 100).toFixed(0).padStart(3)}%`
      + (NO_BIAS ? '' : `  biased ${(b * 100).toFixed(0).padStart(3)}%`)
      + `   ${JSON.stringify(u.text)}`);
    if (p > 0) console.log(`         plain : ${JSON.stringify(plain)}`);
    if (!NO_BIAS && b > 0) console.log(`         biased: ${JSON.stringify(biased)}`);
  }

  report(rows);
}

function armStats(rows: Row[], arm: 'control' | 'game', key: 'plain' | 'biased') {
  const r = rows.filter((x) => x.arm === arm);
  let edits = 0, refLen = 0, exact = 0;
  for (const x of r) {
    const w = wer(x.text, x[key]);
    edits += w.edits; refLen += w.refLen;
    if (w.rate === 0) exact++;
  }
  const nouns = r.flatMap((x) => x.nouns.map((n) => nounHit(n, x[key])));
  return {
    n: r.length,
    wer: refLen ? edits / refLen : 0,
    exact,
    nounHits: nouns.filter(Boolean).length,
    nounTotal: nouns.length,
  };
}

function report(rows: Row[]): void {
  if (rows.length > 0) {
    console.log('\n' + '─'.repeat(78));
    console.log('  arm      pass     WER    exact      proper nouns recalled');
    console.log('─'.repeat(78));
    for (const arm of ['control', 'game'] as const) {
      for (const key of NO_BIAS ? (['plain'] as const) : (['plain', 'biased'] as const)) {
        const s = armStats(rows, arm, key);
        if (s.n === 0) continue;
        console.log(`  ${arm.padEnd(8)} ${key.padEnd(8)}`
          + `${(s.wer * 100).toFixed(1).padStart(5)}%`
          + `  ${String(s.exact).padStart(2)}/${s.n}`
          + `        ${s.nounTotal ? `${s.nounHits}/${s.nounTotal}` : '—'}`);
      }
    }
    console.log('─'.repeat(78));

    // The control arm is what makes the game arm interpretable. If plain
    // English is already failing, nothing below it can be attributed to
    // vocabulary — so this is an assertion, not a statistic.
    const ctl = armStats(rows, 'control', 'plain');
    if (ctl.n > 0) {
      ok('control arm WER is low enough for the game arm to mean anything',
        ctl.wer < 0.25, `control WER ${(ctl.wer * 100).toFixed(1)}%`);
    }
    if (!NO_BIAS) {
      const gp = armStats(rows, 'game', 'plain');
      const gb = armStats(rows, 'game', 'biased');
      if (gp.nounTotal > 0) {
        ok('vocabulary biasing does not REDUCE proper-noun recall',
          gb.nounHits >= gp.nounHits, `${gp.nounHits}/${gp.nounTotal} → ${gb.nounHits}/${gb.nounTotal}`);
      }
      const cp = armStats(rows, 'control', 'plain');
      const cb = armStats(rows, 'control', 'biased');
      if (cp.n > 0) {
        // The failure mode of prompt biasing is that it drags ordinary
        // sentences toward the vocabulary. Watch the control arm for it.
        ok('vocabulary biasing does not wreck the control arm',
          cb.wer <= cp.wer + 0.10,
          `control ${(cp.wer * 100).toFixed(1)}% → ${(cb.wer * 100).toFixed(1)}%`);
      }
    }
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
