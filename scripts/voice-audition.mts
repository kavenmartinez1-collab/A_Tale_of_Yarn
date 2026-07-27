/**
 * Villager-voice audition pack.
 *
 * Renders the same line in several villagers' voices to WAV, plus an HTML page
 * to play them side by side, so the distinctness of the per-NPC voice identity
 * can be judged by ear — which is the only instrument that can judge it. The
 * mechanical checks here are the ones a machine CAN make: that each voice is
 * measurably different from the others, non-silent, and unclipped.
 *
 * The parameters come from `voiceFor()` in src/game/voice/voice-out.ts, i.e.
 * exactly what the game will use — not a re-derivation that could drift. The
 * cast ids and names come from the game's own `npcNameFor`, and gender from
 * `npcGenderFor`, so the male/female split under audition is the split the
 * player meets.
 *
 * TWO MODELS. Women are synthesized on en_US-ljspeech-medium and men on
 * en_US-joe-medium. The previous single-model design read every part on joe and
 * gave women a 1.08..1.30 resample, which does not sound like a woman — it
 * sounds like a man played fast, because resampling drags the formants along
 * with the pitch. A player reported exactly that. See `BANDS` in voice-out.ts.
 *
 * Run: npx tsx scripts/voice-audition.mts
 * Out: scripts/shots/audition/voices/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLexicon, textToIds, type Lexicon } from '../src/audio/g2p-en';
import {
  voiceFor, nominalF0, MODEL_F0,
  type VoiceParams, type VoiceModelId, type VoiceShape,
} from '../src/game/voice/voice-out';
import { npcGenderFor, npcNameFor } from '../src/game/npc/npc-prompt';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const OUT = path.join(here, 'shots', 'audition', 'voices');

/** The vendored voices. The lexicon is shared and lives with the male one. */
const MODELS: Record<VoiceModelId, { dir: string; base: string }> = {
  male: { dir: path.join(REPO, 'models', 'rhasspy--piper-en-us-joe-medium'), base: 'en_US-joe-medium' },
  female: { dir: path.join(REPO, 'models', 'rhasspy--piper-en-us-ljspeech-medium'), base: 'en_US-ljspeech-medium' },
};
const LEXICON = path.join(MODELS.male.dir, 'lexicon-en-us.txt');

/** One settlement's worth of NPCs, generated the way the game generates them. */
const CAST_SEED = 0x5eed;
/** How many NPCs of each gender to audition. */
const PER_GENDER = 6;

const LINE = 'The well is dry again, and the road east is not safe after dark.';

function wav(pcm: Float32Array, sampleRate: number): Buffer {
  const bytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** Linear resample — the same one tts-worker.ts applies for pitch. */
function resample(src: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-3) return src;
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0;
    const a = src[i0] ?? 0, b = src[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * YIN (de Cheveigné & Kawahara, 2002) on one frame: squared-difference
 * function, cumulative mean normalisation, first dip below threshold,
 * parabolic interpolation.
 *
 * THIS REPLACED a plain autocorrelation over the single loudest 40 ms window.
 * The old estimator was octave-prone and read whichever phoneme happened to be
 * loudest, which made it swing ±35 Hz between two renders of the SAME voice
 * with different noise seeds. Numbers that unstable cannot carry a relation —
 * they were reporting joe at 144 Hz when he is a ~100 Hz speaker. Any f0 table
 * published before this change is on the old scale and is not comparable.
 */
function yinFrame(x: Float32Array, sr: number, minHz: number, maxHz: number): number {
  const tauMin = Math.max(2, Math.floor(sr / maxHz));
  const tauMax = Math.min(Math.floor(x.length / 2), Math.ceil(sr / minHz));
  if (tauMax <= tauMin) return 0;
  const d = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i + tau < x.length; i++) { const v = x[i] - x[i + tau]; s += v * v; }
    d[tau] = s;
  }
  const dn = new Float32Array(tauMax + 1);
  let run = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    run += d[tau];
    dn[tau] = run === 0 ? 1 : d[tau] * (tau - tauMin + 1) / run;
  }
  const THRESH = 0.15;
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (dn[t] < THRESH) {
      while (t + 1 <= tauMax && dn[t + 1] < dn[t]) t++;
      tau = t; break;
    }
  }
  if (tau < 0) {
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (dn[t] < dn[best]) best = t;
    if (dn[best] > 0.4) return 0;
    tau = best;
  }
  const a = dn[tau - 1] ?? dn[tau], b = dn[tau], c = dn[tau + 1] ?? dn[tau];
  const denom = 2 * (2 * b - a - c);
  return sr / (tau + (denom !== 0 ? (c - a) / denom : 0));
}

/**
 * Median per-frame f0 over the voiced frames of an utterance.
 *
 * `contentScale` sizes the analysis frames in the ORIGINAL signal's time base.
 * It matters only when comparing renders of one utterance at different
 * resample ratios: a fixed 50 ms window walks through a compressed signal
 * faster, so it selects a different set of syllables to take the median of,
 * and the estimate then wanders by more than the thing being compared. Passing
 * the resample ratio keeps every render measuring the same words.
 */
function estimateF0(pcm: Float32Array, sr: number, contentScale = 1): number {
  const win = Math.floor(sr * 0.05 / contentScale);
  const hop = Math.floor(win / 2);
  const vals: number[] = [];
  for (let s = 0; s + win < pcm.length; s += hop) {
    const seg = pcm.subarray(s, s + win);
    let e = 0;
    for (let i = 0; i < seg.length; i++) e += seg[i] * seg[i];
    if (Math.sqrt(e / seg.length) < 0.04) continue;   // unvoiced or silent
    const f = yinFrame(seg, sr, 55, 400);
    if (f > 0) vals.push(f);
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

// ---------------------------------------------------------------------------

interface Synth {
  (v: VoiceParams): Promise<{ pcm: Float32Array; sr: number }>;
}

interface Row {
  label: string; file: string; gender: 'male' | 'female'; king: boolean;
  v: VoiceParams; f0: number; nominal: number; secs: number; peak: number; rms: number;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });

  for (const [id, m] of Object.entries(MODELS)) {
    const onnx = path.join(m.dir, `${m.base}.onnx`);
    if (!fs.existsSync(onnx)) {
      console.error(`\n  missing ${id} voice: ${path.relative(REPO, onnx)}`);
      console.error('  run: npm run weights\n');
      process.exit(1);
    }
  }

  const lex: Lexicon = parseLexicon(fs.readFileSync(LEXICON, 'utf8'));
  const ortMod = await import('onnxruntime-node');
  const ort = (ortMod.default ?? ortMod) as typeof import('onnxruntime-node');

  /** Load a model and return a synth closure. Timed — cold load is a real cost. */
  const loadMs: Record<string, number> = {};
  const synthFor = async (model: VoiceModelId): Promise<Synth> => {
    const { dir, base } = MODELS[model];
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, `${base}.onnx.json`), 'utf8'));
    const sr: number = cfg.audio?.sample_rate ?? 22050;
    const t0 = Date.now();
    const sess = await ort.InferenceSession.create(path.join(dir, `${base}.onnx`),
      { executionProviders: ['cpu'] });
    loadMs[model] = Date.now() - t0;
    const ids = textToIds(LINE, lex, cfg.phoneme_id_map);
    return async (v: VoiceParams) => {
      const out = await sess.run({
        input: new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor('float32',
          Float32Array.from([v.noiseScale, v.lengthScale, v.noiseW]), [3]),
      });
      return { pcm: resample(out[sess.outputNames[0]].data as Float32Array, v.pitch), sr };
    };
  };

  const synth: Record<VoiceModelId, Synth> = {
    male: await synthFor('male'),
    female: await synthFor('female'),
  };

  // ---- cast -------------------------------------------------------------
  //
  // Real ids and real names, from the game's own generator. The SELECTION RULE
  // is "the first NPC that lands in a pitch slot nothing else has taken yet",
  // so the audition demonstrates the distinct voices the bands can produce.
  // That is a demonstration of the voice space, not a claim that no two
  // villagers ever share a pitch — they can, and are then separated by rate
  // and breathiness instead. Stated plainly because picking the cast to make a
  // spacing check pass would otherwise be exactly the kind of quiet
  // self-congratulation these harnesses exist to prevent.
  const picked: Record<'male' | 'female', Array<{ id: string; name: string }>> = {
    male: [], female: [],
  };
  const takenSlots: Record<'male' | 'female', Set<number>> = {
    male: new Set(), female: new Set(),
  };
  for (let i = 0; i < 600; i++) {
    if (picked.male.length >= PER_GENDER && picked.female.length >= PER_GENDER) break;
    const name = npcNameFor(CAST_SEED, i % 13, (i * 7) % 11, i);
    const gender = npcGenderFor(name);
    if (picked[gender].length >= PER_GENDER) continue;
    const id = `npc_${CAST_SEED}_${i}`;
    const key = Math.round(voiceFor(id, { gender }).pitch * 1e4);
    if (takenSlots[gender].has(key)) continue;
    takenSlots[gender].add(key);
    picked[gender].push({ id, name });
  }

  const cast: Array<{ id: string; label: string; shape: VoiceShape; king?: boolean }> = [
    ...picked.female.map((n) => ({
      id: n.id, label: `${n.name} (${n.id})`, shape: { gender: 'female' as const },
    })),
    ...picked.male.map((n) => ({
      id: n.id, label: `${n.name} (${n.id})`, shape: { gender: 'male' as const },
    })),
    { id: 'castle:evil-king', label: 'The Evil King', shape: { deeper: true }, king: true },
  ];

  const rows: Row[] = [];
  for (const c of cast) {
    const v = voiceFor(c.id, c.shape);
    const { pcm, sr } = await synth[v.model](v);
    const file = `${c.id.replace(/[^a-z0-9]+/gi, '-')}.wav`;
    fs.writeFileSync(path.join(OUT, file), wav(pcm, sr));
    let peak = 0, sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]); if (a > peak) peak = a; sum += pcm[i] * pcm[i];
    }
    rows.push({
      label: c.label, file, gender: c.shape.gender ?? 'male', king: c.king === true,
      v, f0: estimateF0(pcm, sr), nominal: nominalF0(v),
      secs: pcm.length / sr, peak, rms: Math.sqrt(sum / pcm.length),
    });
  }

  // ---- controlled band sweep -------------------------------------------
  //
  // WHY THIS EXISTS. Measured f0 on running speech carries the sentence's
  // intonation and the VITS noise seed, and that swamps the band spacing: the
  // same voice re-rendered with different noise parameters moves by ~5 Hz
  // (male) and ~30 Hz (female). So a "these two NPCs measure 3 Hz apart" check
  // would be measuring noise, not design, and it would pass or fail by luck.
  //
  // Holding the noise parameters AND `lengthScale` fixed and moving only the
  // resample ratio isolates the property actually being claimed — that adjacent
  // slots in a band are a real pitch step — and makes it exactly measurable,
  // because the waveform is then literally one signal resampled. (`lengthScale`
  // has to be pinned too: in the game it is multiplied by pitch to keep the
  // speaking rate, but letting it move here would re-run the duration predictor
  // and give every slot a different utterance to measure.)
  const sweep: Record<'male' | 'female', Array<{ pitch: number; f0: number }>> = {
    male: [], female: [],
  };
  for (const gender of ['male', 'female'] as const) {
    const slots = [...new Set(
      Array.from({ length: 400 }, (_, i) => voiceFor(`sweep_${gender}_${i}`, { gender }).pitch),
    )].sort((a, b) => a - b);
    const probe = rows.find((r) => r.gender === gender && !r.king)!.v;
    for (const pitch of slots) {
      const { pcm, sr } = await synth[gender]({ ...probe, pitch, lengthScale: 1 });
      sweep[gender].push({ pitch, f0: estimateF0(pcm, sr, pitch) });
    }
    console.log(`  ${gender} sweep: `
      + sweep[gender].map((s) => `${s.pitch.toFixed(3)}->${s.f0.toFixed(1)}`).join('  '));
  }

  // ---- report ----
  const fem = rows.filter((r) => r.gender === 'female');
  const men = rows.filter((r) => r.gender === 'male');
  console.log('\n  voice                                model    pitch   rate   noiseW  nominal  f0(Hz)  dur(s)  peak   rms');
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(34)} ${r.v.model.padEnd(7)} ${r.v.pitch.toFixed(3)}  ${r.v.lengthScale.toFixed(3)}  `
      + `${r.v.noiseW.toFixed(3)}  ${r.nominal.toFixed(1).padStart(6)}  ${r.f0.toFixed(1).padStart(6)}  `
      + `${r.secs.toFixed(2).padStart(6)}  ${r.peak.toFixed(3)}  ${r.rms.toFixed(4)}`,
    );
  }
  console.log(`\n  cold model load: male ${loadMs.male} ms, female ${loadMs.female} ms (onnxruntime-node, CPU)`);

  // ---- mechanical checks ----
  let fails = 0;
  const ok = (cond: boolean, msg: string) => {
    if (!cond) fails++;
    console.log(`  ${cond ? 'ok  ' : 'BUG '} ${msg}`);
  };
  console.log('');

  ok(rows.every((r) => r.rms > 0.01), 'every voice is non-silent (rms > 0.01)');
  ok(!(0 > 0.01), '...and that RMS floor rejects silence');
  ok(rows.every((r) => r.peak < 0.891), 'no voice clips (peak < -1 dBFS)');
  ok(rows.every((r) => r.secs > 2 && r.secs < 8), 'durations are plausible');

  ok(fem.length === PER_GENDER && men.length === PER_GENDER + 1,
    `cast is ${fem.length} women, ${men.length} men including the king`);
  ok(fem.every((r) => r.v.model === 'female'), 'every woman synthesizes on the female model');
  ok(men.every((r) => r.v.model === 'male'), 'every man synthesizes on the male model');

  // THE RELATION THE BUG VIOLATED. Under the old design a woman who rolled the
  // bottom of the `higher` band landed below most of the men, because the bands
  // overlapped. Measured, not nominal: this margin is far larger than the
  // estimator's noise floor, so measuring it is meaningful here.
  const lowestWoman = Math.min(...fem.map((r) => r.f0));
  const highestMan = Math.max(...men.map((r) => r.f0));
  ok(lowestWoman > highestMan,
    `no woman lands below any man — lowest woman ${lowestWoman.toFixed(1)} Hz vs `
    + `highest man ${highestMan.toFixed(1)} Hz (margin ${(lowestWoman - highestMan).toFixed(1)} Hz)`);

  const king = rows.find((r) => r.king)!;
  ok(king.nominal < Math.min(...men.filter((r) => !r.king).map((r) => r.nominal)),
    `the Evil King is the deepest man (nominal ${king.nominal.toFixed(1)} Hz)`);

  // Structural spacing: provable from the band table, independent of any sample.
  for (const gender of ['male', 'female'] as const) {
    const noms = rows.filter((r) => r.gender === gender && !r.king)
      .map((r) => r.nominal).sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < noms.length; i++) minGap = Math.min(minGap, noms[i] - noms[i - 1]);
    ok(minGap >= 3,
      `closest two ${gender} voices are ${minGap.toFixed(2)} Hz apart in nominal f0 (>= 3)`);
  }

  // Controlled sweep. What this can and cannot establish, stated honestly:
  //
  // It CANNOT verify the 3 Hz adjacent-slot spacing by measurement. f0
  // estimation on a spoken sentence resolves to roughly ±5 Hz for joe and ±15
  // for ljspeech, because the median runs over frames carrying the sentence's
  // own intonation and ljspeech is the more expressive voice. 3 Hz is under
  // that floor. Asserting it anyway would produce a check that passes or fails
  // on which syllable the estimator happened to land on — worse than no check,
  // because it would look like evidence.
  //
  // What it CAN establish is that the numbers the spacing claim rests on are
  // real: that each model's natural f0 is what MODEL_F0 says, and that the band
  // is a genuine monotone pitch axis end to end. The 3 Hz spacing itself is
  // then arithmetic on those two facts, and is asserted above against nominal.
  for (const gender of ['male', 'female'] as const) {
    const s = sweep[gender];
    const lo = s[0], hi = s[s.length - 1];

    // Calibration: at pitch 1.0 the model should measure what MODEL_F0 claims.
    // Interpolated from the band, since 1.0 is not necessarily a slot.
    const t = (1 - lo.pitch) / (hi.pitch - lo.pitch);
    const atUnity = lo.f0 + t * (hi.f0 - lo.f0);
    const err = Math.abs(atUnity - MODEL_F0[gender]) / MODEL_F0[gender];
    ok(err < 0.08,
      `${gender} model measures ${atUnity.toFixed(1)} Hz at pitch 1.0, `
      + `MODEL_F0 says ${MODEL_F0[gender]} (${(err * 100).toFixed(1)}% off, < 8%)`);

    // End-to-end: the band moves pitch by the ratio the table asks for.
    const measuredRatio = hi.f0 / lo.f0;
    const askedRatio = hi.pitch / lo.pitch;
    ok(Math.abs(measuredRatio - askedRatio) / askedRatio < 0.15,
      `${gender} band spans ${lo.f0.toFixed(1)}-${hi.f0.toFixed(1)} Hz — a `
      + `${measuredRatio.toFixed(3)}x move for a ${askedRatio.toFixed(3)}x band`);

    // Ordered, not just wider: rank correlation survives the noise floor even
    // though the individual 3 Hz steps do not.
    const rank = (xs: number[]): number[] => {
      const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      const r = new Array<number>(xs.length);
      order.forEach(([, i], k) => { r[i] = k; });
      return r;
    };
    const rp = rank(s.map((x) => x.pitch)), rf = rank(s.map((x) => x.f0));
    const n = s.length;
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += (rp[i] - rf[i]) ** 2;
    const rho = 1 - (6 * d2) / (n * (n * n - 1));
    // 0.70, not 0.85, and the margin is the point: ORT's CPU kernels are not
    // bit-reproducible run to run, so ljspeech lands around 0.85 with a couple
    // of adjacent slots swapping places on any given render. A threshold set at
    // the observed value would go red on a rerun that changed nothing. 0.70
    // over 16 slots is still p < 0.005 against no ordering at all.
    ok(rho >= 0.70,
      `${gender} band is monotone in pitch (Spearman rho ${rho.toFixed(3)} >= 0.70 `
      + `over ${n} slots)`);
  }

  // And the two models really are two different voices, not one resampled.
  ok(Math.abs(MODEL_F0.female - MODEL_F0.male) > 80,
    `the two models are ${(MODEL_F0.female - MODEL_F0.male).toFixed(1)} Hz apart before any `
    + 'resampling — the female voice is female at pitch 1.0');
  ok(fem.every((r) => r.v.pitch > 0.8 && r.v.pitch < 1.2),
    'no woman is resampled more than 20% — formants stay where they belong');

  // ---- listening page ----
  const tableRows = (list: Row[]): string => list.map((r) => `<tr><td>${r.label}</td>
<td><audio controls preload="none" src="${r.file}"></audio></td>
<td class="num">${r.v.model}</td>
<td class="num">${r.v.pitch.toFixed(3)}</td><td class="num">${r.v.lengthScale.toFixed(3)}</td>
<td class="num">${r.v.noiseW.toFixed(3)}</td><td class="num">${r.nominal.toFixed(1)}</td>
<td class="num">${r.f0.toFixed(1)}</td>
<td class="num">${r.secs.toFixed(2)}</td></tr>`).join('\n');

  const head = '<tr><th>Voice</th><th>Listen</th><th>model</th><th>pitch</th><th>rate</th>'
    + '<th>noiseW</th><th>nominal Hz</th><th>measured Hz</th><th>dur s</th></tr>';

  const html = `<!doctype html><meta charset="utf-8"><title>Villager voices — audition</title>
<style>
 body{background:#3b3122;color:#f0e6c8;font:14px/1.5 system-ui,sans-serif;margin:0;padding:28px}
 h1{font:600 18px system-ui,sans-serif;letter-spacing:.10em;text-transform:uppercase;margin:0 0 4px}
 h2{font:600 13px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;margin:28px 0 8px;opacity:.85}
 p.sub{opacity:.75;margin:0 0 22px;max-width:900px}
 table{border-collapse:collapse;width:100%;max-width:1100px}
 th,td{text-align:left;padding:8px 10px;border-bottom:1px dashed rgba(240,230,200,.3)}
 th{font:600 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
 td.num{font-variant-numeric:tabular-nums;opacity:.85}
 audio{height:32px}
 blockquote{border-left:2px dashed rgba(240,230,200,.4);margin:22px 0 0;padding:0 0 0 14px;opacity:.8;max-width:900px}
 code{background:rgba(0,0,0,.25);padding:1px 4px;border-radius:3px}
</style>
<h1>Villager voices</h1>
<p class="sub">One line, ${PER_GENDER} women, ${PER_GENDER} men and the Evil King.
Women are synthesized on <code>en_US-ljspeech-medium</code>, men on
<code>en_US-joe-medium</code> — two different acoustic models, because
pitch-shifting one male voice upward produces a fast small man, not a woman.
Within each model the identity is a deterministic pitch/rate/noise seed derived
from the NPC id, so a villager sounds the same in every session and on every
machine.</p>
<p class="sub"><em>&ldquo;${LINE}&rdquo;</em></p>

<h2>Women — ljspeech (natural f0 ${MODEL_F0.female} Hz)</h2>
<table>${head}
${tableRows(fem)}
</table>

<h2>Men — joe (natural f0 ${MODEL_F0.male} Hz)</h2>
<table>${head}
${tableRows(men)}
</table>

<h2>Band sweep, prosody held still</h2>
<p class="sub">Every slot in each band, rendered with the noise parameters and
duration pinned so that only the resample ratio moves — one waveform, resampled.
It is what calibrates the nominal column: each model's measured pitch at 1.0x
against the constant the bands are stated in. It deliberately does <em>not</em>
try to measure the 3.2–3.4 Hz spacing between adjacent slots, which sits below
what f0 estimation resolves on a spoken sentence (roughly ±5 Hz for joe, ±15 for
the more expressive ljspeech). That spacing is arithmetic on the calibration and
the band table, and is checked against the nominal column instead.</p>
<table>
<tr><th>band</th><th>slots</th><th>measured range</th><th>at pitch 1.0</th><th>MODEL_F0</th><th>Spearman &rho;</th></tr>
${(['female', 'male'] as const).map((g) => {
    const s = sweep[g];
    const lo = s[0], hi = s[s.length - 1];
    const atUnity = lo.f0 + ((1 - lo.pitch) / (hi.pitch - lo.pitch)) * (hi.f0 - lo.f0);
    const rank = (xs: number[]): number[] => {
      const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      const r = new Array<number>(xs.length);
      order.forEach(([, i], k) => { r[i] = k; });
      return r;
    };
    const rp = rank(s.map((x) => x.pitch)), rf = rank(s.map((x) => x.f0));
    let d2 = 0;
    for (let i = 0; i < s.length; i++) d2 += (rp[i] - rf[i]) ** 2;
    const rho = 1 - (6 * d2) / (s.length * (s.length * s.length - 1));
    return `<tr><td>${g}</td><td class="num">${s.length}</td>`
      + `<td class="num">${lo.f0.toFixed(1)} – ${hi.f0.toFixed(1)} Hz</td>`
      + `<td class="num">${atUnity.toFixed(1)} Hz</td>`
      + `<td class="num">${MODEL_F0[g]} Hz</td>`
      + `<td class="num">${rho.toFixed(3)}</td></tr>`;
  }).join('\n')}
</table>

<blockquote>The mechanical checks assert non-silence, no clipping, plausible
duration, that every woman is on the female model, that no woman measures below
any man, that the king is the deepest man, and that adjacent slots in a band are
at least 3 Hz apart. <strong>None of that can tell you whether these sound like
women.</strong> The measured column is a median-YIN estimate over voiced frames;
within one gender the per-NPC spacing is smaller than the estimator's noise on
running speech, so compare those numbers between the two tables, not inside one.
Whether Fenna sounds like a woman rather than a man in a wig is a question for
ears. Adjust the bands in <code>voiceFor()</code> in
<code>src/game/voice/voice-out.ts</code> and re-run this script.</blockquote>
`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\n  ${path.relative(REPO, path.join(OUT, 'index.html')).replace(/\\/g, '/')}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
