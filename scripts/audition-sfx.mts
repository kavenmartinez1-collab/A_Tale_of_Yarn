/**
 * Audition pack — render every SFX to WAV and build a listening page.
 *
 *   npx tsx scripts/audition-sfx.mts [outDir]
 *
 * WHY
 *
 * Nobody in the loop that authored these sounds can hear them. The recipes were
 * written by reasoning about envelopes and filter bands, which is enough to make
 * a sound EXIST and nowhere near enough to make it GOOD. This turns the whole
 * roster into WAV files and one HTML page so somebody with ears and Ableton can
 * do the part that cannot be automated.
 *
 * WHAT COMES OUT
 *
 *   <outDir>/index.html          the listening page (spectrograms inlined)
 *   <outDir>/wav/<name>-v<N>.wav 4 seeded variants of every sound
 *   <outDir>/wav/bed-<name>.wav  6 s of each ambience bed
 *   <outDir>/stats.json          the measured numbers, machine-readable
 *
 * A "variant" is the same recipe with a different seed — see SFX_VARIANT in
 * `src/game/audio/sfx.ts`. Picking a different take is a one-line edit there,
 * and the page prints the exact line for each variant.
 *
 * Default outDir is `scripts/shots/audition`, which is gitignored: these are
 * regenerable evidence, not source.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SFX_NAMES, SFX_RECIPES, SFX_VARIANT, SFX_VARIANT_COUNT, SFX_RESERVED,
  AMBIENCE_BED_NAMES, AMBIENCE_BEDS,
  type SfxName, type SfxRecipe, type AmbienceBedName,
} from '../src/game/audio/sfx';

import {
  renderSfx, renderBed, encodeWav, analyse, SAMPLE_RATE, type Stats,
} from './audio-render.mts';

import { writePng } from './mesh-preview.mts';

const OUT = process.argv[2] ?? 'scripts/shots/audition';

/**
 * Sounds this deliverable added or changed. The page leads with these; the
 * untouched originals are still rendered underneath so relative level is
 * judgeable, which is the thing a solo listen cannot tell you.
 */
const NEW_OR_CHANGED: SfxName[] = [
  'tintreach_bolt', 'lock_on', 'lock_off', 'bow_draw', 'bow_loose',
  'shield_block', 'shield_parry', 'torch_light', 'torch_douse',
  'door_open', 'door_close', 'chest_close', 'footstep_wood', 'footstep_sand',
  // Changed: gains rebalanced because the offline render caught them clipping.
  'thunder', 'dragon_roar',
];

/** One line of human intent per sound. The rest of the page is measured. */
const NOTES: Partial<Record<SfxName, string>> = {
  tintreach_bolt: 'The signature effect. Crack at 55 ms, seam sizzling and re-striking at 10 Hz to 340 ms, roll-off to 1.10 s — the same three numbers tintreach.ts draws with (STRIKE_S / BURN_S / LIFE_S).',
  lock_on: 'Acquire. Rises 880 -> 1180 Hz with its octave on top.',
  lock_off: 'Release. Falls 780 -> 560 Hz, no octave, dry tick on the front. Must not be confusable with lock_on at low volume.',
  bow_draw: 'Creak, not whoosh. 14 Hz stick-slip flicker on a narrow 320 Hz band over a rising string tension.',
  bow_loose: 'String snap plus limb thump. Nothing else.',
  shield_block: 'RESERVED — no call site. Hide over board: all body, no ring.',
  shield_parry: 'RESERVED — no call site. The deliberate deflect: bright, rising, four times as long as a block.',
  torch_light: 'Strike, catch, burn. 18 Hz flicker while the flame finds the pitch.',
  torch_douse: 'Quench. 24 Hz steam flicker dying into a wet thud.',
  door_open: 'A hinge that has never been oiled — 11 Hz creak at Q=5, with the latch letting go first.',
  door_close: 'Thud then latch. No creak: a door being closed is pushed, not eased.',
  chest_close: 'The lid coming down. chest_open rises 300->500; this falls 260->150.',
  footstep_wood: 'Board over a void. The 165 Hz sine under the impact is the hollow.',
  footstep_sand: 'No transient at all — sand absorbs the strike and gives back the shuffle.',
  thunder: 'CHANGED: gains x0.75. Was peaking +1.17 dBFS with 354 hard-clipped samples at volume 1.0.',
  dragon_roar: 'CHANGED: gains x0.62 total. Was peaking +0.77 dBFS with 57 clipped samples.',
};

// ---------------------------------------------------------------------------
// FFT + spectrogram
// ---------------------------------------------------------------------------

/** In-place iterative radix-2 FFT. `re`/`im` must be a power-of-two length. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const FFT_N = 512;
const SPEC_W = 380;
const SPEC_H = 128;
const DB_FLOOR = -90;
/** Log frequency axis: this is audio, and a linear axis wastes 90% of the image. */
const F_LO = 40;
const F_HI = 20000;

/** Magma-ish ramp. t in 0..1. */
function colour(t: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0.00, 6, 5, 22],
    [0.25, 60, 15, 110],
    [0.50, 150, 40, 110],
    [0.75, 232, 104, 60],
    [1.00, 252, 240, 190],
  ];
  const k = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (k <= stops[i][0]) {
      const [p0, r0, g0, b0] = stops[i - 1];
      const [p1, r1, g1, b1] = stops[i];
      const u = (k - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * u, g0 + (g1 - g0) * u, b0 + (b1 - b0) * u];
    }
  }
  return [252, 240, 190];
}

/** STFT magnitude image, log-frequency, magma. Returns RGBA. */
function spectrogram(buf: Float32Array, sr = SAMPLE_RATE): Uint8Array {
  const rgba = new Uint8Array(SPEC_W * SPEC_H * 4);
  const hop = Math.max(1, Math.floor(Math.max(1, buf.length - FFT_N) / SPEC_W));
  const window = new Float64Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) {
    window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));
  }
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  const mag = new Float64Array(FFT_N / 2);

  for (let x = 0; x < SPEC_W; x++) {
    const start = x * hop;
    for (let i = 0; i < FFT_N; i++) {
      const j = start + i;
      re[i] = (j < buf.length ? buf[j] : 0) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    // Normalise so a full-scale sine reads 0 dB.
    for (let b = 0; b < FFT_N / 2; b++) {
      mag[b] = Math.hypot(re[b], im[b]) * (4 / FFT_N);
    }

    for (let y = 0; y < SPEC_H; y++) {
      // y = 0 is the TOP row = F_HI.
      const u = 1 - y / (SPEC_H - 1);
      const f = F_LO * Math.pow(F_HI / F_LO, u);
      const bin = f * FFT_N / sr;
      const b0 = Math.max(0, Math.floor(bin));
      const b1 = Math.min(FFT_N / 2 - 1, Math.max(b0, Math.ceil(bin)));
      // Take the max across the band this row covers, so a narrow tone is not
      // averaged into invisibility on the rows where bins are dense.
      let m = 0;
      for (let b = b0; b <= b1; b++) m = Math.max(m, mag[b]);
      const dB = m <= 0 ? DB_FLOOR : 20 * Math.log10(m);
      const t = (Math.max(DB_FLOOR, Math.min(0, dB)) - DB_FLOOR) / -DB_FLOOR;
      const [r, g, bl] = colour(t);
      const o = (y * SPEC_W + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

mkdirSync(path.join(OUT, 'wav'), { recursive: true });

interface Take {
  id: string;
  file: string;
  png: string;
  stats: Stats;
  variant: number;
  canonical: boolean;
}

const takes = new Map<string, Take[]>();
const statsOut: Record<string, unknown> = {};

function layerSummary(r: SfxRecipe): string {
  const bits: string[] = [];
  for (const l of r.osc ?? []) {
    const sweep = l.freqEnd !== undefined ? `${l.freq}->${l.freqEnd}` : `${l.freq}`;
    const fl = l.flickerHz ? ` flick${l.flickerHz}Hz` : '';
    bits.push(`${l.type} ${sweep}Hz g${l.gain ?? 1}${fl}`);
  }
  for (const l of r.noise ?? []) {
    const f = l.bandpass ? `bp${l.bandpass.freq}/Q${l.bandpass.Q}`
      : [l.highpass ? `hp${l.highpass}` : '', l.lowpass ? `lp${l.lowpass}` : ''].filter(Boolean).join('+') || 'flat';
    const fl = l.flickerHz ? ` flick${l.flickerHz}Hz` : '';
    bits.push(`${l.color} ${f} g${l.gain ?? 1}${fl}`);
  }
  return bits.join(' · ');
}

function emit(id: string, buf: Float32Array, variant: number, canonical: boolean): Take {
  const base = variant >= 0 ? `${id}-v${variant}` : id;
  const wavRel = `wav/${base}.wav`;
  writeFileSync(path.join(OUT, wavRel), encodeWav(buf));
  const pngAbs = path.join(OUT, 'wav', `${base}.png`);
  writePng(pngAbs, spectrogram(buf), SPEC_W, SPEC_H);
  const stats = analyse(buf);
  return { id, file: wavRel, png: `wav/${base}.png`, stats, variant, canonical };
}

console.log(`audition: rendering ${SFX_NAMES.length} sounds x ${SFX_VARIANT_COUNT} variants + `
  + `${AMBIENCE_BED_NAMES.length} beds -> ${OUT}`);

for (const name of SFX_NAMES) {
  const list: Take[] = [];
  for (let v = 0; v < SFX_VARIANT_COUNT; v++) {
    // event 0 — the first shot the game will play of the chosen variant.
    const buf = renderSfx(name, { variant: v, event: 0 });
    list.push(emit(name, buf, v, v === (SFX_VARIANT[name] ?? 0)));
  }
  takes.set(name, list);
  statsOut[name] = list.map((t) => ({
    variant: t.variant, seconds: t.stats.seconds,
    peakDb: +t.stats.peakDb.toFixed(2), rmsDb: +t.stats.rmsDb.toFixed(2),
    clipped: t.stats.clipped,
  }));
}

const bedTakes: Take[] = [];
for (const bed of AMBIENCE_BED_NAMES) {
  const buf = renderBed(bed, 6);
  const t = emit(`bed-${bed}`, buf, -1, true);
  bedTakes.push(t);
  statsOut[`bed:${bed}`] = {
    seconds: t.stats.seconds,
    peakDb: +t.stats.peakDb.toFixed(2), rmsDb: +t.stats.rmsDb.toFixed(2),
  };
}

writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(statsOut, null, 2));

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Spectrograms are inlined so the page renders from file:// with no server.
// The WAVs are NOT — they are what you drag into Ableton, and 4 MB of base64
// would make the page slow to open for no gain.
const pngCache = new Map<string, string>();
const dataUri = (rel: string): string => {
  const abs = path.join(OUT, rel);
  let b64 = pngCache.get(abs);
  if (b64 === undefined) {
    b64 = readFileSync(abs).toString('base64');
    pngCache.set(abs, b64);
  }
  return `data:image/png;base64,${b64}`;
};

function takeHtml(t: Take, name: string): string {
  const s = t.stats;
  const line = t.variant >= 0 ? `${name}: ${t.variant},` : '';
  return `<div class="take${t.canonical ? ' canon' : ''}">
    <div class="thead">
      <span class="vn">${t.variant >= 0 ? `variant ${t.variant}` : 'bed'}</span>
      ${t.canonical && t.variant >= 0 ? '<span class="badge">canonical</span>' : ''}
      <span class="nums">${s.seconds.toFixed(3)}s · peak ${s.peakDb.toFixed(1)} dBFS ·
        rms ${s.rmsDb.toFixed(1)} dBFS${s.clipped ? ` · <b class="bad">${s.clipped} CLIPPED</b>` : ''}</span>
    </div>
    <img src="${dataUri(t.png)}" width="${SPEC_W}" height="${SPEC_H}" alt="spectrogram">
    <audio controls preload="none" src="${t.file}"></audio>
    ${line ? `<code class="pick">${esc(line)}</code>` : ''}
  </div>`;
}

function sfxHtml(name: SfxName): string {
  const r = SFX_RECIPES[name];
  const list = takes.get(name) ?? [];
  const reserved = SFX_RESERVED.includes(name);
  return `<section id="${name}">
    <h3>${name}${reserved ? '<span class="res">reserved — no call site</span>' : ''}</h3>
    ${NOTES[name] ? `<p class="note">${esc(NOTES[name]!)}</p>` : ''}
    <p class="meta">duration ${r.duration}s · throttle ${r.throttleMs}ms ·
      rolloff ${r.maxDist ?? 50}m<br><span class="layers">${esc(layerSummary(r))}</span></p>
    <div class="takes">${list.map((t) => takeHtml(t, name)).join('')}</div>
  </section>`;
}

const changed = NEW_OR_CHANGED.filter((n) => (SFX_NAMES as readonly string[]).includes(n));
const rest = SFX_NAMES.filter((n) => !NEW_OR_CHANGED.includes(n));

const html = `<!doctype html><meta charset="utf-8">
<title>A Tale of Yarn — SFX audition</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f1218; color:#c9d3e0;
         font:13px/1.5 ui-sans-serif, system-ui, sans-serif; padding:18px 22px 60px; }
  h1 { font-size:19px; margin:0 0 4px; color:#e8d9a0; font-weight:650; }
  h2 { font-size:15px; margin:34px 0 6px; color:#8fb4e8; border-bottom:1px solid #232a36;
       padding-bottom:5px; }
  h3 { font-size:14px; margin:0 0 3px; color:#f0c674; font-weight:600; }
  .intro { max-width:860px; color:#93a1b4; }
  .intro code { background:#1a2029; padding:1px 4px; border-radius:3px; color:#c7b58a; }
  .intro b { color:#c9d3e0; }
  section { margin:0 0 20px; padding:10px 12px; background:#141922; border-radius:5px;
            border:1px solid #1e2530; }
  .note { margin:2px 0 6px; color:#a8b6c8; max-width:900px; }
  .meta { margin:0 0 8px; color:#6c7a8c; font-size:11.5px; }
  .layers { color:#5f7a5f; font-family:ui-monospace, monospace; font-size:11px; }
  .res { background:#3a2418; color:#e0a060; font-size:10px; padding:1px 6px;
         border-radius:8px; margin-left:8px; vertical-align:middle; font-weight:500; }
  .takes { display:flex; flex-wrap:wrap; gap:10px; }
  .take { background:#0d1117; border:1px solid #1e2530; border-radius:4px; padding:6px; }
  .take.canon { border-color:#4a6a3a; }
  .thead { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:11px; }
  .vn { color:#8fb4e8; font-weight:600; }
  .badge { background:#24351c; color:#9fd07a; font-size:10px; padding:1px 6px; border-radius:8px; }
  .nums { color:#6c7a8c; font-family:ui-monospace, monospace; }
  .bad { color:#e06060; }
  .take img { display:block; border-radius:2px; image-rendering:pixelated; }
  .take audio { width:${SPEC_W}px; height:30px; margin-top:5px; display:block; }
  .pick { display:block; margin-top:4px; font-size:10.5px; color:#7d8899;
          font-family:ui-monospace, monospace; }
  .axis { color:#4d5a6b; font-size:10.5px; font-family:ui-monospace, monospace; margin:2px 0 0; }
</style>

<h1>A Tale of Yarn — SFX audition</h1>
<div class="intro">
<p><b>Everything here is synthesized</b> from the recipe table in
<code>src/game/audio/sfx.ts</code>. There are no audio files in the game; these WAVs
are rendered offline by <code>scripts/audio-render.mts</code>, which interprets the
same data the live WebAudio engine interprets and shares its noise buffers, seeds,
envelopes and per-layer jitter. What you hear is what the game plays.</p>

<p><b>A "variant" is not a different sound design</b> — it is the same recipe with a
different seed. The seed drives the ±10% pitch jitter, the read offset into the
shared 2-second noise buffer, and the flicker steps. To make one canonical, copy the
line under it into <code>SFX_VARIANT</code> in <code>src/game/audio/sfx.ts</code>.
That makes the game's <i>first</i> shot of that sound identical to the file you picked;
later shots walk on from there, which is what stops footsteps sounding like a machine.</p>

<p><b>Approximations in this render, stated plainly.</b> Biquads are RBJ cookbook using
the Web Audio conventions (Q in dB for lowpass/highpass, linear Q for bandpass) — close
to a browser's but not bit-exact. Square/saw/triangle are additive band-limited sums
capped at 128 harmonics, so the very top end of the low oscillators is slightly duller
here than in Chrome. Sample rate is fixed at 48 kHz; the engine uses whatever the device
gives it, and the noise buffers are seeded by sample index, so a 44.1 kHz device gets
the same character with different grain. Master volume is <i>not</i> applied — these are
at voice level, i.e. intensity 1 and distance 0, the loudest the sound can be.</p>

<p><b>The mechanical tests only check that these are not broken</b> — duration within
bounds, peak under −1 dBFS, RMS above the silence floor, 48 kHz mono. Nothing in the
pipeline has an opinion about whether any of it sounds good. That is the part this page
exists to ask you.</p>

<p class="axis">Spectrograms: ${SPEC_W}×${SPEC_H}, 512-pt Hann STFT, log frequency
${F_LO} Hz (bottom) → ${(F_HI / 1000).toFixed(0)} kHz (top), ${DB_FLOOR} dB → 0 dB
dark→bright. Horizontal axis is the full declared duration of the sound.</p>
</div>

<h2>New and changed (${changed.length})</h2>
${changed.map(sfxHtml).join('\n')}

<h2>Ambience beds (${AMBIENCE_BED_NAMES.length}) — 6 s loops, not recipes</h2>
<div class="intro"><p>These are persistent looping nodes in the ambience graph, not
one-shots: <code>setAmbience</code> ramps their gain every frame. <code>rain_roof</code>
replaces the open-air rain hiss when <code>sheltered</code> is true (the open bed ducks
to 28%, not to zero — a roof is not a seal). <code>dungeon</code> and <code>castle</code>
are driven by new optional 0..1 fields on <code>AmbienceState</code> and are silent until
something sets them.</p></div>
<section id="beds">
  <div class="takes">${bedTakes.map((t, i) => {
    const bed = AMBIENCE_BED_NAMES[i] as AmbienceBedName;
    return `<div style="max-width:${SPEC_W}px">
      <h3>${bed}</h3>
      <p class="meta">bed gain ${AMBIENCE_BEDS[bed].gain} ·
        ${AMBIENCE_BEDS[bed].layers.length} layers<br>
        <span class="layers">${esc(AMBIENCE_BEDS[bed].layers.map((l) =>
          `${l.color} ${l.filter}${l.freq}/Q${l.Q} g${l.gain}${l.lfoHz ? ` lfo${l.lfoHz}Hz×${l.lfoDepth}` : ''}`).join(' · '))}</span></p>
      ${takeHtml(t, bed)}</div>`;
  }).join('')}</div>
</section>

<h2>Unchanged, for relative level (${rest.length})</h2>
${rest.map(sfxHtml).join('\n')}
`;

writeFileSync(path.join(OUT, 'index.html'), html);

const worst = [...takes.values()].flat().reduce((a, t) => Math.max(a, t.stats.peak), 0);
console.log(`  ${SFX_NAMES.length * SFX_VARIANT_COUNT + AMBIENCE_BED_NAMES.length} wav + png written`);
console.log(`  worst peak across the pack: ${(20 * Math.log10(worst)).toFixed(2)} dBFS`);
console.log(`  open ${path.join(OUT, 'index.html')}`);
