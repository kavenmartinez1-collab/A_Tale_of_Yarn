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
 * exactly what the game will use — not a re-derivation that could drift.
 *
 * Run: npx tsx scripts/voice-audition.mts
 * Out: scripts/shots/audition/voices/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLexicon, textToIds } from '../src/audio/g2p-en';
import { voiceFor, type VoiceParams } from '../src/game/voice/voice-out';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const MODEL_DIR = path.join(REPO, 'models', 'rhasspy--piper-en-us-joe-medium');
const OUT = path.join(here, 'shots', 'audition', 'voices');

/** The sample cast. Ids are what the game uses — `${settlement}:${name}`-ish. */
const CAST: Array<{ id: string; label: string; shape?: { higher?: boolean; deeper?: boolean } }> = [
  { id: 'rivermeet:petra', label: 'Petra (merchant, Rivermeet)', shape: { higher: true } },
  { id: 'rivermeet:gorm', label: 'Gorm (smith, Rivermeet)' },
  { id: 'rivermeet:hilda', label: 'Hilda (farmer, Rivermeet)', shape: { higher: true } },
  { id: 'rivermeet:aldric', label: 'Aldric (guard, Rivermeet)' },
  { id: 'rivermeet:sven', label: 'Sven (hunter, Rivermeet)' },
  { id: 'castle:evil-king', label: 'The Evil King', shape: { deeper: true } },
];

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
 * Dominant pitch of a voiced segment, by autocorrelation.
 *
 * Used only to REPORT how far apart the voices actually sit — a claim of
 * "audibly distinct" backed by nothing but the parameters would be a claim
 * about the code, not about the sound.
 */
function estimateF0(pcm: Float32Array, sampleRate: number): number {
  const minHz = 60, maxHz = 320;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.floor(sampleRate / minHz);
  // Take the loudest 40 ms window — silence has no pitch.
  const win = Math.floor(sampleRate * 0.04);
  let best = 0, bestE = 0;
  for (let s = 0; s + win < pcm.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += pcm[i] * pcm[i];
    if (e > bestE) { bestE = e; best = s; }
  }
  const seg = pcm.subarray(best, Math.min(pcm.length, best + maxLag * 2));
  let bestLag = 0, bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < seg.length; lag++) {
    let c = 0;
    for (let i = 0; i + lag < seg.length; i++) c += seg[i] * seg[i + lag];
    c /= seg.length - lag;
    if (c > bestCorr) { bestCorr = c; bestLag = lag; }
  }
  return bestLag ? sampleRate / bestLag : 0;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'en_US-joe-medium.onnx.json'), 'utf8'));
  const lex = parseLexicon(fs.readFileSync(path.join(MODEL_DIR, 'lexicon-en-us.txt'), 'utf8'));
  const sr: number = cfg.audio?.sample_rate ?? 22050;

  const ortMod = await import('onnxruntime-node');
  const ort = (ortMod.default ?? ortMod) as typeof import('onnxruntime-node');
  const sess = await ort.InferenceSession.create(path.join(MODEL_DIR, 'en_US-joe-medium.onnx'),
    { executionProviders: ['cpu'] });

  const ids = textToIds(LINE, lex, cfg.phoneme_id_map);
  const rows: Array<{
    label: string; file: string; v: VoiceParams; f0: number;
    secs: number; peak: number; rms: number;
  }> = [];

  for (const c of CAST) {
    const v = voiceFor(c.id, c.shape ?? {});
    const out = await sess.run({
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32',
        Float32Array.from([v.noiseScale, v.lengthScale, v.noiseW]), [3]),
    });
    const pcm = resample(out[sess.outputNames[0]].data as Float32Array, v.pitch);
    const file = `${c.id.replace(/[^a-z0-9]+/gi, '-')}.wav`;
    fs.writeFileSync(path.join(OUT, file), wav(pcm, sr));

    let peak = 0, sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]); if (a > peak) peak = a; sum += pcm[i] * pcm[i];
    }
    rows.push({
      label: c.label, file, v, f0: estimateF0(pcm, sr),
      secs: pcm.length / sr, peak, rms: Math.sqrt(sum / pcm.length),
    });
  }

  // ---- report ----
  console.log('\n  voice                            pitch   rate   noiseW  f0(Hz)  dur(s)  peak   rms');
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(30)} ${r.v.pitch.toFixed(3)}  ${r.v.lengthScale.toFixed(3)}  `
      + `${r.v.noiseW.toFixed(3)}  ${r.f0.toFixed(1).padStart(6)}  ${r.secs.toFixed(2).padStart(6)}  `
      + `${r.peak.toFixed(3)}  ${r.rms.toFixed(4)}`,
    );
  }

  // ---- mechanical checks ----
  let fails = 0;
  const ok = (cond: boolean, msg: string) => {
    if (!cond) fails++;
    console.log(`  ${cond ? 'ok  ' : 'BUG '} ${msg}`);
  };
  console.log('');
  ok(rows.every((r) => r.rms > 0.01), 'every voice is non-silent (rms > 0.01)');
  ok(rows.every((r) => r.peak < 0.891), 'no voice clips (peak < -1 dBFS)');
  ok(rows.every((r) => r.secs > 2 && r.secs < 8), 'durations are plausible');
  const f0s = rows.map((r) => r.f0).sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < f0s.length; i++) minGap = Math.min(minGap, f0s[i] - f0s[i - 1]);
  ok(minGap >= 2, `closest two voices differ by ${minGap.toFixed(1)} Hz of f0`);
  ok(f0s[f0s.length - 1] - f0s[0] > 20,
    `f0 spread ${(f0s[f0s.length - 1] - f0s[0]).toFixed(1)} Hz across the cast`);

  // ---- listening page ----
  const html = `<!doctype html><meta charset="utf-8"><title>Villager voices — audition</title>
<style>
 body{background:#3b3122;color:#f0e6c8;font:14px/1.5 system-ui,sans-serif;margin:0;padding:28px}
 h1{font:600 18px system-ui,sans-serif;letter-spacing:.10em;text-transform:uppercase;margin:0 0 4px}
 p.sub{opacity:.75;margin:0 0 22px}
 table{border-collapse:collapse;width:100%;max-width:1000px}
 th,td{text-align:left;padding:8px 10px;border-bottom:1px dashed rgba(240,230,200,.3)}
 th{font:600 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
 td.num{font-variant-numeric:tabular-nums;opacity:.85}
 audio{height:32px}
 blockquote{border-left:2px dashed rgba(240,230,200,.4);margin:22px 0 0;padding:0 0 0 14px;opacity:.8;max-width:900px}
</style>
<h1>Villager voices</h1>
<p class="sub">One line, six villagers. Same acoustic model — the identity is a
deterministic pitch/rate/noise seed derived from the NPC id, so Petra sounds
like Petra in every session and on every machine.</p>
<p class="sub"><em>&ldquo;${LINE}&rdquo;</em></p>
<table>
<tr><th>Voice</th><th>Listen</th><th>pitch</th><th>rate</th><th>noiseW</th><th>f0 Hz</th><th>dur s</th></tr>
${rows.map((r) => `<tr><td>${r.label}</td>
<td><audio controls preload="none" src="${r.file}"></audio></td>
<td class="num">${r.v.pitch.toFixed(3)}</td><td class="num">${r.v.lengthScale.toFixed(3)}</td>
<td class="num">${r.v.noiseW.toFixed(3)}</td><td class="num">${r.f0.toFixed(1)}</td>
<td class="num">${r.secs.toFixed(2)}</td></tr>`).join('\n')}
</table>
<blockquote>Mechanical checks only assert non-silence, no clipping, plausible
duration and measurable f0 separation. Whether these read as <em>different
people</em> rather than one person with a head cold is a question for ears.
Adjust the bands in <code>voiceFor()</code> in
<code>src/game/voice/voice-out.ts</code> and re-run this script.</blockquote>
`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\n  ${path.relative(REPO, path.join(OUT, 'index.html')).replace(/\\/g, '/')}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
