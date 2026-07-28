/**
 * prepare-music — vendor the developer's masters into models/music/.
 *
 *   npx tsx scripts/prepare-music.mts [--check]
 *
 * `music-src/` holds the masters and is gitignored (they are large, and they
 * are the developer's originals). This script produces the copies that ship,
 * measures each one, and writes models/music/manifest.json — which
 * scripts/test-music.mts then asserts agrees with src/game/music/songs.ts, so
 * the numbers the engine plans against cannot drift from the files it plays.
 *
 * ===========================================================================
 * WHY THE AUDIO IS COPIED BIT-EXACT INSTEAD OF NORMALISED IN PLACE
 * ===========================================================================
 *
 * The brief asked for "peak -3 dBFS" normalisation. Applying gain to an mp3
 * means decoding and re-encoding it, which costs a generation of lossy quality
 * on a file that is already lossy — for no benefit, because the gain can be
 * applied exactly and for free by the GainNode the song already plays through.
 *
 * So: an mp3 master is copied byte-for-byte, and the trim is MEASURED here and
 * recorded in the manifest as `gainDb`. The shipped file is provably the
 * developer's own render, and the -3 dBFS ceiling is enforced at runtime where
 * it actually matters. A WAV master (the castle edit) has no such constraint
 * and is encoded to 320 kbps mp3 once, from lossless.
 *
 * The trim itself is the SMALLER of two gains:
 *   1. the gain that brings the track's RMS to the level the procedural bed
 *      sits at in the region it plays in — because the audible requirement is
 *      that the handoff not jump, and RMS is what "does not jump" means; and
 *   2. the gain that puts the track's true peak at -3 dBFS.
 * Whichever is smaller wins, so the ceiling is a hard guarantee and loudness
 * matching happens underneath it.
 *
 * ID3: three of the four masters carry no ID3 tag at all (they begin on an mp3
 * frame sync). The fourth carries 4,096 bytes, 0.27% of its size. "Strip if
 * trivial" resolves to "there is nothing worth stripping, and re-muxing to drop
 * 4 KB would rewrite the Xing/LAME gapless header the loop points were measured
 * against". Left alone, deliberately.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTS, SONGS, type SongId } from '../src/game/music/songs.js';
import { PAD_FADE, PAD_OVERLAP } from '../src/game/music/interlude.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SRC = join(REPO, 'music-src');
const OUT = join(REPO, 'models', 'music');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * Where the procedural bed sits, per region, measured at volume 1.0 through the
 * whole bus (MASTER_TRIM included) by rendering 30 s with the Node shim:
 *
 *     wilds/calm   peak -17.04 dBFS   rms -31.02 dBFS
 *     village/calm peak -13.15 dBFS   rms -26.73 dBFS
 *     dungeon/calm peak -16.51 dBFS   rms -29.17 dBFS
 *     castle/calm  peak -13.09 dBFS   rms -27.08 dBFS
 *
 * The overworld rotation plays in wilds AND village, so its target is the mean
 * of those two — a song matched to the wilds alone would jump +4 dB every time
 * the player walked into a village.
 */
const BED_RMS_DBFS = {
  overworld: (-31.02 + -26.73) / 2,
  dungeon: -29.17,
  castle: -27.08,
} as const;

/** The bus trim between a song source and the output: MASTER_TRIM 0.55. */
const BUS_TRIM_DB = 20 * Math.log10(0.55);

/** Hard ceiling from the brief. Never exceeded, whatever the loudness match wants. */
const PEAK_CEILING_DBFS = -3;

interface SourceSpec {
  id: SongId;
  /** Preferred source, relative to music-src/. Tried in order. */
  candidates: string[];
  bed: keyof typeof BED_RMS_DBFS;
}

const SOURCES: SourceSpec[] = [
  { id: '500nm', candidates: ['500nanometers.mp3'], bed: 'overworld' },
  { id: 'ryan', candidates: ["Ryan's song.mp3"], bed: 'overworld' },
  { id: 'untitled', candidates: ['Untitled Song.mp3'], bed: 'dungeon' },
  {
    id: 'castle',
    // The coordinator is producing an edited, flowing version of the castle
    // track. Prefer it the moment it appears; fall back to the raw master until
    // then, so this script never blocks on work happening elsewhere.
    candidates: ['processed/project1-castle.wav', 'Project 1 Logic Kaven MartinezWAVE (1).mp3'],
    bed: 'castle',
  },
];

function ffprobeDuration(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

/**
 * Run an ffmpeg analysis filter and return everything it said.
 *
 * ffmpeg writes filter reports to STDERR, not stdout — capturing only stdout
 * returns an empty string and every measurement silently reads as "no match".
 */
function ffmpegReport(args: string[]): string {
  const r = spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** max_volume / mean_volume in dBFS, from ffmpeg's volumedetect. */
function levels(file: string): { peakDb: number; rmsDb: number } {
  const text = ffmpegReport(['-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(text);
  const rms = /mean_volume:\s*(-?[\d.]+) dB/.exec(text);
  if (!peak || !rms) throw new Error(`volumedetect gave no levels for ${file}`);
  return { peakDb: Number(peak[1]), rmsDb: Number(rms[1]) };
}

/** Integrated loudness, for the report only. */
function lufs(file: string): number {
  const text = ffmpegReport(['-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
  const m = /I:\s*(-?[\d.]+) LUFS/.exec(text);
  return m ? Number(m[1]) : NaN;
}

/**
 * Every silence in the track longer than `minS`, as [start, end] seconds.
 *
 * Used to prove the pad does not step out of the way into a hole. A song may
 * legitimately open with rests — the castle track has eleven of them in its
 * first fourteen seconds — and the pivoted pad has to hold until the material
 * is continuous, or the handoff has an audible gap in it that reads as a fault
 * rather than as composition.
 */
function silences(file: string, minS = 0.12, floorDb = -60): [number, number][] {
  const text = ffmpegReport([
    '-i', file, '-af', `silencedetect=noise=${floorDb}dB:d=${minS}`, '-f', 'null', '-',
  ]);
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const line of text.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push([start, Number(e[1])]);
      start = null;
    }
  }
  return out;
}

interface ManifestEntry {
  id: SongId;
  file: string;
  source: string;
  bytes: number;
  durationS: number;
  sourcePeakDb: number;
  sourceRmsDb: number;
  sourceLufs: number;
  /** Runtime trim, dB. See the header. */
  gainDb: number;
  /** Which constraint set the trim. */
  gainSetBy: 'loudness-match' | 'peak-ceiling';
  bitExact: boolean;
  /** Measured silences longer than 120 ms, [start, end] seconds. */
  silences?: [number, number][];
}

function main(): void {
  if (!existsSync(SRC)) {
    console.error(`no music-src/ at ${SRC}\nthe masters are gitignored; they must be present to vendor.`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  const entries: ManifestEntry[] = [];
  let failures = 0;

  for (const spec of SOURCES) {
    const track = SONGS[spec.id];
    const src = spec.candidates.map((c) => join(SRC, c)).find((p) => existsSync(p));
    if (!src) {
      console.error(`  MISSING  ${spec.id}: none of ${spec.candidates.join(', ')} under music-src/`);
      failures++;
      continue;
    }
    const isWav = src.toLowerCase().endsWith('.wav');
    const dest = join(OUT, track.file);

    if (!CHECK_ONLY) {
      if (isWav) {
        // Lossless source: one encode, at the highest constant bitrate, and
        // strip metadata while we are re-muxing anyway.
        execFileSync('ffmpeg', [
          '-v', 'error', '-y', '-i', src,
          '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '320k',
          dest,
        ]);
      } else {
        copyFileSync(src, dest);
      }
    }
    if (!existsSync(dest)) {
      console.error(`  MISSING  ${dest} was not produced`);
      failures++;
      continue;
    }

    const dur = ffprobeDuration(dest);
    const lv = levels(dest);
    const loud = lufs(dest);

    const target = BED_RMS_DBFS[spec.bed];
    // Gain that lands the track's RMS on the bed's, once the bus trim is paid.
    const loudnessGain = target - lv.rmsDb - BUS_TRIM_DB;
    // Gain that lands its peak on the ceiling.
    const peakGain = PEAK_CEILING_DBFS - lv.peakDb;
    const gainDb = Math.min(loudnessGain, peakGain);

    entries.push({
      id: spec.id,
      file: track.file,
      source: src.slice(REPO.length + 1).split('\\').join('/'),
      bytes: statSync(dest).size,
      durationS: Number(dur.toFixed(3)),
      sourcePeakDb: lv.peakDb,
      sourceRmsDb: lv.rmsDb,
      sourceLufs: Number.isFinite(loud) ? loud : 0,
      gainDb: Number(gainDb.toFixed(2)),
      gainSetBy: loudnessGain <= peakGain ? 'loudness-match' : 'peak-ceiling',
      bitExact: !isWav,
    });
  }

  // --- checks that would otherwise fail silently at runtime ----------------
  for (const e of entries) {
    const track = SONGS[e.id];
    const drift = Math.abs(e.durationS - track.durationS);
    if (drift > 0.05) {
      console.error(
        `  DURATION DRIFT  ${e.id}: file is ${e.durationS}s, songs.ts says ${track.durationS}s`,
      );
      failures++;
    }
    // A loop needs real audio after its end point to crossfade against.
    const seg = Object.values(SEGMENTS).find((s) => s.song === e.id && s.loop);
    if (seg?.loop) {
      const tail = e.durationS - seg.loop.endS;
      if (tail < seg.loop.crossfadeS) {
        console.error(
          `  LOOP TAIL TOO SHORT  ${e.id}: ${tail.toFixed(3)}s after loop end, ` +
            `crossfade needs ${seg.loop.crossfadeS}s`,
        );
        failures++;
      }
    }
    if (e.gainDb + e.sourcePeakDb > PEAK_CEILING_DBFS + 0.01) {
      console.error(`  PEAK CEILING BREACHED  ${e.id}`);
      failures++;
    }

    // THE PAD MUST NOT STEP OUT INTO A HOLE.
    //
    // Once the pivoted pad has faded, the song is carrying the mix alone. Any
    // silence longer than the 120 ms gate from that moment on is audible as a
    // gap at the handoff. This is checked against the real file, so an edited
    // re-export with a different opening cannot quietly reintroduce it.
    const holes = silences(join(OUT, e.file));
    e.silences = holes.map(([a, b]) => [Number(a.toFixed(2)), Number(b.toFixed(2))]);
    for (const s of Object.values(SEGMENTS)) {
      if (s.song !== e.id) continue;
      const padGone = s.startS + (s.padOverlapS ?? PAD_OVERLAP) + PAD_FADE;
      const bodyEnd = s.loop ? s.loop.endS : s.endS - s.fadeOutS;
      const exposed = holes.filter(([a, b]) => b > padGone && a < bodyEnd);
      if (exposed.length) {
        console.error(
          `  PAD STEPS INTO A HOLE  ${s.id}: silence at ` +
            exposed.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}s`).join(', ') +
            ` — the pad clears at ${padGone.toFixed(2)}s. Raise padOverlapS on this segment.`,
        );
        failures++;
      }
    }
  }

  const total = entries.reduce((s, e) => s + e.bytes, 0);
  const manifest = {
    _readme: [
      'Generated by scripts/prepare-music.mts. Do not hand-edit.',
      'These are the developer\'s own compositions, vendored from music-src/.',
      'mp3 masters are copied BIT-EXACT; gainDb is applied at runtime by the',
      'song player, so the shipped bytes are the developer\'s own render.',
      'scripts/test-music.mts asserts this file agrees with src/game/music/songs.ts.',
    ],
    generatedBy: 'scripts/prepare-music.mts',
    totalBytes: total,
    entries,
  };

  if (!CHECK_ONLY) {
    writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  const fmt = (b: number) => `${(b / 1048576).toFixed(2)} MB`;
  process.stdout.write(`\nprepare-music -> ${OUT}\n\n`);
  for (const e of entries) {
    process.stdout.write(
      `  ${e.file.padEnd(24)} ${fmt(e.bytes).padStart(9)}  ${e.durationS.toFixed(1)}s  ` +
        `peak ${e.sourcePeakDb.toFixed(1)}  rms ${e.sourceRmsDb.toFixed(1)}  ` +
        `${e.sourceLufs.toFixed(1)} LUFS  ->  gain ${e.gainDb.toFixed(2)} dB (${e.gainSetBy})` +
        `${e.bitExact ? '' : '  [encoded from wav]'}\n`,
    );
  }
  process.stdout.write(`\n  ${entries.length} tracks, ${fmt(total)} total — the depot delta.\n`);

  // Anything else in models/music/ is not shipped by intent; say so loudly.
  const stray = readdirSync(OUT).filter(
    (f) => f !== 'manifest.json' && !entries.some((e) => e.file === f),
  );
  if (stray.length) process.stdout.write(`  note: unlisted files present: ${stray.join(', ')}\n`);

  if (failures > 0) {
    process.stdout.write(`\nprepare-music: ${failures} problem(s)\n`);
    process.exit(1);
  }
  process.stdout.write('\nprepare-music: ok\n');
}

/** Re-read the manifest — used by the tests. */
export function readManifest(): { entries: ManifestEntry[]; totalBytes: number } {
  return JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
}

main();
