/**
 * Voice-input test-signal generator — offline, deterministic spoken WAVs.
 *
 * Synthesises 16 kHz mono 16-bit PCM WAV files of game-vocabulary utterances
 * using the repo's own parity-gated TTS stack, entirely offline:
 *
 *   text ──phonemize()──▶ IPA ──phonemesToIds()──▶ ids ──synthesize()──▶ f32 @ 22050
 *        (src/audio/g2p)                                (src/audio/piper)
 *                                                              │
 *                      linear resample 22050→16000 ────────────┘
 *                                    │
 *                      f32 → i16 → RIFF/WAVE ──▶ scripts/voice_fixture/*.wav
 *
 * These WAVs are the input to (a) a Whisper transcription-accuracy eval and
 * (b) a Playwright fake-audio-device test (--use-file-for-fake-audio-capture
 * requires exactly this format: 16 kHz mono 16-bit PCM WAV).
 *
 * Determinism: synthesize() is driven by a seeded mulberry32 PRNG, and we run it
 * at the parity-gated zero-noise operating point (noiseScale 0, noiseW 0,
 * lengthScale 1) with a fixed seed — so the sample stream, and therefore every
 * byte of every WAV, is reproducible. The script self-checks this by hashing two
 * independent synthesis runs of one utterance.
 *
 * Resampler: linear interpolation, matching scripts/gen_whisper_fixture.py's
 * clips ingest (np.interp over linspace(0, N-1, n)) so the signal chain into
 * Whisper is identical to the one the parity fixture was built with.
 *
 * The utterance list is deliberately split into two arms:
 *   - CONTROL  — plain English, zero game vocabulary. These are the instrument's
 *                control. If a control utterance mis-transcribes, the harness is
 *                broken, not the vocabulary.
 *   - GAME     — the repo's real proper nouns (settlements, castles, NPC names,
 *                creatures) in sentences a player would actually say to an NPC.
 *
 * Calibration baseline (whisper-base.en, transformers, greedy, 2026-07-25 — the
 * numbers a regression should be judged against):
 *   control arm  WER  6.7%, 4/5 exact
 *   game arm     WER 16.5%, 4/13 exact
 * i.e. the harness itself is sound and the game vocabulary is the failure mode,
 * which is the whole point of the fixture. Proper nouns base.en got wrong:
 * Greenholm→"Green Home", Castle Vhaeron→"Castle B. Heron", Tintreach→
 * "Tintree Ch-", Aldric→"Alberts", Thora→"Thor", Sven→"Then", Ysolde→"Usold",
 * dragonscale→"Dragon Scale". It got right: Ashfield, Sunken Crypt, Dread King,
 * Howling Hollow, griffin, wyvern.
 *
 * Usage:
 *   npx tsx scripts/gen-voice-fixture.mts                # all utterances
 *   npx tsx scripts/gen-voice-fixture.mts --only=3       # just utterance 3
 *   npx tsx scripts/gen-voice-fixture.mts --out=some/dir # alternate output dir
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parseHeader, extractTensorData, tensorToFloat32 } from '../src/model/safetensors';
import { phonemize, phonemesToIds, type PhonemeIdMap } from '../src/audio/g2p';
import { synthesize, type PiperWeights } from '../src/audio/piper';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(here, '../models/piper-en-us-joe-medium');

// ── synthesis operating point ──────────────────────────────────────────────
// This is exactly the zero-noise path that scripts/test-piper-parity.mts gates
// against the onnxruntime dumps, so the audio we emit is the reference audio.
// A fixed seed pins the (unused, but still drawn) PRNG stream for good measure.
const SEED = 20260725;
const SYNTH_OPTS = { noiseScale: 0, noiseW: 0, lengthScale: 1, seed: SEED } as const;
const TARGET_RATE = 16000; // Whisper's input rate

// ── the corpus ─────────────────────────────────────────────────────────────
// `arm` splits control from game vocabulary. `text` is the exact reference
// transcript the eval scores against — keep it as a player would say it.
// `nouns` records which real in-game proper nouns the line is probing, so a
// failure in the eval points straight at a vocabulary item.
//
// Every proper noun below is lifted from the shipping source, not invented:
//   Greenholm          src/game/settlement/settlement-scatter.ts:301  (pinned spawn town)
//   Ashfield           src/game/settlement/settlement-layout.ts:76-82 ('Ash' + 'field')
//   Castle Vhaeron     src/game/map/map-landmarks.ts:46               (the only spelling)
//   Tintreach Arrows   src/game/items.ts:168                          (one quiver per save)
//   Dragonscale Helm   src/game/items.ts:201
//   wyvern / griffin   src/game/entities/entity-types.ts:257, 284
//   Dread King         src/game/entities/entity-types.ts:386          (dungeon boss)
//   The Sunken Crypt   src/game/dungeon/dungeon-fixtures.ts:16
//   Howling Hollow     src/game/dungeon/dungeon-fixtures.ts:32
//   Aldric/Thora/…     src/game/npc/npc-prompt.ts:107-112             (NAME_TABLE, 24 given
//                                                                      names; NPCs have no
//                                                                      surnames)
export interface Utterance { text: string; arm: 'control' | 'game'; slug: string; nouns?: string[] }

export const UTTERANCES: Utterance[] = [
  // ── CONTROL: no game vocabulary at all. If one of these mis-transcribes,
  //    the harness is broken — not the vocabulary. ───────────────────────────
  { arm: 'control', slug: 'hello_there', text: 'Hello there, how are you today?' },
  { arm: 'control', slug: 'where_is_market', text: 'Where is the market from here?' },
  { arm: 'control', slug: 'need_help', text: 'I need some help with something.' },
  { arm: 'control', slug: 'thank_you', text: 'Thank you very much, my friend.' },
  { arm: 'control', slug: 'what_do_you_sell', text: 'What do you sell around here?' },

  // ── GAME: real proper nouns in sentences a player would say to an NPC ─────
  { arm: 'game', slug: 'road_to_greenholm', nouns: ['Greenholm'],
    text: 'Where can I find the road to Greenholm?' },
  { arm: 'game', slug: 'how_far_ashfield', nouns: ['Ashfield'],
    text: 'How far is Ashfield from here?' },
  { arm: 'game', slug: 'wyvern_castle_vhaeron', nouns: ['wyvern', 'Castle Vhaeron'],
    text: 'Have you seen a wyvern near Castle Vhaeron?' },
  { arm: 'game', slug: 'tell_me_tintreach', nouns: ['Tintreach'],
    text: 'Tell me about the Tintreach arrows.' },
  { arm: 'game', slug: 'aldric_sent_me', nouns: ['Aldric'],
    text: 'Aldric said you needed some help.' },
  { arm: 'game', slug: 'thora_at_the_mill', nouns: ['Thora'],
    text: 'Is Thora still down at the mill?' },
  { arm: 'game', slug: 'sven_that_bow', nouns: ['Sven'],
    text: 'Sven, where did you get that bow?' },
  { arm: 'game', slug: 'looking_for_ysolde', nouns: ['Ysolde'],
    text: 'I am looking for a woman named Ysolde.' },
  { arm: 'game', slug: 'way_to_sunken_crypt', nouns: ['The Sunken Crypt'],
    text: 'Which way is it to the Sunken Crypt?' },
  { arm: 'game', slug: 'dread_king_below', nouns: ['Dread King'],
    text: 'The Dread King guards the lower halls.' },
  { arm: 'game', slug: 'inside_howling_hollow', nouns: ['Howling Hollow'],
    text: 'Have you ever been inside Howling Hollow?' },
  { arm: 'game', slug: 'griffin_took_my_horse', nouns: ['griffin', 'horse'],
    text: 'A griffin took my horse last night.' },
  { arm: 'game', slug: 'sell_dragonscale', nouns: ['Dragonscale'],
    text: 'Do you sell dragonscale armor here?' },
];

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  let outDir = resolve(here, 'voice_fixture');
  let only: number | null = null;
  for (const a of argv) {
    if (a.startsWith('--out=')) outDir = resolve(process.cwd(), a.slice(6));
    else if (a.startsWith('--only=')) {
      const n = Number(a.slice(7));
      if (!Number.isInteger(n) || n < 1 || n > UTTERANCES.length) {
        throw new Error(`--only must be an integer 1..${UTTERANCES.length}, got "${a.slice(7)}"`);
      }
      only = n;
    } else if (a === '--help' || a === '-h') {
      console.log('usage: tsx scripts/gen-voice-fixture.mts [--out=<dir>] [--only=<n>]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { outDir, only };
}

// ── piper voice (Node: read safetensors off disk, not the browser fetch) ───
function loadVoice(): { weights: PiperWeights; idMap: PhonemeIdMap } {
  const cfg = JSON.parse(readFileSync(join(MODEL_DIR, 'config.json'), 'utf8'));
  const idMap = cfg.phoneme_id_map as PhonemeIdMap;
  if (!idMap) throw new Error('config.json missing phoneme_id_map');
  const buf = readFileSync(join(MODEL_DIR, 'model.safetensors'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const header = parseHeader(ab);
  const weights: PiperWeights = new Map();
  for (const [name, info] of header.tensors) {
    const raw = extractTensorData(ab, info, header.headerByteLength);
    weights.set(name, { shape: info.shape, data: tensorToFloat32(raw, info.dtype) });
  }
  return { weights, idMap };
}

// ── resample: linear interpolation, gen_whisper_fixture.py parity ──────────
// n = round(N * dstRate / srcRate); sample positions = linspace(0, N-1, n).
export function resampleLinear(x: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return Float32Array.from(x);
  const N = x.length;
  if (N === 0) return new Float32Array(0);
  const n = Math.round((N * dstRate) / srcRate);
  const out = new Float32Array(n);
  if (n === 1) { out[0] = x[0]; return out; }
  const step = (N - 1) / (n - 1); // linspace(0, N-1, n)
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    if (i0 >= N - 1) { out[i] = x[N - 1]; continue; }
    const frac = pos - i0;
    out[i] = x[i0] * (1 - frac) + x[i0 + 1] * frac;
  }
  return out;
}

// ── f32 [-1,1] → signed 16-bit PCM ─────────────────────────────────────────
// Symmetric 32767 scale + clamp: the conventional lossless-on-round-trip choice,
// and it cannot produce the -32768/+32767 asymmetry artefact.
export function floatToPcm16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    out[i] = Math.round(s * 32767);
  }
  return out;
}

// ── RIFF/WAVE, 16-bit PCM, mono ────────────────────────────────────────────
// 44-byte canonical header: RIFF chunk + "fmt " (PCM, 16 bytes) + "data".
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);   // RIFF chunk size = file size - 8
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);              // fmt chunk size (PCM)
  buf.writeUInt16LE(1, 20);               // audioFormat = 1 (PCM)
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

// ── RIFF/WAVE reader — used by the self-check to prove the header is real ──
export interface WavInfo {
  audioFormat: number; numChannels: number; sampleRate: number;
  byteRate: number; blockAlign: number; bitsPerSample: number;
  dataBytes: number; numSamples: number; fileSize: number;
}
export function decodeWavHeader(buf: Buffer): WavInfo {
  const req = (cond: boolean, msg: string) => { if (!cond) throw new Error(`WAV: ${msg}`); };
  req(buf.length >= 44, `file shorter than a 44-byte header (${buf.length})`);
  req(buf.toString('ascii', 0, 4) === 'RIFF', 'missing RIFF magic');
  req(buf.toString('ascii', 8, 12) === 'WAVE', 'missing WAVE magic');
  req(buf.toString('ascii', 12, 16) === 'fmt ', 'missing fmt  chunk');
  const riffSize = buf.readUInt32LE(4);
  req(riffSize === buf.length - 8, `RIFF size ${riffSize} != fileSize-8 ${buf.length - 8}`);
  const fmtSize = buf.readUInt32LE(16);
  req(fmtSize === 16, `fmt chunk size ${fmtSize} != 16`);
  const info: WavInfo = {
    audioFormat: buf.readUInt16LE(20),
    numChannels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    dataBytes: 0, numSamples: 0, fileSize: buf.length,
  };
  req(buf.toString('ascii', 36, 40) === 'data', 'missing data chunk at offset 36');
  info.dataBytes = buf.readUInt32LE(40);
  req(info.dataBytes === buf.length - 44, `data size ${info.dataBytes} != fileSize-44 ${buf.length - 44}`);
  info.numSamples = info.dataBytes / (info.bitsPerSample / 8) / info.numChannels;
  req(info.byteRate === info.sampleRate * info.blockAlign, 'byteRate != sampleRate*blockAlign');
  req(info.blockAlign === info.numChannels * (info.bitsPerSample / 8), 'blockAlign mismatch');
  return info;
}

const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

// ── synthesis: text → 16 kHz mono f32 ──────────────────────────────────────
async function speak(text: string, voice: { weights: PiperWeights; idMap: PhonemeIdMap }) {
  const phonemes = await phonemize(text);
  const ids = phonemesToIds(phonemes, voice.idMap);
  const res = await synthesize(ids, voice.weights, SYNTH_OPTS);
  const audio16k = resampleLinear(res.audio, res.sampleRate, TARGET_RATE);
  return { phonemes, ids, audio22k: res.audio, audio16k };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const { outDir, only } = parseArgs(process.argv.slice(2));
  const wall0 = Date.now();

  mkdirSync(outDir, { recursive: true });
  console.log(`piper voice: ${MODEL_DIR}`);
  const tLoad = Date.now();
  const voice = loadVoice();
  console.log(`  ${voice.weights.size} tensors, ${Object.keys(voice.idMap).length} phoneme ids  (${Date.now() - tLoad} ms)`);
  console.log(`out: ${outDir}`);
  console.log(`synth: noiseScale=0 noiseW=0 lengthScale=1 seed=${SEED} → ${TARGET_RATE} Hz mono s16 (linear resample)\n`);

  const targets = only === null
    ? UTTERANCES.map((u, i) => ({ u, idx: i + 1 }))
    : [{ u: UTTERANCES[only - 1], idx: only }];

  interface Entry {
    file: string; text: string; arm: string; nouns: string[]; samples: number;
    durationSec: number; bytes: number; sha256: string;
  }
  const entries: Entry[] = [];

  for (const { u, idx } of targets) {
    const t0 = Date.now();
    const { audio16k } = await speak(u.text, voice);
    const wav = encodeWav(floatToPcm16(audio16k), TARGET_RATE);
    const file = `u${String(idx).padStart(2, '0')}_${u.slug}.wav`;
    writeFileSync(join(outDir, file), wav);

    // Header must be real: read it back off disk and parse it, and the size
    // identity 44 + numSamples*2 must hold exactly.
    const back = readFileSync(join(outDir, file));
    const info = decodeWavHeader(back);
    const checks =
      info.audioFormat === 1 && info.numChannels === 1 &&
      info.sampleRate === TARGET_RATE && info.bitsPerSample === 16 &&
      info.numSamples === audio16k.length &&
      statSync(join(outDir, file)).size === 44 + audio16k.length * 2;
    if (!checks) throw new Error(`${file}: header/size validation failed ${JSON.stringify(info)}`);

    entries.push({
      file, text: u.text, arm: u.arm, nouns: u.nouns ?? [], samples: audio16k.length,
      durationSec: +(audio16k.length / TARGET_RATE).toFixed(3),
      bytes: back.length, sha256: sha256(back),
    });
    console.log(
      `  [${String(idx).padStart(2, '0')}] ${u.arm.padEnd(7)} ${(audio16k.length / TARGET_RATE).toFixed(2)}s  ` +
      `${String(back.length).padStart(7)} B  ${sha256(back).slice(0, 12)}  ${(Date.now() - t0) / 1000}s  "${u.text}"`,
    );
  }

  // ── self-check: determinism. Synthesise utterance 1 (or the --only target)
  // a second time from scratch and require a byte-identical WAV.
  const probe = targets[0];
  const { audio16k: again } = await speak(probe.u.text, voice);
  const wavAgain = encodeWav(floatToPcm16(again), TARGET_RATE);
  const want = entries[0].sha256;
  const got = sha256(wavAgain);
  const deterministic = got === want;
  console.log(`\ndeterminism: re-synth "${probe.u.text}"`);
  console.log(`  run1 ${want}`);
  console.log(`  run2 ${got}`);
  console.log(`  ${deterministic ? 'PASS — byte-identical' : 'FAIL — NOT reproducible'}`);
  if (!deterministic) process.exitCode = 1;

  // Manifest is only written for a full run — a --only run would truncate it.
  if (only === null) {
    const manifest = {
      meta: {
        sampleRate: TARGET_RATE, channels: 1, bitsPerSample: 16, encoding: 'pcm_s16le',
        voice: 'piper en_US-joe-medium', synthSampleRate: 22050, resampler: 'linear',
        synth: { noiseScale: 0, noiseW: 0, lengthScale: 1, seed: SEED },
        deterministic,
        generatedBy: 'scripts/gen-voice-fixture.mts',
      },
      utterances: entries,
    };
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nmanifest.json: ${entries.length} utterances ` +
      `(${entries.filter((e) => e.arm === 'control').length} control, ${entries.filter((e) => e.arm === 'game').length} game)`);
  } else {
    console.log('\n(--only run: manifest.json not rewritten)');
  }
  console.log(`total ${(Date.now() - wall0) / 1000}s`);
}

// Only generate when run as a script. Imported (by the Whisper eval or the
// Playwright fixture setup) this module just exposes resampleLinear /
// floatToPcm16 / encodeWav / decodeWavHeader / UTTERANCES.
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
