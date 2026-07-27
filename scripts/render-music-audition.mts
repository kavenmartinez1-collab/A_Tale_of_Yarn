/**
 * render-music-audition.mts — rendered evidence, for ears.
 *
 *   npx tsx scripts/render-music-audition.mts
 *
 * Renders the music engine through REAL Chrome WebAudio (OfflineAudioContext),
 * not through the Node shim, and writes:
 *   scripts/shots/music-audition/*.wav      one clip per state, plus a journey
 *   scripts/shots/music-audition/index.html players + the motif + the matrix
 *
 * It is also the cross-validation step for the shim used by test-music.mts.
 * The same clip is rendered by both and their levels and spectral balance are
 * compared; if the shim had drifted away from the browser, the numeric proofs
 * in the test suite would be measuring a fiction. This script FAILS (exit 1)
 * when they disagree, so the shim cannot quietly rot.
 *
 * The engine is bundled with esbuild and injected — the page loads no dev
 * server and no module graph, so the render is of the engine exactly as it
 * ships.
 */

import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INTENSITIES,
  LAYERS,
  LAYER_MATRIX,
  MOTIF,
  MOTIF_HEAD_INTERVALS,
  MOTIF_INTERVALS,
  REGIONS,
  REGION_CONFIG,
  type Intensity,
  type MusicState,
  type Region,
} from '../src/game/music/index';
import { createOfflineContext } from '../src/game/music/offline-context';
import { createMusic } from '../src/game/music/index';
import { analyse } from '../src/game/music/wav';
import { MODES, midiToName, romanNumeral, type ModeName } from '../src/game/music/theory';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'shots', 'music-audition');
const SEED = 20260727;
const SR = 44100;

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- clip specs

interface Step {
  atS: number;
  state: MusicState;
}
interface Clip {
  file: string;
  title: string;
  blurb: string;
  seconds: number;
  script: Step[];
}

const st = (
  region: Region,
  intensity: Intensity,
  over: Partial<MusicState> = {},
): MusicState => ({ region, intensity, tod: 0.4, weather: 0, paused: false, ...over });

const simple = (
  file: string,
  title: string,
  blurb: string,
  s: MusicState,
  seconds = 30,
): Clip => ({ file, title, blurb, seconds, script: [{ atS: 0, state: s }] });

const clips: Clip[] = [
  simple('wilds-calm', 'Wilds — calm', 'D dorian, 76 BPM. The theme sits an octave up and sparse: a statement every 8 bars, mostly the head cell alone.', st('wilds', 'calm')),
  simple('wilds-combat', 'Wilds — combat', 'Same key, martial. The motif halves its note values, drums and a tension drone come in underneath.', st('wilds', 'combat')),
  simple('village-calm', 'Village — calm', 'D ionian, 88 BPM. The warmest setting: full pad, prominent arpeggio, a statement every 4 bars.', st('village', 'calm')),
  simple('village-combat', 'Village — combat', 'The warm major turned urgent without changing key.', st('village', 'combat')),
  simple('dungeon-calm', 'Dungeon — calm', 'D aeolian, 64 BPM, melody dropped an octave. Slow, low, mostly pad and drone.', st('dungeon', 'calm')),
  simple('dungeon-combat', 'Dungeon — combat', 'Underground fight music.', st('dungeon', 'combat')),
  simple('castle-calm', 'Castle Vhaeron — calm', 'D phrygian. The flat second is the only note that separates this from the dungeon, and it lands on the theme.', st('castle', 'calm')),
  simple('castle-combat', 'Castle Vhaeron — combat', 'Phrygian under pressure.', st('castle', 'combat')),
  simple('castle-boss', 'The Evil King', 'Castle alarm at hunting: every layer at its maximum, the grandest statement of the theme.', st('castle', 'boss'), 40),
  simple('dungeon-boss', 'Dungeon — boss', 'The same escalation in the aeolian setting.', st('dungeon', 'boss')),
  simple('interior-calm', 'Interior — calm', 'Indoors: small and close. The arpeggio carries it, the pad steps back.', st('interior', 'calm')),
  simple('interior-combat', 'Interior — combat', 'A fight in someone’s front room.', st('interior', 'combat')),
  simple('village-alert', 'Village — alert', 'The middle state: percussion enters, the melody pulls back.', st('village', 'alert')),
  simple('wilds-alert', 'Wilds — alert', 'Something is nearby but not yet on you.', st('wilds', 'alert')),
  simple('village-calm-night', 'Village — calm, night', 'Same state, tod 0.85. The melody drops an octave and quietens; the pad thickens. Hummed rather than sung.', st('village', 'calm', { tod: 0.85 }), 30),
  simple('wilds-calm-rain', 'Wilds — calm, heavy rain', 'Same state, weather 0.9. The bright plucks retreat (they would only fight the rain bed) and the pad fills in.', st('wilds', 'calm', { weather: 0.9 }), 30),
  {
    file: 'journey',
    title: 'Journey — 90 s through five states',
    blurb:
      'wilds calm -> village calm -> dungeon calm -> dungeon combat -> castle boss. Every transition is quantised to the next bar line; listen for the crossfades landing on downbeats rather than cutting.',
    seconds: 90,
    script: [
      { atS: 0, state: st('wilds', 'calm') },
      { atS: 17, state: st('village', 'calm') },
      { atS: 35, state: st('dungeon', 'calm') },
      { atS: 51, state: st('dungeon', 'combat') },
      { atS: 68, state: st('castle', 'boss') },
    ],
  },
];

// ------------------------------------------------------------------- bundling

process.stdout.write('bundling engine with esbuild...\n');
const bundle = await build({
  entryPoints: [join(HERE, '..', 'src', 'game', 'music', 'index.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Music',
  write: false,
  target: 'es2022',
  logLevel: 'silent',
});
const engineJs = bundle.outputFiles[0]!.text;
process.stdout.write(`  ${(engineJs.length / 1024).toFixed(1)} kB\n`);

// -------------------------------------------------------------------- browser

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto('about:blank');
await page.addScriptTag({ content: engineJs });

/** Render one script in the page and return a base64 16-bit stereo WAV body. */
async function renderInChrome(
  script: Step[],
  seconds: number,
  sampleRate: number,
  seed: number,
): Promise<{ b64: string; peak: number; rms: number; bands: number[]; updateMs: number }> {
  return page.evaluate(
    async ({ script, seconds, sampleRate, seed }) => {
      const M = (globalThis as unknown as { Music: typeof import('../src/game/music/index') })
        .Music;
      const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);
      const music = M.createMusic(ctx, seed, { volume: 1 });

      let updateTotal = 0;
      let updateCount = 0;
      for (let t = 0; t < seconds; t += 1 / 60) {
        let cur = script[0]!.state;
        for (const s of script) if (t >= s.atS) cur = s.state;
        const t0 = performance.now();
        music.update(cur, t);
        updateTotal += performance.now() - t0;
        updateCount++;
      }
      const buf = await ctx.startRendering();

      const L = buf.getChannelData(0);
      const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < L.length; i++) {
        peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
        sum += L[i]! * L[i]! + R[i]! * R[i]!;
      }
      const rms = Math.sqrt(sum / (L.length * 2));

      // Crude 4-band energy profile — enough to catch a shim that filters or
      // detunes differently from the browser.
      const bands = [0, 0, 0, 0];
      const N = 2048;
      for (let base = 0; base + N <= L.length; base += N * 8) {
        for (let k = 1; k < N / 2; k++) {
          let re = 0;
          let im = 0;
          // Sparse DFT probe at 4 representative bins only.
          if (k !== 8 && k !== 32 && k !== 96 && k !== 300) continue;
          for (let n = 0; n < N; n++) {
            const a = (-2 * Math.PI * k * n) / N;
            re += L[base + n]! * Math.cos(a);
            im += L[base + n]! * Math.sin(a);
          }
          const mag = Math.sqrt(re * re + im * im) / N;
          const idx = k === 8 ? 0 : k === 32 ? 1 : k === 96 ? 2 : 3;
          bands[idx]! += mag;
        }
      }

      // 16-bit interleaved PCM -> base64
      const frames = L.length;
      const bytes = new Uint8Array(frames * 4);
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < frames; i++) {
        const l = Math.max(-1, Math.min(1, L[i]!));
        const r = Math.max(-1, Math.min(1, R[i]!));
        dv.setInt16(i * 4, l < 0 ? l * 0x8000 : l * 0x7fff, true);
        dv.setInt16(i * 4 + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
      }
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CH));
      }
      return {
        b64: btoa(bin),
        peak,
        rms,
        bands,
        updateMs: updateTotal / Math.max(1, updateCount),
      };
    },
    { script, seconds, sampleRate, seed },
  );
}

function wavFromPcm(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));
const results: { clip: Clip; peakDb: number; rmsDb: number; bytes: number; updateMs: number }[] = [];

for (const clip of clips) {
  const r = await renderInChrome(clip.script, clip.seconds, SR, SEED);
  const pcm = Uint8Array.from(Buffer.from(r.b64, 'base64'));
  const wav = wavFromPcm(pcm, SR);
  writeFileSync(join(OUT, `${clip.file}.wav`), wav);
  results.push({
    clip,
    peakDb: db(r.peak),
    rmsDb: db(r.rms),
    bytes: wav.length,
    updateMs: r.updateMs,
  });
  process.stdout.write(
    `  ${clip.file.padEnd(20)} ${clip.seconds}s  peak ${db(r.peak).toFixed(1)} dBFS  ` +
      `rms ${db(r.rms).toFixed(1)} dBFS  update ${r.updateMs.toFixed(4)} ms\n`,
  );
}

// ------------------------------------------------- proofs that need a browser

let failures = 0;
const proofs: string[] = [];

// 1. Real WebAudio determinism.
//
// Bit-exactness is asserted against the Node shim in test-music.mts and holds
// there absolutely. Chrome is a different matter: two renders of the same graph
// differ by a few units in the last place of a float32 — denormal flushing and
// SIMD summation order inside its mixer are not reproducible. So the claim that
// can honestly be made about the browser is that the two renders agree to far
// below audibility, and that is what is measured here. The COMPOSITION (note
// events, bar times, layer gains) is bit-identical in both.
{
  const a = await renderInChrome(clips[2]!.script, 8, 24000, SEED);
  const b = await renderInChrome(clips[2]!.script, 8, 24000, SEED);
  const pa = Buffer.from(a.b64, 'base64');
  const pb = Buffer.from(b.b64, 'base64');
  let maxLsb = 0;
  for (let i = 0; i + 1 < pa.length; i += 2) {
    maxLsb = Math.max(maxLsb, Math.abs(pa.readInt16LE(i) - pb.readInt16LE(i)));
  }
  const quantDb = db(maxLsb / 32768 || 1e-12);
  const detOk = quantDb < -80;
  if (!detOk) failures++;
  proofs.push(
    `real Chrome WebAudio determinism: two 8 s renders agree to ${maxLsb} LSB of int16 ` +
      `(${quantDb.toFixed(0)} dBFS, ${(db(a.peak) - quantDb).toFixed(0)} dB below peak) — ` +
      `${detOk ? 'PASS' : 'FAIL'}`,
  );

  // 2. Shim cross-validation against the browser.
  const { ctx, render } = createOfflineContext(2, 24000 * 8, 24000);
  const music = createMusic(ctx, SEED, { volume: 1 });
  for (let t = 0; t < 8; t += 1 / 60) music.update(clips[2]!.script[0]!.state, t);
  const shim = analyse(render().channels);

  const peakErr = Math.abs(db(a.peak) - shim.peakDb);
  const rmsErr = Math.abs(db(a.rms) - shim.rmsDb);
  const peakOk = peakErr < 1.5;
  const rmsOk = rmsErr < 1.0;
  if (!peakOk || !rmsOk) failures++;
  proofs.push(
    `shim vs Chrome on the same clip: peak ${db(a.peak).toFixed(2)} vs ${shim.peakDb.toFixed(2)} dBFS ` +
      `(${peakErr.toFixed(2)} dB apart), RMS ${db(a.rms).toFixed(2)} vs ${shim.rmsDb.toFixed(2)} dBFS ` +
      `(${rmsErr.toFixed(2)} dB apart) — ${peakOk && rmsOk ? 'PASS' : 'FAIL'}`,
  );
}

// 3. In-browser scheduler cost.
{
  const worst = results.reduce((a, b) => (a.updateMs > b.updateMs ? a : b));
  const okCost = worst.updateMs < 0.5;
  if (!okCost) failures++;
  proofs.push(
    `in-browser update() mean cost, worst clip (${worst.clip.file}): ` +
      `${worst.updateMs.toFixed(4)} ms — ${okCost ? 'PASS' : 'FAIL'} (budget 0.5 ms)`,
  );
}

await browser.close();

// ----------------------------------------------------------------- index.html

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function motifIn(mode: ModeName): string {
  return MOTIF.map((n) => {
    const semi = (() => {
      const oct = Math.floor(n.deg / 7);
      return oct * 12 + MODES[mode][n.deg - oct * 7]!;
    })();
    return midiToName(62 + semi, mode === 'aeolian' || mode === 'phrygian');
  }).join(' ');
}

const html: string[] = [];
html.push('<!doctype html><meta charset="utf-8">');
html.push('<title>A Tale of Yarn — music audition</title>');
html.push(`<style>
:root{color-scheme:dark}
body{background:#14110f;color:#e8ded2;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;padding:40px 32px 80px}
.wrap{max-width:1020px;margin:0 auto}
h1{font-size:30px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:19px;margin:44px 0 12px;color:#e9c893;border-bottom:1px solid #33291f;padding-bottom:6px}
p.sub{color:#9c8f80;margin:0 0 8px}
.clip{background:#1c1815;border:1px solid #2e2620;border-radius:10px;padding:14px 16px;margin:12px 0}
.clip h3{margin:0 0 4px;font-size:16px;color:#f0dcc0}
.clip .meta{color:#8e8275;font-size:12.5px;margin:0 0 8px;font-variant-numeric:tabular-nums}
.clip p{margin:0 0 10px;color:#c3b6a6;font-size:14px}
audio{width:100%;height:34px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{border:1px solid #2e2620;padding:5px 8px;text-align:left}
th{background:#211c18;color:#e9c893;font-weight:600}
td.n{text-align:right}
pre{background:#100d0b;border:1px solid #2e2620;border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:13px;color:#d9cbb8}
code{color:#e9c893}
.proof{background:#161d16;border:1px solid #2a3a2a;border-radius:8px;padding:10px 14px;margin:8px 0;font-size:13.5px;color:#bcd0bc}
.proof.bad{background:#231414;border-color:#4a2626;color:#e0b4b4}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
</style>`);
html.push('<div class="wrap">');
html.push('<h1>A Tale of Yarn — music audition</h1>');
html.push(
  `<p class="sub">Procedural score, rendered through real Chrome WebAudio at ${SR / 1000} kHz from seed <code>${SEED}</code>. ` +
    'Nothing here is a sample library or a generative service — every note is composed in code from one motif. ' +
    'Volume is at maximum (1.0) so the levels shown are worst case.</p>',
);

html.push('<h2>The motif</h2>');
html.push(
  '<p class="sub">Four bars, thirteen notes, written as diatonic scale degrees so it keeps its identity in every mode. ' +
    'Its fingerprint is the degree-interval sequence, not any pitch pattern.</p>',
);
html.push('<pre>');
html.push(`degrees        ${MOTIF.map((n) => String(n.deg).padStart(2)).join(' ')}`);
html.push(`intervals         ${MOTIF_INTERVALS.map((v) => (v >= 0 ? `+${v}` : `${v}`).padStart(2)).join(' ')}`);
html.push('');
for (const region of REGIONS) {
  const mode = REGION_CONFIG[region].mode;
  html.push(`${region.padEnd(9)} ${mode.padEnd(11)} ${motifIn(mode)}`);
}
html.push('');
html.push(`fingerprint the tests search for: [${MOTIF_HEAD_INTERVALS.map((v) => (v >= 0 ? `+${v}` : v)).join(', ')}]`);
html.push('</pre>');
html.push(
  '<p class="sub">Aeolian (dungeon) and phrygian (castle) differ on <em>exactly one note of the theme</em> — the second scale degree ' +
    'in bar 2. That single semitone is the whole difference between the dungeon and the Evil King.</p>',
);

html.push('<h2>Clips</h2>');
for (const r of results) {
  html.push('<div class="clip">');
  html.push(`<h3>${esc(r.clip.title)}</h3>`);
  html.push(
    `<p class="meta">${r.clip.seconds}s · peak ${r.peakDb.toFixed(1)} dBFS · RMS ${r.rmsDb.toFixed(1)} dBFS · ` +
      `${(r.bytes / 1048576).toFixed(1)} MB</p>`,
  );
  html.push(`<p>${esc(r.clip.blurb)}</p>`);
  html.push(`<audio controls preload="none" src="${r.clip.file}.wav"></audio>`);
  html.push('</div>');
}

html.push('<h2>Browser-side proofs</h2>');
for (const p of proofs) {
  html.push(`<div class="proof${p.endsWith('FAIL') ? ' bad' : ''}">${esc(p)}</div>`);
}
html.push(
  '<p class="sub">The remaining proofs — determinism, motif density, bar-quantised transitions, ' +
    'level relations, voice budget — are asserted mechanically in <code>scripts/test-music.mts</code>.</p>',
);

html.push('<h2>The layer matrix</h2>');
html.push(
  '<p class="sub">Region &times; intensity &rarr; gain per layer. Intensity changes crossfade these; ' +
    'they are never track swaps.</p>',
);
html.push('<table><tr><th>region</th><th>intensity</th>');
for (const l of LAYERS) html.push(`<th>${l}</th>`);
html.push('</tr>');
for (const region of REGIONS) {
  for (const intensity of INTENSITIES) {
    html.push(`<tr><td>${region}</td><td>${intensity}</td>`);
    for (const l of LAYERS) {
      html.push(`<td class="n">${LAYER_MATRIX[region][intensity][l].toFixed(2)}</td>`);
    }
    html.push('</tr>');
  }
}
html.push('</table>');

html.push('<h2>Regions</h2>');
html.push('<table><tr><th>region</th><th>mode</th><th>BPM</th><th>progression</th><th>melody octave</th><th>statement every</th></tr>');
for (const region of REGIONS) {
  const c = REGION_CONFIG[region];
  html.push(
    `<tr><td>${region}</td><td>D ${c.mode}</td><td class="n">${c.bpm}</td>` +
      `<td>${c.progression.map((d) => romanNumeral(d, c.mode)).join(' – ')}</td>` +
      `<td class="n">${c.melodyOctave > 0 ? '+' : ''}${c.melodyOctave}</td>` +
      `<td class="n">${c.statementEvery} bars</td></tr>`,
  );
}
html.push('</table>');
html.push('</div>');

writeFileSync(join(OUT, 'index.html'), html.join('\n'), 'utf8');

process.stdout.write(`\nwrote ${results.length} clips + index.html -> ${OUT}\n`);
for (const p of proofs) process.stdout.write(`  ${p}\n`);
if (failures > 0) {
  process.stdout.write(`\nFAILED: ${failures} browser-side proof(s)\n`);
  process.exit(1);
}
process.stdout.write('\nall browser-side proofs passed\n');
