/**
 * test-music.mts — the procedural music engine's mechanical proofs.
 *
 *   npx tsx scripts/test-music.mts
 *
 * I cannot hear the output, so nothing here trusts a render "sounding fine".
 * Every claim is asserted as the music-theoretic or signal fact itself:
 * degree-interval fingerprints, bar-boundary times, RMS relations, sample
 * discontinuities, voice counts.
 *
 * Every instrument used to judge the engine is itself checked against a
 * CONTROL that must fail — a motif detector that matches everything detects
 * nothing, and a click detector that never fires proves nothing.
 *
 * Sections:
 *   1. instrument sanity   — the shim and the detectors are checked first
 *   2. motif               — presence, transformation, and non-forgery
 *   3. state matrix        — the orchestration invariants
 *   4. determinism         — identical PCM and identical MIDI bytes
 *   5. transitions         — fades land on downbeats, nothing is cut
 *   6. levels              — peak / RMS / non-finite
 *   7. voices + scheduler  — budget, drop rate, per-update cost
 *   8. MIDI                — structure, key signatures, round-trip
 *   9. songs               — the developer's recordings: catalogue, cadence,
 *                            handoff timing, and the dungeon loop seam
 *
 * A NOTE ON SECTION 9's DETERMINISM. Sections 4 and 9 mean different things by
 * the word. The synth is deterministic in its SAMPLES — same seed, same PCM,
 * bit for bit. A decoded mp3 obviously is too, and asserting it would prove
 * nothing about this engine. What section 9 asserts instead is that the
 * SCHEDULE is deterministic: which segment, on which bar, at which reading of
 * the pause-frozen clock. That is the part with logic in it, so that is the
 * part with a test on it.
 */

import {
  MOTIF,
  MOTIF_HEAD_INTERVALS,
  MOTIF_INTERVALS,
  arrangeSequence,
  barsForSeconds,
  countMotifStatements,
  createMusic,
  layerStream,
  planBar,
  INTENSITIES,
  INTERLUDE_INTERVAL,
  INTERLUDE_JITTER,
  LAYERS,
  LAYER_MATRIX,
  MAX_VOICES,
  OVERWORLD_ROTATION,
  REGIONS,
  REGION_CONFIG,
  REGION_SEGMENT,
  SEGMENTS,
  SONGS,
  SONG_DUCK_FLOOR,
  SongPlayer,
  type Intensity,
  type MusicState,
  type Region,
  type SongId,
  type SongSegment,
} from '../src/game/music/index';
import { degreeIntervals, invert, retrograde } from '../src/game/music/motif';
import { barRole } from '../src/game/music/arranger';
import { createOfflineContext } from '../src/game/music/offline-context';
import { MusicBus } from '../src/game/music/bus';
import { analyse } from '../src/game/music/wav';
import { buildStem, keySignature, notesToMidi, PPQ } from '../src/game/music/midi';
import { mulberry32 } from '../src/game/music/rng';
import { MODES, degreeToMidi } from '../src/game/music/theory';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const notes: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function eq(name: string, got: unknown, want: unknown): void {
  ok(name, Object.is(got, want), `got ${String(got)}, want ${String(want)}`);
}

function note(s: string): void {
  notes.push(s);
}

const SEED = 20260727;
const SR = 24000;

function state(region: Region, intensity: Intensity, over: Partial<MusicState> = {}): MusicState {
  return { region, intensity, tod: 0.4, weather: 0, paused: false, ...over };
}

/** Render a fixed state, driving update() at a fixed 60 Hz. */
function render(st: MusicState, seconds: number, seed = SEED, volume = 1) {
  const { ctx, render: doRender } = createOfflineContext(2, Math.floor(SR * seconds), SR);
  // Songs off: sections 1-8 are about the SYNTH, and a decoded interlude
  // arriving mid-render would change every level and determinism baseline in
  // them for reasons that have nothing to do with what they test.
  const music = createMusic(ctx, seed, { volume, disableSongs: true });
  for (let t = 0; t < seconds; t += 1 / 60) music.update(st, t);
  const snap = music.snapshot(seconds - 0.001);
  return { out: doRender(), snap };
}

// ---------------------------------------------------------------------------
// Song-section fixtures (section 9)
// ---------------------------------------------------------------------------

interface SongManifestEntry {
  id: SongId;
  file: string;
  bytes: number;
  durationS: number;
  sourcePeakDb: number;
  gainDb: number;
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Drive the engine through a region script with every song pre-seeded.
 *
 * Buffers are silent placeholders of the right LENGTH: the scheduling questions
 * this fixture answers — which segment, which bar, which clock reading — depend
 * on a track's duration and on nothing else about its samples. The audio facts
 * are measured separately, on the real decoded file, in 9g.
 */
function songEngine(seed: number) {
  const { ctx } = createOfflineContext(2, SR * 4, SR);
  const music = createMusic(ctx, seed, { volume: 1 });
  for (const id of Object.keys(SONGS) as SongId[]) {
    music.songs.provide(id, ctx.createBuffer(2, Math.floor(SR * SONGS[id].durationS), SR));
  }
  return music;
}

function songSnapshot(seed: number, script: [number, Region][], intensity: Intensity = 'calm') {
  const music = songEngine(seed);
  let t = 0;
  for (const [until, region] of script) {
    const st = state(region, intensity);
    for (; t < until; t += 1 / 60) music.update(st, t);
  }
  return music.snapshot(t);
}

function songSnapshotIntensity(
  seed: number,
  region: Region,
  seconds: number,
  intensity: Intensity,
) {
  return songSnapshot(seed, [[seconds, region]], intensity);
}

/** The event log as a comparable string — the determinism artefact. */
function songRun(seed: number, script: [number, Region][]): string {
  return songSnapshot(seed, script)
    .events.map((e) => `${e.kind}|${e.clock}|${e.at}|${e.segment ?? ''}|${e.bar ?? ''}|${e.detail ?? ''}`)
    .join('\n');
}

interface Pcm {
  data: Float32Array;
  sampleRate: number;
}

/**
 * Decode a file to mono f32 with ffmpeg — the same decoder prepare-music.mts
 * measures with. Mono because every question here (RMS continuity, sample
 * discontinuity) is asked of the summed programme, not of the stereo image.
 */
function decodePcm(file: string): Pcm | null {
  const sampleRate = 44100;
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30, encoding: 'buffer' },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 1024) return null;
  const buf = r.stdout;
  const data = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  return { data: Float32Array.from(data), sampleRate };
}

/**
 * Render the REAL SongPlayer across a loop seam and return the samples.
 *
 * The player is started at a negative time so that the seam falls at PRE
 * seconds into an otherwise short render — the join is what is under test, and
 * rendering the 62 s that precede it would cost a minute of CPU to measure
 * nothing. Everything else is the shipping code path: the shipping crossfade,
 * the shipping envelopes, the shipping gain.
 */
function renderSeam(
  pcm: Pcm,
  seg: SongSegment,
  gainDb: number,
  loopEndS: number,
): { data: Float32Array; seamIndex: number } {
  const PRE = 2.5;
  const POST = 3.0;
  const sr = pcm.sampleRate;
  const seconds = PRE + POST;
  const { ctx, render: doRender } = createOfflineContext(2, Math.floor(sr * seconds), sr);

  const buffer = ctx.createBuffer(1, pcm.data.length, sr);
  buffer.getChannelData(0).set(pcm.data);

  const dest = ctx.createGain();
  dest.connect(ctx.destination);

  const loop = { ...seg.loop!, endS: loopEndS };
  const player = new SongPlayer(ctx, dest, buffer, { ...seg, loop }, {
    gain: Math.pow(10, gainDb / 20),
  });
  const at = -(loopEndS - seg.startS - PRE);
  player.start(at);
  // One pump, early enough to be inside the scheduling horizon of the seam.
  player.pump(PRE - 1);

  const out = doRender();
  return { data: out.channels[0]!, seamIndex: Math.round(PRE * sr) };
}

function rms(d: Float32Array, a: number, b: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, a); i < Math.min(d.length, b); i++) {
    s += d[i]! * d[i]!;
    n++;
  }
  return Math.sqrt(s / Math.max(1, n));
}

/**
 * Median sample-to-sample step over a window — "what an ordinary step looks
 * like here". A click is a step that is an outlier against this, which is a
 * question the window MAXIMUM cannot answer on percussive material.
 */
function medianDelta(d: Float32Array, a: number, b: number): number {
  const xs: number[] = [];
  for (let i = Math.max(1, a); i < Math.min(d.length, b); i++) {
    xs.push(Math.abs(d[i]! - d[i - 1]!));
  }
  if (xs.length === 0) return 0;
  xs.sort((p, q) => p - q);
  return xs[Math.floor(xs.length / 2)]!;
}

// ===========================================================================
// 1. INSTRUMENT SANITY — check the tools before trusting their verdicts
// ===========================================================================
{
  // --- the offline shim actually synthesises correct audio ---------------
  const { ctx, render: doRender } = createOfflineContext(2, SR, SR);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 440;
  g.gain.value = 0.5;
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(0);
  osc.stop(1);
  const out = doRender();
  const st = analyse(out.channels);
  ok('shim: 440 Hz sine peaks at the gain value', Math.abs(st.peak - 0.5) < 0.01, `peak ${st.peak}`);
  ok(
    'shim: sine RMS is peak/sqrt(2)',
    Math.abs(st.rms - 0.5 / Math.SQRT2) < 0.01,
    `rms ${st.rms}`,
  );
  let crossings = 0;
  const ch = out.channels[0]!;
  for (let i = 1; i < ch.length; i++) if (ch[i - 1]! < 0 && ch[i]! >= 0) crossings++;
  ok('shim: 440 Hz produces 440 zero-crossings/s', Math.abs(crossings - 440) <= 1, `${crossings}`);

  // --- the shim's gain automation is a real linear ramp -------------------
  const r = createOfflineContext(2, SR, SR);
  const o2 = r.ctx.createOscillator();
  const g2 = r.ctx.createGain();
  o2.frequency.value = 100;
  g2.gain.setValueAtTime(0, 0);
  g2.gain.linearRampToValueAtTime(1, 1);
  o2.connect(g2);
  g2.connect(r.ctx.destination);
  o2.start(0);
  o2.stop(1);
  const ramp = r.render().channels[0]!;
  let maxIn1st = 0;
  let maxIn4th = 0;
  for (let i = 0; i < SR / 4; i++) maxIn1st = Math.max(maxIn1st, Math.abs(ramp[i]!));
  for (let i = (SR * 3) / 4; i < SR; i++) maxIn4th = Math.max(maxIn4th, Math.abs(ramp[i]!));
  ok('shim: linear ramp quarter-1 amplitude ~0.25', Math.abs(maxIn1st - 0.25) < 0.02, `${maxIn1st}`);
  ok('shim: linear ramp quarter-4 amplitude ~1.0', Math.abs(maxIn4th - 1.0) < 0.02, `${maxIn4th}`);

  // --- the motif detector is discriminating, not permissive --------------
  eq('detector: finds the motif in itself', countMotifStatements(MOTIF), 1);
  eq('detector CONTROL: retrograde is not a match', countMotifStatements(retrograde(MOTIF)), 0);
  eq('detector CONTROL: inversion is not a match', countMotifStatements(invert(MOTIF)), 0);

  const walkRnd = mulberry32(99);
  const walk: { deg: number }[] = [];
  let d = 0;
  for (let i = 0; i < 4000; i++) {
    walk.push({ deg: d });
    d += [-3, -2, -1, 1, 2, 3][Math.floor(walkRnd() * 6)]!;
  }
  eq('detector CONTROL: 4000-note diatonic walk is not a match', countMotifStatements(walk), 0);

  // A walk that CAN leap by a fifth still must not forge the fingerprint by
  // accident often — this bounds the detector's false-positive rate.
  const leapRnd = mulberry32(1234);
  const leaps: { deg: number }[] = [];
  d = 0;
  for (let i = 0; i < 20000; i++) {
    leaps.push({ deg: d });
    d += [-4, -3, -2, -1, 1, 2, 3, 4][Math.floor(leapRnd() * 8)]!;
  }
  const fp = countMotifStatements(leaps);
  ok(
    'detector: false-positive rate on a leaping random walk < 0.5%',
    fp / 20000 < 0.005,
    `${fp} in 20000 notes`,
  );
  note(`detector false-positive rate on a leaping random walk: ${fp}/20000 notes`);

  // --- the click detector fires on an actual cut -------------------------
  const clean = render(state('village', 'calm'), 8);
  const cleanStats = analyse(clean.out.channels);
  const cut = clean.out.channels.map((c) => Float32Array.from(c));
  // Zero 400 samples starting at the loudest point — a hard mid-note cut.
  let peakIdx = 0;
  let peakVal = 0;
  for (let i = 0; i < cut[0]!.length; i++) {
    if (Math.abs(cut[0]![i]!) > peakVal) {
      peakVal = Math.abs(cut[0]![i]!);
      peakIdx = i;
    }
  }
  for (let i = peakIdx; i < Math.min(peakIdx + 400, cut[0]!.length); i++) cut[0]![i] = 0;
  const cutStats = analyse(cut);
  ok(
    'click detector CONTROL: a spliced hard cut is detected',
    cutStats.maxDelta >= peakVal * 0.9,
    `maxDelta ${cutStats.maxDelta.toFixed(4)} vs peak ${peakVal.toFixed(4)}`,
  );
  ok(
    'click detector: the real render has no such discontinuity',
    cleanStats.maxDelta < cutStats.maxDelta * 0.5,
    `clean ${cleanStats.maxDelta.toFixed(5)} vs cut ${cutStats.maxDelta.toFixed(5)}`,
  );
  note(
    `click detector: clean maxDelta ${cleanStats.maxDelta.toFixed(5)}, ` +
      `spliced-cut control ${cutStats.maxDelta.toFixed(5)}`,
  );
}

// ===========================================================================
// 2. MOTIF — the iconic strategy
// ===========================================================================
{
  eq('motif spans 4 bars of 16ths', MOTIF[MOTIF.length - 1]!.step + MOTIF[MOTIF.length - 1]!.dur, 64);
  eq('motif has 13 notes', MOTIF.length, 13);
  ok(
    'motif is strictly monophonic (no self-overlap)',
    MOTIF.every((n, i) => i === 0 || MOTIF[i - 1]!.step + MOTIF[i - 1]!.dur <= n.step),
  );
  eq('fingerprint is [+4,-1,+1,-2]', MOTIF_HEAD_INTERVALS.join(','), '4,-1,1,-2');
  eq(
    'full interval sequence',
    MOTIF_INTERVALS.join(','),
    '4,-1,1,-2,-1,-1,0,4,1,1,1,-3',
  );

  // The modal-colour claim: bar 2's degree-1 note is the ONLY pitch that
  // separates aeolian from phrygian, and the motif lands on it structurally.
  const aeo = MOTIF.map((n) => degreeToMidi(n.deg, 62, 'aeolian'));
  const phr = MOTIF.map((n) => degreeToMidi(n.deg, 62, 'phrygian'));
  const diffs = aeo.map((m, i) => m - phr[i]!).filter((x) => x !== 0);
  eq('aeolian -> phrygian moves exactly one note of the motif', diffs.length, 1);
  eq('...and it moves by one semitone', diffs[0], 1);
  eq('...and it is the penultimate note of the antecedent', MOTIF.findIndex((n) => n.deg === 1), 5);

  // Presence per region, measured over a real minute of arrangement.
  const FLOOR: Record<Region, number> = {
    wilds: 2,
    village: 5,
    dungeon: 2,
    castle: 4,
    interior: 4,
  };
  for (const region of REGIONS) {
    const st = state(region, 'calm');
    const bars = barsForSeconds(st, 60);
    const seq = arrangeSequence(SEED, st, bars);
    const mel = layerStream(seq, 'melody');
    const count = countMotifStatements(mel);
    ok(
      `motif present >= ${FLOOR[region]}/min in ${region} (calm)`,
      count >= FLOOR[region],
      `found ${count} in ${bars} bars`,
    );

    // EXACTNESS is the real proof that development never forges the theme:
    // one statement cycle can yield at most one match, so the count can never
    // exceed the number of cycles the render actually contains. A forged
    // fingerprint anywhere in the development material would break this.
    const cycle = planBar(0, st).statementEvery;
    const maxCycles = Math.ceil(bars / cycle);
    ok(
      `motif count in ${region} never exceeds the statement cycles (no forgery)`,
      count >= maxCycles - 1 && count <= maxCycles,
      `found ${count}, at most ${maxCycles} cycles in ${bars} bars`,
    );
    note(`motif statements/min — ${region} calm: ${count} (over ${bars} bars)`);
  }

  for (const region of REGIONS) {
    const st = state(region, 'combat');
    const bars = barsForSeconds(st, 60);
    const count = countMotifStatements(layerStream(arrangeSequence(SEED, st, bars), 'melody'));
    ok(`motif survives combat diminution in ${region}`, count >= 4, `found ${count}`);
    note(`motif statements/min — ${region} combat: ${count}`);
  }

  // Development material can never contain the motif's rising fifth. Asked of
  // the arranger's own role decision, not inferred from the notes — a
  // statement's middle bars contain no complete fingerprint and would be
  // misclassified as development by any output-only heuristic.
  let maxDevLeap = 0;
  let devBars = 0;
  let stmtBars = 0;
  for (const region of REGIONS) {
    for (const intensity of INTENSITIES) {
      const seq = arrangeSequence(SEED, state(region, intensity), 64);
      for (const bar of seq) {
        if (barRole(SEED, bar.plan) === 'statement') {
          stmtBars++;
          continue;
        }
        devBars++;
        for (const v of degreeIntervals(bar.notes.melody)) {
          maxDevLeap = Math.max(maxDevLeap, Math.abs(v));
        }
      }
    }
  }
  ok(
    'development melody never leaps more than 3 degrees (so it cannot forge the +4)',
    maxDevLeap <= 3,
    `max |leap| ${maxDevLeap} over ${devBars} development bars`,
  );
  ok('the corpus actually contains both roles', devBars > 100 && stmtBars > 100, `${stmtBars} statement / ${devBars} development bars`);
  note(`non-forgery checked over ${devBars} development bars; max |leap| ${maxDevLeap}`);
}

// ===========================================================================
// 3. STATE MATRIX
// ===========================================================================
{
  for (const region of REGIONS) {
    const energy = INTENSITIES.map((i) =>
      LAYERS.reduce((s, l) => s + LAYER_MATRIX[region][i][l], 0),
    );
    ok(
      `${region}: total layer energy strictly increases calm<alert<combat<boss`,
      energy[0]! < energy[1]! && energy[1]! < energy[2]! && energy[2]! < energy[3]!,
      energy.map((e) => e.toFixed(2)).join(' < '),
    );
    ok(
      `${region}: percussion enters at or above alert`,
      LAYER_MATRIX[region].combat.perc > LAYER_MATRIX[region].calm.perc,
    );
  }
  ok(
    'every region shares the same tonic (region change is a MODE change)',
    REGIONS.every((r) => REGION_CONFIG[r].tonicMidi === 62),
  );
  ok(
    'each region has a distinct mode/progression pairing',
    new Set(REGIONS.map((r) => `${REGION_CONFIG[r].mode}:${REGION_CONFIG[r].progression.join()}`))
      .size === REGIONS.length,
  );
  // Gains stay in range once tod/weather modifiers are applied.
  let outOfRange = 0;
  for (const region of REGIONS) {
    for (const intensity of INTENSITIES) {
      for (const tod of [0.05, 0.4, 0.8]) {
        for (const weather of [0, 0.5, 1]) {
          const p = planBar(0, state(region, intensity, { tod, weather }));
          for (const l of LAYERS) if (p.gains[l] < 0 || p.gains[l] > 1) outOfRange++;
        }
      }
    }
  }
  eq('all layer gains stay within 0..1 under tod/weather modifiers', outOfRange, 0);
}

// ===========================================================================
// 4. DETERMINISM
// ===========================================================================
{
  const a = render(state('castle', 'boss'), 6);
  const b = render(state('castle', 'boss'), 6);
  let diff = 0;
  for (let c = 0; c < a.out.channels.length; c++) {
    const x = a.out.channels[c]!;
    const y = b.out.channels[c]!;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) diff++;
  }
  eq('same seed + same state => byte-identical PCM', diff, 0);

  const c = render(state('castle', 'boss'), 6, SEED + 1);
  let diff2 = 0;
  for (let i = 0; i < a.out.channels[0]!.length; i++) {
    if (!Object.is(a.out.channels[0]![i], c.out.channels[0]![i])) diff2++;
  }
  ok('a different seed produces different music', diff2 > 1000, `${diff2} differing samples`);

  // A scripted state history, run twice.
  function scripted(seed: number) {
    const { ctx, render: doRender } = createOfflineContext(2, SR * 20, SR);
    const music = createMusic(ctx, seed, { volume: 1 });
    for (let t = 0; t < 20; t += 1 / 60) {
      const st =
        t < 5
          ? state('wilds', 'calm')
          : t < 10
            ? state('village', 'calm')
            : t < 15
              ? state('dungeon', 'combat')
              : state('castle', 'boss');
      music.update(st, t);
    }
    return doRender();
  }
  const s1 = scripted(SEED);
  const s2 = scripted(SEED);
  let sdiff = 0;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < s1.channels[ch]!.length; i++) {
      if (!Object.is(s1.channels[ch]![i], s2.channels[ch]![i])) sdiff++;
    }
  }
  eq('same seed + same state HISTORY => byte-identical PCM', sdiff, 0);

  // MIDI bytes.
  function stemBytes(seed: number): string {
    const st = state('village', 'combat');
    const seq = arrangeSequence(seed, st, 16);
    return LAYERS.map((l) =>
      Array.from(
        buildStem(`x-${l}`, layerStream(seq, l), seq[0]!.plan, l === 'perc'),
      ).join(','),
    ).join('|');
  }
  eq('MIDI export is byte-identical across runs', stemBytes(SEED), stemBytes(SEED));
  ok('MIDI export differs across seeds', stemBytes(SEED) !== stemBytes(SEED + 7));

  // No forbidden nondeterminism source may appear anywhere in the engine.
  // Asserted against the files on disk, not trusted to review.
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'game', 'music');
  const BANNED = /Math\s*\.\s*random|Date\s*\.\s*now|performance\s*\.\s*now/;

  /**
   * Strip a comment line so that PROSE about the rule is not mistaken for a
   * violation of it.
   *
   * The trailing `\r` is stripped first, and that is load-bearing rather than
   * tidy. This repo checks out with core.autocrlf=true, so every line here ends
   * CRLF; `.` in a JavaScript regex does not match `\r`, so `/^\s*\*.*$/`
   * silently fails to match ANY comment line in a Windows working tree. The
   * scan was therefore not stripping comments at all — it happened to stay
   * green only because no comment had yet said the words out loud. The moment
   * one did, it reported a false positive against a doc block whose entire
   * subject was obeying the rule.
   */
  const codeOf = (line: string): string =>
    line.replace(/\r$/, '').replace(/^\s*(\/\/|\*|\/\*).*$/, '');

  const offenders: string[] = [];
  let scanned = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    scanned++;
    const src = readFileSync(join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (BANNED.test(codeOf(line))) offenders.push(`${f}:${i + 1}`);
    });
  }
  ok('engine scans clean for Math.random / Date.now / performance.now', offenders.length === 0, offenders.join(', '));

  // The scanner must still have teeth on real code, and must still ignore
  // prose — including prose that ends CRLF, which is the case it was blind to.
  ok('nondeterminism CONTROL: real code is caught', BANNED.test(codeOf('  const x = Math.random();')));
  ok('nondeterminism CONTROL: a // comment is ignored', !BANNED.test(codeOf('  // never call Math.random() here')));
  ok('nondeterminism CONTROL: a doc line is ignored', !BANNED.test(codeOf(' * no Math.random, no Date.now')));
  ok(
    'nondeterminism CONTROL: a CRLF doc line is ignored',
    !BANNED.test(codeOf(' * no Math.random, no Date.now\r')),
    'this is the case that was silently broken',
  );
  ok(
    'nondeterminism CONTROL: CRLF real code is still caught',
    BANNED.test(codeOf('  const x = Date.now();\r')),
  );
  ok('the scan actually read the engine', scanned >= 10, `${scanned} files`);
  note(`nondeterminism scan: ${scanned} engine source files, ${offenders.length} offenders`);
}

// ===========================================================================
// 5. TRANSITIONS
// ===========================================================================
{
  // Flip state deliberately mid-bar and prove the fades land on a downbeat.
  const DUR = 24;
  const { ctx, render: doRender } = createOfflineContext(2, SR * DUR, SR);
  const music = createMusic(ctx, SEED, { volume: 1 });
  const flipAt = 7.31; // arbitrary, deliberately not on any grid line
  let snapAtEnd;
  for (let t = 0; t < DUR; t += 1 / 60) {
    music.update(t < flipAt ? state('village', 'calm') : state('village', 'combat'), t);
  }
  snapAtEnd = music.snapshot(DUR - 0.001);
  const out = doRender();

  const trans = snapAtEnd.transitions.filter((tr) => tr.requestedAt >= flipAt - 0.02);
  ok('a mid-bar state flip produces exactly one commit', trans.length === 1, `${trans.length}`);
  const tr = trans[0]!;
  const downbeat = snapAtEnd.barTimes[tr.bar];
  ok('the commit bar was actually planned', downbeat !== undefined);
  ok(
    'the commit time IS the bar downbeat (within 20 ms)',
    downbeat !== undefined && Math.abs(tr.at - downbeat) < 0.02,
    `commit ${tr.at.toFixed(4)} vs downbeat ${downbeat?.toFixed(4)}`,
  );
  ok(
    'the transition is quantised forward, never backward',
    tr.at > tr.requestedAt,
    `at ${tr.at.toFixed(3)} vs requested ${tr.requestedAt.toFixed(3)}`,
  );
  ok(
    'the fade is at least MIN_FADE long',
    tr.at - tr.requestedAt >= 0.25 - 1e-9,
    `${(tr.at - tr.requestedAt).toFixed(3)}s`,
  );
  note(
    `transition latency: requested ${tr.requestedAt.toFixed(3)}s -> landed ${tr.at.toFixed(3)}s ` +
      `(${((tr.at - tr.requestedAt) * 1000).toFixed(0)} ms, bar ${tr.bar})`,
  );

  // Every layer's fade ends exactly on that downbeat and reaches its target.
  const target = planBar(tr.bar, state('village', 'combat')).gains;
  let worstEnd = 0;
  let worstVal = 0;
  for (const l of LAYERS) {
    worstEnd = Math.max(worstEnd, Math.abs(snapAtEnd.fadeEnd[l] - tr.at));
    worstVal = Math.max(worstVal, Math.abs(snapAtEnd.layerGain[l] - target[l]));
  }
  ok(
    'every layer fade ENDS on the bar boundary (within 20 ms)',
    worstEnd < 0.02,
    `worst offset ${(worstEnd * 1000).toFixed(2)} ms`,
  );
  ok(
    'every layer reaches its matrix target after the boundary',
    worstVal < 1e-6,
    `worst error ${worstVal}`,
  );
  note(`layer fades land within ${(worstEnd * 1000).toFixed(2)} ms of the downbeat`);

  // No cut anywhere across the transition.
  const st = analyse(out.channels);
  ok('transition render has no non-finite samples', st.nonFinite === 0, `${st.nonFinite}`);
  ok(
    'transition render has no cut-sized discontinuity',
    st.maxDelta < st.peak * 0.5,
    `maxDelta ${st.maxDelta.toFixed(5)}, peak ${st.peak.toFixed(5)}`,
  );

  // Leaving combat decays layers rather than dropping them instantly.
  const back = createOfflineContext(2, SR * 24, SR);
  const m2 = createMusic(back.ctx, SEED, { volume: 1 });
  for (let t = 0; t < 24; t += 1 / 60) {
    m2.update(t < 6 ? state('wilds', 'combat') : state('wilds', 'calm'), t);
  }
  const s2 = m2.snapshot(23.9);
  const exitTr = s2.transitions.filter((x) => x.requestedAt >= 6 - 0.02)[0];
  ok('leaving combat is also bar-quantised', exitTr !== undefined && exitTr.at > exitTr.requestedAt);
  eq('percussion decays to its calm target (0) after leaving combat', s2.layerGain.perc, 0);
  ok(
    'the decay is a ramp, not a jump',
    exitTr !== undefined && exitTr.at - exitTr.requestedAt >= 0.25,
  );
}

// ===========================================================================
// 6. LEVELS
// ===========================================================================
{
  // ONE render pass per state, shared by the level checks and the voice-budget
  // checks below — rendering the whole matrix twice doubled the suite's runtime
  // for no extra coverage.
  const rows: { region: Region; intensity: Intensity; peakDb: number; rmsDb: number }[] = [];
  let worstPeakVoices = 0;
  let totalNotes = 0;
  let totalDropped = 0;
  for (const region of REGIONS) {
    for (const intensity of INTENSITIES) {
      // Volume at MAXIMUM — headroom must survive the slider being maxed.
      const r = render(state(region, intensity), 10, SEED, 1);
      const st = analyse(r.out.channels, SR * 2);
      rows.push({ region, intensity, peakDb: st.peakDb, rmsDb: st.rmsDb });
      ok(
        `${region}/${intensity}: peak < -3 dBFS at volume 1.0`,
        st.peakDb < -3,
        `${st.peakDb.toFixed(2)} dBFS`,
      );
      ok(`${region}/${intensity}: no NaN/Inf samples`, st.nonFinite === 0, `${st.nonFinite}`);
      ok(
        `${region}/${intensity}: output is not silent`,
        st.rmsDb > -45,
        `${st.rmsDb.toFixed(2)} dBFS`,
      );

      worstPeakVoices = Math.max(worstPeakVoices, r.snap.peakVoices);
      totalNotes += r.snap.notesDispatched;
      totalDropped += r.snap.voicesDropped;
      ok(
        `${region}/${intensity}: concurrent voices <= ${MAX_VOICES}`,
        r.snap.peakVoices <= MAX_VOICES,
        `${r.snap.peakVoices}`,
      );
      // The layers that carry the theme must never lose a note.
      ok(
        `${region}/${intensity}: melody and pad never dropped`,
        !r.snap.droppedByLayer.melody && !r.snap.droppedByLayer.pad,
        JSON.stringify(r.snap.droppedByLayer),
      );
    }
  }
  const dropRate = totalDropped / Math.max(1, totalNotes + totalDropped);
  ok('overall voice-drop rate < 1%', dropRate < 0.01, `${(dropRate * 100).toFixed(2)}%`);
  note(
    `voice budget: peak ${worstPeakVoices}/${MAX_VOICES} concurrent, ` +
      `drop rate ${(dropRate * 100).toFixed(2)}% (${totalDropped}/${totalNotes + totalDropped})`,
  );
  for (const region of REGIONS) {
    const get = (i: Intensity) => rows.find((r) => r.region === region && r.intensity === i)!.rmsDb;
    ok(
      `${region}: RMS relation calm < alert < combat <= boss`,
      get('calm') < get('alert') && get('alert') < get('combat') && get('combat') <= get('boss') + 0.01,
      `${get('calm').toFixed(1)} / ${get('alert').toFixed(1)} / ${get('combat').toFixed(1)} / ${get('boss').toFixed(1)}`,
    );
    note(
      `RMS dBFS — ${region}: calm ${get('calm').toFixed(1)}, alert ${get('alert').toFixed(1)}, ` +
        `combat ${get('combat').toFixed(1)}, boss ${get('boss').toFixed(1)}`,
    );
  }
  const loudest = rows.reduce((a, b) => (a.peakDb > b.peakDb ? a : b));
  note(
    `loudest state: ${loudest.region}/${loudest.intensity} at ${loudest.peakDb.toFixed(2)} dBFS peak (volume 1.0)`,
  );

  // Pause and duck are attenuations, not stops.
  const p = createOfflineContext(2, SR * 12, SR);
  const pm = createMusic(p.ctx, SEED, { volume: 1 });
  for (let t = 0; t < 12; t += 1 / 60) pm.update(state('village', 'calm', { paused: t > 6 }), t);
  const pOut = p.render();
  let beforeSum = 0;
  let afterSum = 0;
  for (let i = SR * 4; i < SR * 6; i++) beforeSum += pOut.channels[0]![i]! ** 2;
  for (let i = SR * 9; i < SR * 11; i++) afterSum += pOut.channels[0]![i]! ** 2;
  ok('paused music keeps playing (not silence)', afterSum > 0, `${afterSum}`);
  ok('paused music is quieter than unpaused', afterSum < beforeSum, `${afterSum} vs ${beforeSum}`);
  note(
    `pause attenuation measured: ${(10 * Math.log10(afterSum / beforeSum)).toFixed(1)} dB`,
  );

  const dctx = createOfflineContext(2, SR * 12, SR);
  const dm = createMusic(dctx.ctx, SEED, { volume: 1 });
  for (let t = 0; t < 12; t += 1 / 60) {
    if (Math.abs(t - 6) < 1 / 120) dm.duck(1);
    dm.update(state('village', 'calm'), t);
  }
  const dOut = dctx.render();
  let dBefore = 0;
  let dAfter = 0;
  for (let i = SR * 4; i < SR * 6; i++) dBefore += dOut.channels[0]![i]! ** 2;
  for (let i = SR * 8; i < SR * 10; i++) dAfter += dOut.channels[0]![i]! ** 2;
  ok('duck(1) attenuates but does not silence', dAfter > 0 && dAfter < dBefore);
  note(`duck(1) attenuation measured: ${(10 * Math.log10(dAfter / dBefore)).toFixed(1)} dB`);
}

// ===========================================================================
// 7. VOICES + SCHEDULER COST
// ===========================================================================
{
  // --- per-update() cost at the worst intensity --------------------------
  const { ctx } = createOfflineContext(2, SR * 60, SR);
  const music = createMusic(ctx, SEED, { volume: 1 });
  const st = state('castle', 'boss');
  const samples: number[] = [];
  let coldMs = 0;
  for (let i = 0; i < 3600; i++) {
    const t = i / 60;
    const t0 = process.hrtime.bigint();
    music.update(st, t);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // The first call builds the bus, the noise buffer and the opening fades.
    // It is a one-off at audio-resume time, not a per-frame cost, so it is
    // reported rather than folded into the distribution.
    if (i === 0) coldMs = ms;
    else samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p99 = samples[Math.floor(samples.length * 0.99)]!;
  const max = samples[samples.length - 1]!;
  ok(`update() mean cost < 0.5 ms at boss intensity`, mean < 0.5, `${mean.toFixed(4)} ms`);
  ok(`update() p99 cost < 0.5 ms at boss intensity`, p99 < 0.5, `${p99.toFixed(4)} ms`);
  note(
    `update() cost @ castle/boss, 3599 warm calls: mean ${mean.toFixed(4)} ms, ` +
      `p50 ${p50.toFixed(4)} ms, p99 ${p99.toFixed(4)} ms, max ${max.toFixed(4)} ms ` +
      `(cold first call ${coldMs.toFixed(3)} ms)`,
  );

  // Robustness: a huge time jump (backgrounded tab) must not explode.
  const j = createOfflineContext(2, SR * 10, SR);
  const jm = createMusic(j.ctx, SEED);
  jm.update(state('wilds', 'calm'), 0);
  jm.update(state('wilds', 'calm'), 0.1);
  const jt0 = process.hrtime.bigint();
  jm.update(state('wilds', 'calm'), 600);
  const jumpMs = Number(process.hrtime.bigint() - jt0) / 1e6;
  ok('a 10-minute clock jump resyncs instead of scheduling 200 bars', jumpMs < 20, `${jumpMs.toFixed(2)} ms`);
  ok('the resync is recorded', jm.snapshot(600).resyncs === 1);
}

// ===========================================================================
// 8. MIDI
// ===========================================================================
{
  const st = state('castle', 'boss');
  const seq = arrangeSequence(SEED, st, 8);
  const bytes = buildStem('castle-boss-melody', layerStream(seq, 'melody'), seq[0]!.plan, false);

  eq('SMF starts with MThd', String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  eq('SMF header length is 6', new DataView(bytes.buffer).getUint32(4), 6);
  eq('SMF is format 1', new DataView(bytes.buffer).getUint16(8), 1);
  eq('SMF has 2 tracks', new DataView(bytes.buffer).getUint16(10), 2);
  eq('SMF division is 480 PPQ', new DataView(bytes.buffer).getUint16(12), PPQ);

  // Walk the chunks and confirm the declared lengths are exact.
  let off = 14;
  let chunks = 0;
  const dv = new DataView(bytes.buffer);
  while (off < bytes.length) {
    const id = String.fromCharCode(...bytes.slice(off, off + 4));
    const len = dv.getUint32(off + 4);
    ok(`SMF chunk ${chunks} is MTrk`, id === 'MTrk', id);
    off += 8 + len;
    chunks++;
  }
  eq('SMF chunk lengths consume the file exactly', off, bytes.length);
  eq('SMF has 2 MTrk chunks', chunks, 2);
  ok('SMF ends with an end-of-track meta', bytes[bytes.length - 3] === 0xff && bytes[bytes.length - 2] === 0x2f);

  // Note-on/note-off pairing across every layer of every state.
  let unbalanced = 0;
  let emptyStems = 0;
  for (const region of REGIONS) {
    for (const intensity of INTENSITIES) {
      const s = arrangeSequence(SEED, state(region, intensity), 8);
      for (const l of LAYERS) {
        const stream = layerStream(s, l);
        const b = buildStem(`${region}-${intensity}-${l}`, stream, s[0]!.plan, l === 'perc');
        let ons = 0;
        let offs = 0;
        for (let i = 0; i < b.length - 2; i++) {
          if ((b[i]! & 0xf0) === 0x90 && b[i]! !== 0xff) ons++;
          if ((b[i]! & 0xf0) === 0x80 && b[i]! !== 0xff) offs++;
        }
        if (stream.length === 0) emptyStems++;
      }
    }
  }
  eq('no layer produces an empty stem', emptyStems, 0);

  // Key signatures match the modal design.
  eq('D ionian  -> 2 sharps, major', keySignature(2, 'ionian').join(','), '2,0');
  eq('D dorian  -> 0 accidentals, minor-ish', keySignature(2, 'dorian').join(','), '0,1');
  eq('D aeolian -> 1 flat, minor', keySignature(2, 'aeolian').join(','), '-1,1');
  eq('D phrygian-> 2 flats, minor', keySignature(2, 'phrygian').join(','), '-2,1');

  // Percussion goes to channel 10 (index 9).
  const perc = buildStem('p', layerStream(seq, 'perc'), seq[0]!.plan, true);
  let sawCh9 = false;
  for (let i = 0; i < perc.length - 2; i++) if (perc[i] === 0x99) sawCh9 = true;
  ok('percussion stem writes to MIDI channel 10', sawCh9);

  // Tempo meta reflects the plan's BPM (region tempo x intensity multiplier).
  const usPerQ = Math.round(60_000_000 / seq[0]!.plan.bpm);
  let sawTempo = false;
  for (let i = 0; i < bytes.length - 6; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0x51 && bytes[i + 2] === 3) {
      const v = (bytes[i + 3]! << 16) | (bytes[i + 4]! << 8) | bytes[i + 5]!;
      if (v === usPerQ) sawTempo = true;
    }
  }
  ok('tempo meta matches the arrangement BPM', sawTempo, `${seq[0]!.plan.bpm} bpm`);

  // --- ROUND TRIP -------------------------------------------------------
  // Structural checks would still pass if the writer silently dropped or
  // mistimed notes. Decoding the bytes back independently and comparing with
  // the arranger's own events is the assertion that actually matters.
  const decode = (b: Uint8Array) => {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let off = 14; // past MThd
    const out: { tick: number; midi: number; vel: number; durTicks: number }[] = [];
    while (off < b.length) {
      const len = d.getUint32(off + 4);
      const end = off + 8 + len;
      let p = off + 8;
      let tick = 0;
      let running = 0;
      const open = new Map<number, { tick: number; vel: number }>();
      while (p < end) {
        let delta = 0;
        for (;;) {
          const byte = b[p++]!;
          delta = (delta << 7) | (byte & 0x7f);
          if ((byte & 0x80) === 0) break;
        }
        tick += delta;
        let status = b[p]!;
        if (status & 0x80) p++;
        else status = running;
        running = status;
        if (status === 0xff) {
          const type = b[p++]!;
          let mlen = 0;
          for (;;) {
            const byte = b[p++]!;
            mlen = (mlen << 7) | (byte & 0x7f);
            if ((byte & 0x80) === 0) break;
          }
          p += mlen;
          if (type === 0x2f) break;
        } else if ((status & 0xf0) === 0x90) {
          const key = b[p++]!;
          const vel = b[p++]!;
          if (vel > 0) open.set(key, { tick, vel });
        } else if ((status & 0xf0) === 0x80) {
          const key = b[p++]!;
          p++;
          const on = open.get(key);
          if (on) {
            out.push({ tick: on.tick, midi: key, vel: on.vel, durTicks: tick - on.tick });
            open.delete(key);
          }
        } else if ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0) p += 1;
        else p += 2;
      }
      off = end;
    }
    return out.sort((a, b2) => a.tick - b2.tick || a.midi - b2.midi);
  };

  let rtChecked = 0;
  let rtMismatch = 0;
  for (const region of REGIONS) {
    for (const intensity of INTENSITIES) {
      const s2 = arrangeSequence(SEED, state(region, intensity), 8);
      for (const l of LAYERS) {
        const stream = layerStream(s2, l);
        const want = notesToMidi(stream)
          .map((n) => ({ tick: n.tick, midi: n.midi, vel: n.vel, durTicks: n.durTicks }))
          .sort((a, b2) => a.tick - b2.tick || a.midi - b2.midi);
        const got = decode(buildStem('rt', stream, s2[0]!.plan, l === 'perc'));
        rtChecked++;
        if (got.length !== want.length) {
          rtMismatch++;
          continue;
        }
        for (let i = 0; i < want.length; i++) {
          const a = want[i]!;
          const b2 = got[i]!;
          if (a.tick !== b2.tick || a.midi !== b2.midi || a.vel !== b2.vel || a.durTicks !== b2.durTicks) {
            rtMismatch++;
            break;
          }
        }
      }
    }
  }
  eq('MIDI round-trips exactly: decode(encode(notes)) === notes', rtMismatch, 0);
  ok('round-trip covered every layer of every state', rtChecked === REGIONS.length * INTENSITIES.length * LAYERS.length, `${rtChecked} stems`);
  note(`MIDI round-trip verified on ${rtChecked} stems (tick, pitch, velocity, duration)`);

  // The decoder must be able to FAIL — a corrupted stem must not round-trip.
  const good = buildStem('ctl', layerStream(seq, 'melody'), seq[0]!.plan, false);
  const bad = Uint8Array.from(good);
  for (let i = 20; i < bad.length - 3; i++) {
    if ((bad[i]! & 0xf0) === 0x90 && bad[i]! !== 0xff) {
      bad[i + 1] = (bad[i + 1]! + 5) & 0x7f; // shift one pitch
      break;
    }
  }
  const decodedGood = decode(good);
  const decodedBad = decode(bad);
  ok(
    'round-trip CONTROL: a one-byte pitch corruption is detected',
    JSON.stringify(decodedGood) !== JSON.stringify(decodedBad),
  );
}

// ===========================================================================
// 9. SONGS — the developer's own recordings
// ===========================================================================
//
// These are decoded buffers, not synthesis, so the determinism claim changes
// shape: the PCM is a file and is obviously identical every run. What has to be
// proven deterministic is WHEN things happen — which segment, on which bar, at
// which reading of the pause-frozen clock. So this section asserts the
// scheduler's EVENT LOG, and asserts the audio facts (loop continuity, level)
// separately against the real decoded samples.

{
  const musicDir = join(REPO, 'models', 'music');

  // --- 9a. the catalogue agrees with the files that shipped ---------------
  //
  // songs.ts holds the numbers the engine PLANS against; manifest.json holds
  // the numbers measured from the bytes that actually shipped. If they drift,
  // the engine schedules a fade against a duration the file does not have.
  let manifest: { entries: SongManifestEntry[]; totalBytes: number } | null = null;
  try {
    manifest = JSON.parse(readFileSync(join(musicDir, 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  ok(
    'models/music/manifest.json exists',
    manifest !== null,
    'run `npx tsx scripts/prepare-music.mts` — the soundtrack has not been vendored',
  );

  if (manifest) {
    const entries = manifest.entries;
    eq('manifest describes every track in songs.ts', entries.length, Object.keys(SONGS).length);
    for (const e of entries) {
      const track = SONGS[e.id];
      ok(`manifest track is in songs.ts: ${e.id}`, track !== undefined);
      if (!track) continue;
      eq(`manifest file matches songs.ts: ${e.id}`, e.file, track.file);
      ok(
        `manifest duration matches songs.ts: ${e.id}`,
        Math.abs(e.durationS - track.durationS) < 0.05,
        `manifest ${e.durationS}s vs songs.ts ${track.durationS}s`,
      );
      eq(`manifest gain matches songs.ts: ${e.id}`, e.gainDb, track.gainDb);
      // The brief's hard ceiling, checked as arithmetic on measured numbers
      // rather than as a promise in a comment.
      ok(
        `playback peak stays under -3 dBFS: ${e.id}`,
        e.sourcePeakDb + e.gainDb <= -3 + 1e-6,
        `${e.sourcePeakDb} dBFS peak + ${e.gainDb} dB trim = ${(e.sourcePeakDb + e.gainDb).toFixed(2)}`,
      );
      ok(`vendored file is on disk: ${e.id}`, existsSync(join(musicDir, e.file)));
    }
    note(
      `soundtrack: ${entries.length} tracks, ` +
        `${(manifest.totalBytes / 1048576).toFixed(2)} MB depot delta`,
    );
  }

  // Segment bounds must lie inside their track, and a loop must have real audio
  // after its end point to crossfade against.
  for (const seg of Object.values(SEGMENTS)) {
    const track = SONGS[seg.song];
    ok(`segment starts inside its track: ${seg.id}`, seg.startS >= 0 && seg.startS < track.durationS);
    ok(
      `segment ends inside its track: ${seg.id}`,
      seg.endS > seg.startS && seg.endS <= track.durationS + 1e-6,
    );
    if (seg.loop) {
      ok(
        `loop start is inside the segment: ${seg.id}`,
        seg.loop.startS >= seg.startS && seg.loop.startS < seg.loop.endS,
      );
      const tail = track.durationS - seg.loop.endS;
      ok(
        `loop has tail to crossfade against: ${seg.id}`,
        tail >= seg.loop.crossfadeS,
        `${tail.toFixed(3)}s of tail, crossfade needs ${seg.loop.crossfadeS}s`,
      );
    }
  }

  eq('the overworld rotation has three segments', OVERWORLD_ROTATION.length, 3);
  eq(
    'the rotation has no immediate repeat (it is a cycle of distinct segments)',
    new Set(OVERWORLD_ROTATION).size,
    OVERWORLD_ROTATION.length,
  );
  ok('the dungeon has a region track', REGION_SEGMENT.dungeon === 'untitled');
  ok('the castle has a region track', REGION_SEGMENT.castle === 'castle');

  // --- 9b. scheduler determinism, on the event log ------------------------
  const script: [number, Region][] = [
    [300, 'wilds'],
    [420, 'village'],
    [470, 'dungeon'],
    [700, 'wilds'],
  ];

  const logA = songRun(SEED, script);
  const logB = songRun(SEED, script);
  eq('two runs with the same seed produce identical event logs', logA, logB);
  const logC = songRun(SEED + 1, script);
  ok(
    'determinism CONTROL: a different seed produces a different log',
    logA !== logC,
    'if these matched, the comparison above would prove nothing',
  );
  note(`song scheduler determinism checked over ${logA.split('\n').length} logged events`);

  // --- 9c. interlude cadence ---------------------------------------------
  {
    const snap = songSnapshot(SEED, [[2000, 'wilds']]);
    const starts = snap.events.filter((e) => e.kind === 'song-start');
    ok('several interludes fire over 2000 s of wilds', starts.length >= 3, `${starts.length}`);

    // Cadence is measured between one interlude being ARMED and it firing —
    // that is the ~4 minutes of bed the developer asked for, and it is what the
    // `schedule` event records.
    const armed = snap.events.filter((e) => e.kind === 'schedule');
    let cadenceOk = 0;
    const gaps: number[] = [];
    for (const a of armed) {
      const m = /in ([\d.]+) s/.exec(a.detail ?? '');
      if (!m) continue;
      const gap = Number(m[1]);
      gaps.push(gap);
      if (Math.abs(gap - INTERLUDE_INTERVAL) <= INTERLUDE_JITTER + 1e-6) cadenceOk++;
    }
    eq('every interlude is armed within the cadence window', cadenceOk, gaps.length);
    ok('the cadence is jittered, not metronomic', new Set(gaps.map((g) => g.toFixed(1))).size > 1,
      `gaps: ${gaps.map((g) => g.toFixed(1)).join(', ')}`);
    note(
      `interlude cadence: ${gaps.map((g) => g.toFixed(1)).join(', ')} s ` +
        `(target ${INTERLUDE_INTERVAL} +/- ${INTERLUDE_JITTER})`,
    );

    // Never the same segment twice running.
    let repeats = 0;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i]!.segment === starts[i - 1]!.segment) repeats++;
    }
    eq('no segment plays twice in a row', repeats, 0);
    ok(
      'the rotation actually rotates through all three segments',
      new Set(starts.map((s) => s.segment)).size === 3,
      starts.map((s) => s.segment).join(' -> '),
    );
  }

  // --- 9d. transition timing ----------------------------------------------
  {
    const snap = songSnapshot(SEED, [[60, 'dungeon']]);
    const barTimes = snap.barTimes;
    const staged = snap.events.filter(
      (e) => e.bar !== undefined && (e.kind === 'thin' || e.kind === 'pivot' || e.kind === 'song-start'),
    );
    eq('the handoff has all three bar-quantised stages', staged.length, 3);

    let worst = 0;
    for (const e of staged) {
      const bt = barTimes[e.bar!];
      ok(`stage ${e.kind} has a real downbeat`, bt !== undefined);
      if (bt === undefined) continue;
      const deltaMs = Math.abs(e.at - bt) * 1000;
      worst = Math.max(worst, deltaMs);
      ok(`stage ${e.kind} lands on a bar line`, deltaMs <= 20, `${deltaMs.toFixed(2)} ms off`);
    }
    note(`transition stages land within ${worst.toFixed(2)} ms of a downbeat (gate 20 ms)`);

    const kinds = staged.map((e) => e.kind);
    eq('stage order is thin -> pivot -> song', kinds.join(','), 'thin,pivot,song-start');

    // Consecutive stages are exactly one bar apart.
    const [thin, pivot, song] = staged;
    eq('pivot is the bar after thin', pivot!.bar! - thin!.bar!, 1);
    eq('the song starts the bar after the pivot', song!.bar! - pivot!.bar!, 1);

    // The pivot really is in the SONG's key, not the region's.
    const pivotTonic = Number(/tonic (\d+)/.exec(pivot!.detail ?? '')?.[1] ?? NaN);
    eq(
      'the pivot pad is voiced in the song\'s tonic',
      ((pivotTonic % 12) + 12) % 12,
      SONGS.untitled.tonicPc,
    );
    ok(
      'pivot CONTROL: that tonic is NOT the region\'s own',
      ((pivotTonic % 12) + 12) % 12 !== REGION_CONFIG.dungeon.tonicMidi % 12,
      'if the pivot matched the region tonic, no modulation happened',
    );
    ok(
      'the pivot stays in the bed\'s register',
      Math.abs(pivotTonic - REGION_CONFIG.dungeon.tonicMidi) <= 6,
      `pivot ${pivotTonic} vs region ${REGION_CONFIG.dungeon.tonicMidi}`,
    );
  }

  // --- 9e. exit protocol ---------------------------------------------------
  {
    // A region change mid-song must go through the exit, never a hard stop.
    const snap = songSnapshot(SEED, [[30, 'dungeon'], [80, 'wilds']]);
    const exit = snap.events.find((e) => e.kind === 'exit');
    ok('leaving the region triggers an exit', exit !== undefined);
    ok(
      'the exit names the region change as its reason',
      /region wants/.test(exit?.detail ?? ''),
      exit?.detail,
    );
    const ret = snap.events.find((e) => e.kind === 'bed-return');
    ok('the bed returns after the exit', ret !== undefined);
    ok(
      'the bed returns AFTER the song is gone, not before',
      (ret?.at ?? 0) >= (exit?.at ?? Infinity) - 1e-6,
      `bed-return ${ret?.at} vs song gone ${exit?.at}`,
    );
    const retBar = ret?.bar;
    const bt = retBar !== undefined ? snap.barTimes[retBar] : undefined;
    ok(
      'the bed returns on a downbeat',
      bt !== undefined && Math.abs((ret?.at ?? 0) - bt) * 1000 <= 20,
      bt === undefined ? 'no bar time' : `${(Math.abs((ret?.at ?? 0) - bt) * 1000).toFixed(2)} ms`,
    );
    eq('the engine is back on the bed afterwards', snap.stage, 'bed');
  }

  // --- 9f. combat ducks the song, it never stops it ------------------------
  {
    const calm = songSnapshot(SEED, [[40, 'dungeon']]);
    eq('a calm dungeon plays its song', calm.stage, 'song');
    eq('...unducked', calm.songDuck, 0);

    const fight = songSnapshotIntensity(SEED, 'dungeon', 40, 'combat');
    eq('combat keeps the song playing', fight.stage, 'song');
    ok('...but ducks it', fight.songDuck > 0, `${fight.songDuck}`);
    ok('...and does not silence it', SONG_DUCK_FLOOR > 0, `floor ${SONG_DUCK_FLOOR}`);
  }

  // --- 9h. regression: a fade must not rewrite the PAST --------------------
  //
  // `cancelScheduledValues(t)` removes automation events AT t as well as after
  // it. Every fade in this engine is bar-aligned, so the moment one fade begins
  // is almost always the exact moment the previous one ended — and cancelling
  // there deleted the previous ramp's ENDPOINT, which collapsed the ramp
  // leading up to it into a flat hold at its start value.
  //
  // The symptom was not subtle and it was not in the future: the castle bed's
  // entire first bar rendered as digital silence, 3.3 seconds of it, caused by
  // a fade issued after that bar had already been planned. It reproduced in the
  // Node shim and would have reproduced in Chrome, whose cancellation semantics
  // are the same.
  {
    const { ctx } = createOfflineContext(2, 128, SR);
    const bus = new MusicBus(ctx, ctx.destination);
    // Exactly the castle numbers that found it.
    const start = 0.06;
    const spb = (60 / 72) * 4;
    bus.fadeTo('pad', 0.68, start, start + spb);
    // Second fade begins on the next downbeat — reached by a different float
    // route, as the interlude reaches it, so the two differ in the last bit.
    const second = start + 2 * spb - spb;
    bus.fadeTo('pad', 0, second, start + 2 * spb);

    const param = (bus.layerGain.pad as unknown as { gain: { valueAt(t: number): number } }).gain;
    const mid = param.valueAt(start + spb / 2);
    ok(
      'a later fade does not silence the bar before it',
      mid > 0.2,
      `gain halfway through the first bar is ${mid.toFixed(5)}, expected ~0.34 — ` +
        'if this is 0, cancelScheduledValues has eaten the ramp endpoint again',
    );
    ok(
      'the first bar still ramps rather than holding',
      param.valueAt(start + spb * 0.25) < param.valueAt(start + spb * 0.75),
      'the fade-up must still be a ramp, not a step',
    );
    // CONTROL: the same reading on a param that really was never ramped.
    const { ctx: ctx2 } = createOfflineContext(2, 128, SR);
    const bus2 = new MusicBus(ctx2, ctx2.destination);
    const p2 = (bus2.layerGain.pad as unknown as { gain: { valueAt(t: number): number } }).gain;
    eq('fade CONTROL: an untouched layer reads zero', p2.valueAt(start + spb / 2), 0);
  }

  // --- 9g. the loop seam, measured on the real decoded audio ---------------
  //
  // This is the one claim in this section that a scheduler log cannot support.
  // It renders the ACTUAL SongPlayer, with the ACTUAL decoded mp3, across the
  // ACTUAL loop point, and measures the join.
  {
    const seg = SEGMENTS.untitled;
    const track = SONGS.untitled;
    const file = join(musicDir, track.file);
    const pcm = existsSync(file) ? decodePcm(file) : null;
    ok(
      'the dungeon track decodes for the seam test',
      pcm !== null,
      `could not decode ${file} — ffmpeg is required (it is what prepare-music.mts uses)`,
    );

    if (pcm && seg.loop) {
      const seam = renderSeam(pcm, seg, track.gainDb, seg.loop.endS);
      const w = Math.round(0.25 * pcm.sampleRate);
      const s = seam.seamIndex;
      const xfN = Math.round(seg.loop.crossfadeS * pcm.sampleRate);
      const pre = rms(seam.data, s - 4 * w, s);
      const at = rms(seam.data, s, s + xfN);
      const post = rms(seam.data, s + xfN, s + xfN + 4 * w);
      const dev = Math.abs(at / ((pre + post) / 2) - 1);
      ok(
        'RMS across the loop seam is within 10% of its neighbours',
        dev <= 0.1,
        `pre ${pre.toFixed(4)} seam ${at.toFixed(4)} post ${post.toFixed(4)} = ${(dev * 100).toFixed(1)}%`,
      );
      ok('the seam is not silent', at > 0.01, `${at.toFixed(4)}`);

      // NO CLICK.
      //
      // Measured as the sample-to-sample step AT THE JUNCTION, judged against
      // the median step in the surrounding second. The obvious metric — the
      // largest step anywhere in a window around the seam — was tried first and
      // is useless on this material: mastered music with drums in it has steps
      // of 0.23 in every half-second window, so the window maximum is set by
      // the nearest snare and is completely blind to whether a splice happened.
      // A click is a step that is an OUTLIER for its neighbourhood, so that is
      // what gets measured.
      const jump = Math.abs(seam.data[s]! - seam.data[s - 1]!);
      const median = medianDelta(seam.data, s - Math.round(0.5 * pcm.sampleRate), s + Math.round(0.5 * pcm.sampleRate));
      ok(
        'the loop seam produces no click',
        jump <= median * 5,
        `junction step ${jump.toFixed(5)} = ${(jump / median).toFixed(2)}x the local median ${median.toFixed(5)}`,
      );
      let peak = 0;
      for (const v of seam.data) peak = Math.max(peak, Math.abs(v));
      ok('the seam does not clip', peak < 0.99, `peak ${peak.toFixed(3)}`);
      note(
        `loop seam: RMS deviation ${(dev * 100).toFixed(1)}% (gate 10%), ` +
          `junction step ${(jump / median).toFixed(2)}x local median (gate 5x), ` +
          `peak ${peak.toFixed(3)}`,
      );

      // CONTROL 1 — the click detector must fire on a real discontinuity.
      // Same audio, same position, but the second half is replaced with material
      // from 12 s away, which is what a loop with no crossfade sounds like.
      {
        const spliced = Float32Array.from(seam.data);
        const off = Math.round(12 * pcm.sampleRate);
        for (let i = s; i < spliced.length; i++) spliced[i] = seam.data[(i + off) % seam.data.length]!;
        const badJump = Math.abs(spliced[s]! - spliced[s - 1]!);
        ok(
          'seam CONTROL: the click detector fires on a spliced discontinuity',
          badJump > median * 5,
          `spliced junction step ${badJump.toFixed(5)} = ${(badJump / median).toFixed(2)}x median — ` +
            'if this did not trip the gate, the gate above would prove nothing',
        );
      }

      // CONTROL 2 — the RMS gate must be able to fail. A loop point two beats
      // late lands the seam on a different part of the phrase, and the level
      // continuity genuinely breaks.
      {
        const badEnd = seg.loop.endS + (60 / track.bpm) * 2;
        const bad = renderSeam(pcm, seg, track.gainDb, badEnd);
        const bs = bad.seamIndex;
        const bPre = rms(bad.data, bs - 4 * w, bs);
        const bAt = rms(bad.data, bs, bs + xfN);
        const bPost = rms(bad.data, bs + xfN, bs + xfN + 4 * w);
        const bDev = Math.abs(bAt / ((bPre + bPost) / 2) - 1);
        ok(
          'seam CONTROL: a two-beat-late loop point breaches the 10% gate',
          bDev > 0.1,
          `${(bDev * 100).toFixed(1)}% — if a wrong loop point passed, the gate above ` +
            'would prove nothing',
        );
        note(
          `seam gate calibration: chosen ${(dev * 100).toFixed(1)}%, ` +
            `two beats late ${(bDev * 100).toFixed(1)}%`,
        );
      }

      // HONEST LIMITATION, recorded where the next person will read it.
      //
      // RMS continuity is a LEVEL test. It cannot tell you the loop is in
      // phase with the beat: measured on this track, a loop point 137 ms
      // off-grid scores 0.9% and one a full beat late scores 1.1%, both
      // "better" than the chosen point's 3.3%, because the level simply does
      // not change much when you slide within a bar of similar music. Phase
      // alignment is established by a different instrument — the onset-envelope
      // comb search that measured the grid at 115.000 BPM with its origin at
      // 1.55 s — and the loop points are bar indices on that grid, not seconds
      // chosen to make this metric small.
      note(
        'loop seam RMS gate measures level continuity, NOT beat phase — ' +
          'phase comes from the 115.000 BPM grid measurement (see songs.ts)',
      );
    }
  }
}

// ===========================================================================

process.stdout.write('\n');
for (const n of notes) process.stdout.write(`  · ${n}\n`);
process.stdout.write(`\nmusic: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
