/**
 * render-music-integration — the evidence the developer can actually judge.
 *
 *   npx tsx scripts/render-music-integration.mts
 *
 * Writes scripts/shots/music-integration/*.wav plus an index.html that plays
 * them, with the measured numbers next to each clip.
 *
 * WHY THIS EXISTS. Everything in scripts/test-music.mts is a mechanical fact:
 * this fade ends on that downbeat, this RMS is within 10% of that one. All of
 * it can be true while the handoff still sounds wrong, and I cannot hear the
 * output. So the tests gate what is measurable and THESE CLIPS ARE THE ACTUAL
 * DELIVERABLE — the developer listens, and their verdict is the one that counts.
 *
 * Rendered through the Node shim rather than Chrome. The shim is the same one
 * scripts/render-music-audition.mts cross-validates against real Chrome
 * WebAudio (peak within 1.5 dB, RMS within 1.0 dB), and it lets a clip be
 * rendered faster than real time with no browser in the loop. The song path it
 * exercises is a gain multiply and a buffer read, which is the part of WebAudio
 * least likely to differ between implementations.
 *
 * The engine is NOT reimplemented here. Every clip drives the real
 * createMusic().update() loop at 60 Hz with a real region script, and the real
 * InterludeController decides when the handoff happens. Two injection points
 * are used (see InterludeOptions): when the first interlude fires, and — for
 * the overworld clips — a 60-second excerpt in place of the full song, so that
 * a three-minute clip can contain BOTH transitions instead of just the first.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEGMENTS,
  SONGS,
  createMusic,
  type InterludeEvent,
  type MusicState,
  type Region,
  type SegmentId,
  type SongId,
  type SongSegment,
} from '../src/game/music/index';
import { createOfflineContext } from '../src/game/music/offline-context';
import { encodeWav } from '../src/game/music/wav';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const MUSIC_DIR = join(REPO, 'models', 'music');
const OUT = join(HERE, 'shots', 'music-integration');
const SEED = 20260727;
const SR = 44100;

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

interface Pcm {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * ffmpeg stands in for `decodeAudioData` here — Node has no WebAudio decoder,
 * and it is the same decoder prepare-music.mts measures the levels with, so the
 * gains in songs.ts were derived from exactly these samples.
 */
function decode(file: string): Pcm | null {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30, encoding: 'buffer' },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 1024) return null;
  const inter = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const frames = Math.floor(inter.length / 2);
  const l = new Float32Array(frames);
  const rr = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = inter[i * 2]!;
    rr[i] = inter[i * 2 + 1]!;
  }
  return { channels: [l, rr], sampleRate: SR };
}

const decoded = new Map<SongId, Pcm>();
for (const id of Object.keys(SONGS) as SongId[]) {
  const file = join(MUSIC_DIR, SONGS[id].file);
  if (!existsSync(file)) {
    console.error(`missing ${file} — run \`npx tsx scripts/prepare-music.mts\` first`);
    process.exit(1);
  }
  const pcm = decode(file);
  if (!pcm) {
    console.error(`could not decode ${file} — ffmpeg is required`);
    process.exit(1);
  }
  decoded.set(id, pcm);
  process.stdout.write(
    `  decoded ${SONGS[id].file.padEnd(22)} ${(pcm.channels[0]!.length / SR).toFixed(2)} s\n`,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface ClipSpec {
  file: string;
  title: string;
  blurb: string;
  seconds: number;
  /** [untilSeconds, region] steps. */
  script: [number, Region][];
  firstAt?: number;
  segments?: Partial<Record<SegmentId, SongSegment>>;
  rotation?: readonly SegmentId[];
}

function renderClip(spec: ClipSpec) {
  const { ctx, render } = createOfflineContext(2, Math.floor(SR * spec.seconds), SR);
  const music = createMusic(ctx, SEED, {
    volume: 1,
    interlude: {
      firstAt: spec.firstAt,
      segments: spec.segments,
      rotation: spec.rotation,
    },
  });
  // Hand the decoded buffers straight to the library: this is exactly what
  // decodeAudioData would have produced in the browser.
  for (const [id, pcm] of decoded) {
    const buf = ctx.createBuffer(2, pcm.channels[0]!.length, SR);
    buf.getChannelData(0).set(pcm.channels[0]!);
    buf.getChannelData(1).set(pcm.channels[1]!);
    music.songs.provide(id, buf);
  }

  let t = 0;
  for (const [until, region] of spec.script) {
    const st: MusicState = { region, intensity: 'calm', tod: 0.4, weather: 0, paused: false };
    for (; t < until; t += 1 / 60) music.update(st, t);
  }
  const snap = music.snapshot(spec.seconds - 0.001);
  return { out: render(), events: [...snap.events] };
}

// ---------------------------------------------------------------------------
// Measurement — the mechanical gates
// ---------------------------------------------------------------------------

const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));

function rmsOf(ch: readonly Float32Array[], a: number, b: number): number {
  let s = 0;
  let n = 0;
  for (const c of ch) {
    for (let i = Math.max(0, a); i < Math.min(c.length, b); i++) {
      s += c[i]! * c[i]!;
      n++;
    }
  }
  return Math.sqrt(s / Math.max(1, n));
}

/**
 * The longest run of near-silence within [fromS, toS), in ms.
 *
 * THE GATE IS "no gap > 120 ms AT ANY TRANSITION", and the word `transition` is
 * doing real work. Scanning the whole clip was tried first and it measures the
 * wrong thing twice over:
 *
 *   - the clip's own first bar is the engine fading up from nothing, which is
 *     not a transition and is documented behaviour (START_DELAY, then a
 *     one-bar fade); and
 *   - the castle master OPENS with five one-second rests, and the dungeon track
 *     has two more. Those are the developer's composition. A gate that failed
 *     on them would be demanding the music be different, which is not this
 *     harness's business.
 *
 * So gaps are measured in windows around the handoff stages, where a hole would
 * genuinely mean the engine dropped the ball. The whole-clip figure is still
 * reported alongside, as information rather than as a gate.
 */
function longestGapMs(
  ch: readonly Float32Array[],
  sampleRate: number,
  fromS = 0,
  toS = Infinity,
): { ms: number; atS: number } {
  const win = Math.round(0.01 * sampleRate); // 10 ms resolution
  const floor = Math.pow(10, -60 / 20);
  let best = 0;
  let bestAt = 0;
  let run = 0;
  let runStart = 0;
  const frames = ch[0]!.length;
  const a = Math.max(0, Math.round(fromS * sampleRate));
  const b = Math.min(frames, toS === Infinity ? frames : Math.round(toS * sampleRate));
  for (let i = a; i + win <= b; i += win) {
    const r = rmsOf(ch, i, i + win);
    if (r < floor) {
      if (run === 0) runStart = i;
      run += win;
      if (run > best) {
        best = run;
        bestAt = runStart;
      }
    } else {
      run = 0;
    }
  }
  return { ms: (best / sampleRate) * 1000, atS: bestAt / sampleRate };
}

/** The worst gap across every transition window in the clip. */
function transitionGap(
  ch: readonly Float32Array[],
  sampleRate: number,
  events: readonly InterludeEvent[],
  extraPoints: readonly number[] = [],
): { ms: number; atS: number; where: string } {
  const points: { t: number; what: string }[] = [];
  for (const e of events) {
    if (e.kind === 'thin' || e.kind === 'pivot' || e.kind === 'song-start'
      || e.kind === 'pad-out' || e.kind === 'exit' || e.kind === 'bed-return') {
      points.push({ t: e.at, what: e.kind });
    }
  }
  for (const t of extraPoints) points.push({ t, what: 'loop seam' });
  let worst = { ms: 0, atS: 0, where: 'none' };
  for (const p of points) {
    // +/- 1.2 s: the JOIN, which is what the engine is answerable for. Wider
    // than that and the window starts reaching into the developer's own music
    // and grading their rests, which is not this gate's business.
    const g = longestGapMs(ch, sampleRate, p.t - 1.2, p.t + 1.2);
    if (g.ms > worst.ms) worst = { ms: g.ms, atS: g.atS, where: p.what };
  }
  return worst;
}

interface Handoff {
  label: string;
  /** RMS window before the handoff (the bed). */
  beforeDb: number;
  /** RMS window after it (the song), or vice versa. */
  afterDb: number;
  deltaDb: number;
}

/**
 * Level continuity across each handoff.
 *
 * Measured bed-to-song and song-to-bed, over 4-second windows placed clear of
 * the transition itself — the point is whether the player notices a jump in
 * loudness between "procedural music" and "the developer's music", not what
 * happens during the crossfade, which is supposed to move.
 */
function handoffs(
  ch: readonly Float32Array[],
  sampleRate: number,
  events: readonly InterludeEvent[],
): Handoff[] {
  const out: Handoff[] = [];
  const idx = (s: number) => Math.round(s * sampleRate);
  const BED = Math.round(8 * sampleRate);
  const PAD = Math.round(2 * sampleRate);

  const thin = events.find((e) => e.kind === 'thin');
  const song = events.find((e) => e.kind === 'song-start');
  const exit = events.find((e) => e.kind === 'exit');
  const ret = events.find((e) => e.kind === 'bed-return');
  if (!thin || !song) return out;

  // The SONG's level is measured over a long window covering the body of what
  // actually plays, not a four-second slice next to the join. Music has
  // dynamics — 500 nanometers moves 8 dB across a minute, and the castle track
  // opens with five bars of near-silence by design. A short window next to the
  // transition measures the composition's own shape and calls it a level
  // mismatch. What the gate is for is whether the SONG and the BED sit at
  // compatible levels, and that is a question about their bodies.
  const songFrom = idx(song.at) + PAD;
  const songTo = exit ? Math.max(songFrom + BED, idx(exit.at) - PAD) : songFrom + BED;
  const songDb = db(rmsOf(ch, songFrom, Math.min(songTo, ch[0]!.length)));

  const bedBeforeA = Math.max(0, idx(thin.at) - PAD - BED);
  out.push({
    label: 'bed -> song',
    beforeDb: db(rmsOf(ch, bedBeforeA, bedBeforeA + BED)),
    afterDb: songDb,
    deltaDb: songDb - db(rmsOf(ch, bedBeforeA, bedBeforeA + BED)),
  });

  if (ret) {
    const bedAfterA = idx(ret.at) + PAD;
    if (bedAfterA + BED <= ch[0]!.length) {
      const bedAfter = db(rmsOf(ch, bedAfterA, bedAfterA + BED));
      out.push({
        label: 'song -> bed',
        beforeDb: songDb,
        afterDb: bedAfter,
        deltaDb: bedAfter - songDb,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The clips
// ---------------------------------------------------------------------------

/** A 60-second excerpt of a segment, so a 3-minute clip holds both transitions. */
function excerpt(id: SegmentId, seconds: number): SongSegment {
  const base = SEGMENTS[id];
  // A 2 s tail fade, which is exactly what the shipping `ryan-a` segment does
  // where it splits: a truncated segment ends as a decision, not as a cut.
  return { ...base, endS: base.startS + seconds, fadeOutS: 2.0 };
}

const CLIPS: ClipSpec[] = [
  {
    file: 'overworld-500nanometers',
    title: 'Overworld — into and out of "500 nanometers"',
    blurb:
      'Wilds. 40 s of the procedural bed, the three-stage thin/pivot/enter handoff, ' +
      '60 s of the song, then the exit and the bed coming back. The pad you hear ' +
      'holding through the join has modulated from D dorian to F minor — the song\'s key.',
    seconds: 180,
    script: [[180, 'wilds']],
    firstAt: 30,
    segments: { '500nm': excerpt('500nm', 60) },
    rotation: ['500nm'],
  },
  {
    file: 'overworld-ryans-song',
    title: 'Overworld — into and out of "Ryan\'s song", part one',
    blurb:
      'The same protocol with the second segment in the rotation. This one modulates ' +
      'the pad to E-flat minor. Note that the bed it leaves and returns to is ' +
      'identical to the clip above — only the pivot differs.',
    seconds: 180,
    script: [[180, 'wilds']],
    firstAt: 30,
    segments: { 'ryan-a': excerpt('ryan-a', 60) },
    rotation: ['ryan-a'],
  },
  {
    file: 'dungeon-loop-two-seams',
    title: 'Dungeon — "Untitled Song", crossing the loop seam twice',
    blurb:
      'Entering a dungeon starts the track immediately. The loop returns from ' +
      '62.072 s to 7.811 s with a 1.043 s crossfade; on this clip the seams fall at ' +
      'about 72 s and about 126 s. The intro, with its two rests, plays once and is ' +
      'never heard again.',
    seconds: 140,
    script: [[140, 'dungeon']],
  },
  {
    file: 'dungeon-loop-closeup',
    title: 'Dungeon — the loop seam, close up',
    blurb:
      'The same seam with the run-up removed: about 8 s either side of the first ' +
      'join, so it can be judged without hunting for it. If the loop is working, ' +
      'there is nothing here to hear.',
    seconds: 16, // sliced out of the clip above, not rendered separately
    script: [],
  },
  {
    file: 'castle-vhaeron',
    title: 'Castle Vhaeron — the raw "Project 1" master',
    blurb:
      'The castle track as it stands today: the unedited master, vendored bit-exact. ' +
      'prepare-music.mts will pick up music-src/processed/project1-castle.wav the ' +
      'moment an edited version exists, with no code change. The pivot pad is an ' +
      'open fifth A-E, which is consonant whether the piece is heard in A or in E.',
    seconds: 120,
    script: [[120, 'castle']],
  },
];

interface Result {
  spec: ClipSpec;
  peak: number;
  rmsDb: number;
  gapMs: number;
  gapAtS: number;
  anyGapMs: number;
  handoffs: Handoff[];
  events: InterludeEvent[];
  bytes: number;
}

const results: Result[] = [];
let failures = 0;
const fail = (msg: string) => {
  failures++;
  process.stdout.write(`    GATE FAILED: ${msg}\n`);
};

process.stdout.write('\nrendering:\n');

let closeupSource: { channels: Float32Array[]; events: InterludeEvent[] } | null = null;

for (const spec of CLIPS) {
  let channels: Float32Array[];
  let events: InterludeEvent[];

  if (spec.file === 'dungeon-loop-closeup') {
    // Sliced out of the clip rendered just above — literally the same samples,
    // so the close-up cannot disagree with the long version about the join.
    if (!closeupSource) continue;
    const start = Math.max(0, Math.round((closeupSeamS(closeupSource.events) - 8) * SR));
    const len = Math.round(spec.seconds * SR);
    channels = closeupSource.channels.map((c) => c.slice(start, start + len));
    events = [];
  } else {
    const r = renderClip(spec);
    channels = r.out.channels;
    events = r.events;
    if (spec.file === 'dungeon-loop-two-seams') closeupSource = { channels, events };
  }

  let peak = 0;
  for (const c of channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
  const rms = rmsOf(channels, 0, channels[0]!.length);
  // Loop seams count as transitions too — they are the dungeon clip's point.
  const seamPoints: number[] = [];
  {
    const start = events.find((e) => e.kind === 'song-start');
    const loop = SEGMENTS.untitled.loop;
    if (start && spec.file.startsWith('dungeon') && loop) {
      let t = start.at + (loop.endS - SEGMENTS.untitled.startS);
      while (t < channels[0]!.length / SR) {
        seamPoints.push(t);
        t += loop.endS - loop.startS;
      }
    }
  }
  const gap = transitionGap(channels, SR, events, seamPoints);
  // Reported alongside as information, never as a gate: the rests inside the
  // developer's own compositions are longer than 120 ms and are supposed to be.
  const anyGap = longestGapMs(channels, SR, 1);
  const hs = handoffs(channels, SR, events);

  const wav = encodeWav(channels, SR);
  writeFileSync(join(OUT, `${spec.file}.wav`), wav);

  process.stdout.write(
    `  ${spec.file.padEnd(28)} ${(channels[0]!.length / SR).toFixed(1)}s  ` +
      `peak ${db(peak).toFixed(1)} dBFS  rms ${db(rms).toFixed(1)} dBFS  ` +
      `transition gap ${gap.ms.toFixed(0)} ms  ` +
      `(longest anywhere ${anyGap.ms.toFixed(0)} ms @ ${anyGap.atS.toFixed(1)}s)\n`,
  );

  // --- the mechanical gates ---
  if (peak >= 0.999) fail(`${spec.file}: clipping, peak ${peak.toFixed(4)}`);
  if (gap.ms > 120) {
    fail(`${spec.file}: ${gap.ms.toFixed(0)} ms gap at the ${gap.where} (${gap.atS.toFixed(1)} s)`);
  }
  for (const h of hs) {
    if (Math.abs(h.deltaDb) > 3) {
      fail(`${spec.file}: ${h.label} level jumps ${h.deltaDb.toFixed(1)} dB (gate +/-3 dB)`);
    }
    process.stdout.write(
      `      ${h.label.padEnd(12)} ${h.beforeDb.toFixed(1)} -> ${h.afterDb.toFixed(1)} dBFS ` +
        `(${h.deltaDb >= 0 ? '+' : ''}${h.deltaDb.toFixed(1)} dB)\n`,
    );
  }

  results.push({
    spec,
    peak,
    rmsDb: db(rms),
    gapMs: gap.ms,
    gapAtS: gap.atS,
    anyGapMs: anyGap.ms,
    handoffs: hs,
    events,
    bytes: wav.length,
  });
}

/** Absolute time of the first loop seam in the dungeon clip. */
function closeupSeamS(events: readonly InterludeEvent[]): number {
  const start = events.find((e) => e.kind === 'song-start')?.at ?? 0;
  const loop = SEGMENTS.untitled.loop!;
  return start + (loop.endS - SEGMENTS.untitled.startS);
}

// ---------------------------------------------------------------------------
// index.html
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const html: string[] = [];
html.push('<!doctype html><meta charset="utf-8">');
html.push('<title>A Tale of Yarn — music integration</title>');
html.push(`<style>
  :root { color-scheme: dark; }
  body { background:#14110f; color:#e8ded2; font:15px/1.6 ui-sans-serif,system-ui,sans-serif;
         margin:0 auto; padding:2.5rem 1.5rem; max-width:60rem; }
  h1 { font-size:1.6rem; margin:0 0 .2rem; color:#f0c987; letter-spacing:.01em; }
  h2 { font-size:1.1rem; margin:2.2rem 0 .3rem; color:#f0c987; }
  .sub { color:#9a8f82; margin:0 0 2rem; }
  .clip { border:1px solid #2e2823; border-radius:10px; padding:1.1rem 1.3rem; margin:1.1rem 0;
          background:#1a1613; }
  .clip p { margin:.4rem 0 .8rem; color:#c9bdb0; }
  audio { width:100%; margin:.3rem 0 .6rem; }
  table { border-collapse:collapse; font-size:.86rem; margin:.4rem 0; }
  td,th { padding:.18rem .8rem .18rem 0; text-align:left; vertical-align:top; }
  th { color:#9a8f82; font-weight:500; }
  .ok { color:#8fbf7f; } .bad { color:#e08a7a; }
  code { background:#241f1b; padding:.1rem .35rem; border-radius:4px; font-size:.86em; }
  .note { border-left:3px solid #5a4a38; padding:.5rem 0 .5rem 1rem; margin:1.4rem 0;
          color:#bfb3a5; background:#191512; }
  .verdict { border:1px solid #6b5533; background:#221a12; border-radius:10px;
             padding:1rem 1.3rem; margin:2rem 0; }
</style>`);

html.push('<h1>Music integration — the developer\'s own recordings</h1>');
html.push(
  '<p class="sub">Four compositions by Kaven Martinez, played by the procedural music ' +
    'engine as decoded-buffer tracks. Rendered by <code>scripts/render-music-integration.mts</code>.</p>',
);

html.push(`<div class="verdict">
  <strong>These clips are the deliverable, not the tests.</strong>
  <p style="margin:.5rem 0 0">Everything <code>scripts/test-music.mts</code> checks is mechanical —
  a fade ends on a downbeat, an RMS sits within 10% of its neighbour, a level does not jump more
  than 3 dB. All of that can be green while the handoff still sounds wrong, and I cannot hear
  the output. Whether the transitions <em>flow</em> is your call. The gates below say only that
  nothing is obviously broken.</p>
</div>`);

html.push('<h2>The clips</h2>');
for (const r of results) {
  html.push('<div class="clip">');
  html.push(`<h3 style="margin:.1rem 0;font-size:1rem">${esc(r.spec.title)}</h3>`);
  html.push(`<p>${esc(r.spec.blurb)}</p>`);
  html.push(`<audio controls preload="none" src="${r.spec.file}.wav"></audio>`);
  html.push('<table>');
  html.push(
    `<tr><th>peak</th><td>${db(r.peak).toFixed(1)} dBFS ` +
      `<span class="${r.peak < 0.999 ? 'ok' : 'bad'}">${r.peak < 0.999 ? 'no clipping' : 'CLIPS'}</span></td></tr>`,
  );
  html.push(`<tr><th>overall RMS</th><td>${r.rmsDb.toFixed(1)} dBFS</td></tr>`);
  html.push(
    `<tr><th>gap at a transition</th><td>${r.gapMs.toFixed(0)} ms ` +
      `<span class="${r.gapMs <= 120 ? 'ok' : 'bad'}">(gate 120 ms)</span></td></tr>`,
  );
  html.push(
    `<tr><th>longest silence anywhere</th><td>${r.anyGapMs.toFixed(0)} ms ` +
      '<span style="color:#9a8f82">not a gate — rests inside the music are the ' +
      'composer\'s</span></td></tr>',
  );
  for (const h of r.handoffs) {
    const good = Math.abs(h.deltaDb) <= 3;
    html.push(
      `<tr><th>${esc(h.label)}</th><td>${h.beforeDb.toFixed(1)} → ${h.afterDb.toFixed(1)} dBFS ` +
        `(${h.deltaDb >= 0 ? '+' : ''}${h.deltaDb.toFixed(1)} dB) ` +
        `<span class="${good ? 'ok' : 'bad'}">(gate ±3 dB)</span></td></tr>`,
    );
  }
  html.push('</table>');
  if (r.events.length) {
    html.push('<details><summary style="cursor:pointer;color:#9a8f82">stage log</summary><table>');
    html.push('<tr><th>stage</th><th>clock</th><th>at</th><th>bar</th><th></th></tr>');
    for (const e of r.events) {
      html.push(
        `<tr><td>${esc(e.kind)}</td><td>${e.clock.toFixed(2)}</td><td>${e.at.toFixed(3)}</td>` +
          `<td>${e.bar ?? ''}</td><td>${esc(e.detail ?? '')}</td></tr>`,
      );
    }
    html.push('</table></details>');
  }
  html.push('</div>');
}

html.push('<h2>What to listen for</h2>');
html.push(`<div class="note">
<p><strong>Going in.</strong> The bed should thin out over one bar — the tune, the plucked
arpeggio and the drums step back and leave the pad. A bar later the pad changes pitch: that is
the modulation into the song's key. The song enters on the next downbeat with the pad still
underneath it for about two and a half seconds, then the pad goes. Nothing should sound like a
crossfade between two unrelated pieces of music.</p>
<p><strong>Coming out.</strong> The same in reverse: the pad comes back up under the song's last
few seconds, still in the song's key, and then the rest of the bed returns on the next bar — in
the region's own key again.</p>
<p><strong>The dungeon loop.</strong> You should not be able to tell where it is.</p>
</div>`);

html.push('<h2>What the numbers do not cover</h2>');
html.push(`<div class="note">
<p>The keys were <em>measured</em>, not taken on trust, and they are not what the integration
brief assumed. 500&nbsp;nanometers is in F minor, Ryan's song in E-flat minor, Untitled Song in
C major, and Project 1 in A (with E nearly as strong — they are a fifth apart). The brief said
all four were in E and asked for the engine to be retuned from D to E to match; that would have
put the pad a semitone away from the two overworld songs, which is the worst possible interval
for an overlap. The bed's tonic is therefore unchanged, and the pad instead modulates into each
song's own key for the handoff. If any of these overlaps sounds sour to you, that measurement is
the first thing to re-examine — the analysis is in the <code>KEYS</code> block at the top of
<code>src/game/music/songs.ts</code>.</p>
<p>The Untitled loop point is bar-aligned on a measured 115.000&nbsp;BPM grid. The RMS gate
proves the level does not jump across the join; it cannot prove the loop is in
<em>phase</em>, because level barely changes when you slide within a bar of similar music. That
part rests on the grid measurement, and on your ear.</p>
</div>`);

writeFileSync(join(OUT, 'index.html'), html.join('\n'), 'utf8');

process.stdout.write(`\nwrote ${results.length} clips + index.html -> ${OUT}\n`);
if (failures > 0) {
  process.stdout.write(`\nFAILED: ${failures} mechanical gate(s)\n`);
  process.exit(1);
}
process.stdout.write('\nall mechanical gates passed — the listening verdict is yours\n');
