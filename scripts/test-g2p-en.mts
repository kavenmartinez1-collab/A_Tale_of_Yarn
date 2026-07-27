/**
 * Gate for the shipped (non-GPL) English G2P — src/audio/g2p-en.ts.
 *
 * The game cannot phonemize with eSpeak NG (GPL-3.0; `pack-steam.mjs` refuses
 * to build a depot containing it), so villager voices go through a baked
 * CMUdict lexicon plus letter-to-sound rules instead. This measures what that
 * costs, against the eSpeak ground truth already captured in
 * scripts/piper_fixture/g2p_corpus.json, and asserts the floor.
 *
 * It also runs the whole chain — text → ids → piper ONNX → PCM — and asserts
 * the audio has real energy. A G2P test that stops at "ids were produced"
 * measures nothing: an id sequence of pure padding is silent and still passes.
 *
 * Run: npx tsx scripts/test-g2p-en.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLexicon, textToPhonemes, textToIds, phonemesToIds, lettersToIpa, numberToWords,
} from '../src/audio/g2p-en';
// g2p.ts imports espeak at module scope but only instantiates it inside
// phonemize(); importing phonemesToIds here is safe in Node and lets the two
// id mappings be compared directly. This file is dev-only and never bundled.
import { phonemesToIds as espeakPhonemesToIds } from '../src/audio/g2p';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const MODEL_DIR = path.join(REPO, 'models', 'rhasspy--piper-en-us-joe-medium');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (n: string) => console.log(`\n${'─'.repeat(72)}\n${n}\n${'─'.repeat(72)}`);

// ── 1. lexicon ───────────────────────────────────────────────────────────────
section('1. Baked lexicon');

const lexPath = path.join(MODEL_DIR, 'lexicon-en-us.txt');
ok('lexicon-en-us.txt exists', fs.existsSync(lexPath),
  'run `npx tsx scripts/build-lexicon.mts` if missing');
if (!fs.existsSync(lexPath)) { console.log('\ncannot continue without the lexicon\n'); process.exit(1); }

const lexText = fs.readFileSync(lexPath, 'utf8');
const lex = parseLexicon(lexText);
ok('lexicon parses to a plausible size', lex.size > 100_000, `${lex.size} entries`);
ok('a common word resolves', (lex.get('water') ?? '') !== '', `water → ${lex.get('water')}`);
ok('function words are reduced, not citation forms', lex.get('to') === 'tə',
  `to → ${lex.get('to')}`);
ok('BSD-2-Clause notice ships beside it',
  fs.existsSync(path.join(MODEL_DIR, 'LICENSE-cmudict.txt')));

// ── 2. id mapping agrees with the eSpeak implementation ──────────────────────
section('2. Id mapping parity with g2p.ts');

const cfg = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'en_US-joe-medium.onnx.json'), 'utf8'));
const idMap = cfg.phoneme_id_map as Record<string, number[]>;
ok('phoneme_id_map loaded from the shipped config', Object.keys(idMap).length > 100,
  `${Object.keys(idMap).length} symbols`);

const sample = ['ð', 'ə', ' ', 'k', 'w', 'ˈ', 'ɪ', 'k', '.'];
const mine = phonemesToIds(sample, idMap);
const theirs = espeakPhonemesToIds(sample, idMap);
ok('phonemesToIds is byte-identical to the eSpeak module',
  JSON.stringify(mine) === JSON.stringify(theirs), `${mine.length} ids`);

// ── 3. parity against the eSpeak corpus ──────────────────────────────────────
section('3. Parity against the eSpeak ground-truth corpus');

interface Row { text: string; phonemes: string[]; words: string[] }
const corpus: Row[] = JSON.parse(
  fs.readFileSync(path.join(here, 'piper_fixture', 'g2p_corpus.json'), 'utf8'),
);

let total = 0, exact = 0, oov = 0;
for (const row of corpus) {
  const orth = row.text.split(/\s+/).filter(Boolean);
  if (orth.length !== row.words.length) continue;
  for (let i = 0; i < orth.length; i++) {
    const bare = orth[i].toLowerCase().replace(/[^a-z']/g, '');
    if (!bare) continue;
    total++;
    const got = lex.get(bare);
    if (got === undefined) { oov++; continue; }
    if (got === row.words[i].replace(/[.,!?;:]+$/u, '')) exact++;
  }
}
const exactPct = (exact / total) * 100;
const oovPct = (oov / total) * 100;
// Floors, not targets. The measured values when this gate was written were
// 65.5% exact and 0.4% OOV; the margin absorbs a CMUdict revision.
ok('word-level exact match holds its floor', exactPct >= 60,
  `${exactPct.toFixed(1)}% of ${total} words (floor 60%)`);
ok('out-of-vocabulary rate stays low', oovPct <= 2,
  `${oovPct.toFixed(1)}% (ceiling 2%)`);

// ── 4. every phoneme we emit is one the model knows ──────────────────────────
section('4. No phoneme is silently dropped');

const NPC_NAMES = ['Aldric', 'Beren', 'Calla', 'Dara', 'Edric', 'Fenna', 'Gorm',
  'Hilda', 'Ivar', 'Jora', 'Keld', 'Lyra', 'Maren', 'Nils', 'Oswin', 'Petra',
  'Quill', 'Runa', 'Sven', 'Thora', 'Ulric', 'Vara', 'Wren', 'Ysolde'];
const PLACES = ['Rivermeet', 'Tintreach', 'Bramblewick'];
const LINES = [
  'Good morning, traveller.',
  'The well is dry again, and the guard wants 12 gold for a flask.',
  'I would not go near the dungeon after dark.',
  ...NPC_NAMES.map((n) => `My name is ${n}.`),
  ...PLACES.map((p) => `Welcome to ${p}.`),
];

let unknown = 0;
const unknownSyms = new Set<string>();
for (const line of LINES) {
  for (const p of textToPhonemes(line, lex)) {
    if (!(p in idMap)) { unknown++; unknownSyms.add(p); }
  }
}
ok('every emitted phoneme exists in the model id map', unknown === 0,
  unknown ? `${unknown} drops: ${[...unknownSyms].join(' ')}` : `${LINES.length} lines clean`);

let emptyNames = 0;
for (const n of [...NPC_NAMES, ...PLACES]) {
  const key = n.toLowerCase();
  const ipa = lex.get(key) ?? lettersToIpa(key);
  if (!ipa) emptyNames++;
}
ok('every NPC and place name produces phonemes', emptyNames === 0,
  `${NPC_NAMES.length + PLACES.length} names`);

const inLex = [...NPC_NAMES, ...PLACES].filter((n) => lex.has(n.toLowerCase()));
console.log(`       (${inLex.length}/${NPC_NAMES.length + PLACES.length} names came from the`
  + ` dictionary; the rest used letter-to-sound)`);
for (const n of [...NPC_NAMES, ...PLACES]) {
  const key = n.toLowerCase();
  if (!lex.has(key)) console.log(`         LTS  ${n} → ${lettersToIpa(key)}`);
}

ok('numbers are spoken as words', numberToWords(12) === 'twelve'
  && numberToWords(345) === 'three hundred forty-five', `12 → ${numberToWords(12)}`);
const numIds = textToIds('I want 12 gold.', lex, idMap);
ok('a numeral reaches the id stream', numIds.length > 20, `${numIds.length} ids`);

// ── 5. end-to-end: the audio has energy ──────────────────────────────────────
section('5. End to end — text through the ONNX voice to PCM');

const onnxPath = path.join(MODEL_DIR, 'en_US-joe-medium.onnx');
if (!fs.existsSync(onnxPath)) {
  ok('piper ONNX present', false, 'run `npm run weights`');
} else {
  const ortMod = await import('onnxruntime-node');
  const ort = (ortMod.default ?? ortMod) as typeof import('onnxruntime-node');
  const sess = await ort.InferenceSession.create(onnxPath, { executionProviders: ['cpu'] });

  const text = 'The well is dry again, friend.';
  const ids = textToIds(text, lex, idMap);
  const t0 = performance.now();
  const out = await sess.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([0.667, 1.0, 0.8]), [3]),
  });
  const ms = performance.now() - t0;
  const audio = out[sess.outputNames[0]].data as Float32Array;
  const sr: number = cfg.audio?.sample_rate ?? 22050;

  let peak = 0, sumSq = 0;
  for (let i = 0; i < audio.length; i++) {
    const a = Math.abs(audio[i]);
    if (a > peak) peak = a;
    sumSq += audio[i] * audio[i];
  }
  const rms = Math.sqrt(sumSq / audio.length);
  const secs = audio.length / sr;

  ok('synthesis produced samples', audio.length > 0, `${audio.length} @ ${sr} Hz`);
  ok('duration is plausible for the sentence', secs > 0.8 && secs < 6,
    `${secs.toFixed(2)} s`);
  // The instrument's own calibration: silence must NOT pass this.
  ok('audio is not silent (RMS above floor)', rms > 0.01, `rms ${rms.toFixed(4)}`);
  ok('audio does not clip', peak < 0.99, `peak ${peak.toFixed(3)}`);
  ok('real-time factor leaves room for streaming', ms / 1000 / secs < 0.5,
    `${ms.toFixed(0)} ms for ${secs.toFixed(2)} s → RTF ${(ms / 1000 / secs).toFixed(3)}x`);

  // Prove the RMS check is a real instrument, not a rubber stamp.
  const silence = new Float32Array(audio.length);
  let sPeak = 0, sSum = 0;
  for (let i = 0; i < silence.length; i++) { sSum += silence[i] * silence[i]; }
  const sRms = Math.sqrt(sSum / silence.length);
  ok('…and the same check rejects silence', !(sRms > 0.01), `silent rms ${sRms}`);
  void sPeak;
}

console.log(`\ntest-g2p-en: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
