/**
 * Sourcing guard for audio assets.
 *   npx tsx scripts/test-audio-credits.mts
 *
 * The game synthesizes every sound and imports no audio files at all, so today
 * this walks three directories, finds nothing, and passes. That is not the
 * point. The point is the day somebody drags a freesound.org .wav into
 * `public/` — which is exactly the day nobody writes the licence down. An NC-
 * or SA-licensed sample in a commercial Steam build is a takedown, not a bug,
 * and it is invisible in a diff.
 *
 * Modelled on the REQUIRED_ASSETS / FORBIDDEN_ASSETS pair in
 * `scripts/pack-steam.mjs`: an exclusive allow-list so a new licence is a
 * deliberate human decision, plus named patterns for the ones people actually
 * reach for so the refusal says WHY rather than just "no".
 *
 * Checks, in order:
 *   1. the walk works at all (it must see a plausible number of files, or a
 *      broken glob would make every other check vacuously green)
 *   2. every audio file found has a manifest entry
 *   3. every manifest entry points at a file that exists (no stale credits)
 *   4. every entry has non-empty url / author / licence
 *   5. every licence is in ALLOWED_AUDIO_LICENCES, verbatim
 *   6. no licence matches a FORBIDDEN_AUDIO_LICENCES pattern
 *   7. the JSON manifest and the in-bundle AUDIO_CREDITS are deep-equal
 *   8. the JSON policy block and the exported allow-list agree
 *   9. every vendored PIPER VOICE has a licence record, and that record is
 *      inside the voice-model policy (see below)
 *
 * WHY 9 IS A SEPARATE LIST. The villagers speak with neural TTS weights, not
 * with imported .wav files: nothing under `models/` is reachable by the walk,
 * and the extension list would never match a `.onnx`. But those weights are
 * third-party, they ship in the depot, and a Piper voice inherits the licence
 * of whatever speech it was trained on — which differs per voice inside a
 * single HuggingFace repository. `en_US-hfc_female-medium`, the voice most
 * guides recommend when somebody wants a female Piper voice, is
 * CC BY-NC-SA 4.0: unusable here, and nothing in the build would have said so.
 * So the manifest carries a `voiceModels` list and this guard fails if a
 * vendored voice is missing from it.
 *
 * They are NOT folded into `credits`, because `credits` is deep-equality
 * checked against AUDIO_CREDITS in sfx.ts — the array the in-game credits
 * panel renders — and a 63 MB acoustic model is not a sound effect.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_CREDITS, ALLOWED_AUDIO_LICENCES, FORBIDDEN_AUDIO_LICENCES,
  type AudioCredit,
} from '../src/game/audio/sfx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'scripts', 'audio-credits.json');

/**
 * Extensions that count as an audio asset. Trackers and MIDI are in the list
 * deliberately — a .xm from modarchive carries a licence too.
 */
const AUDIO_EXT = new Set([
  '.wav', '.wave', '.mp3', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac',
  '.aiff', '.aif', '.aifc', '.wma', '.mid', '.midi', '.mod', '.xm', '.it',
  '.s3m', '.caf', '.au',
]);

/** Directories that ship, or that ship after a build. */
const ASSET_DIRS = ['public', 'src', 'app'];

/**
 * Skipped inside those trees. `src/audio/espeak` is a WASM build (no audio
 * files, but it is large and there is no reason to walk it).
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-steam']);

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Walk
// ---------------------------------------------------------------------------

interface Found { rel: string; bytes: number }

const audioFiles: Found[] = [];
let filesSeen = 0;

function walk(abs: string): void {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(abs, e.name));
      continue;
    }
    if (!e.isFile()) continue;
    filesSeen++;
    const ext = path.extname(e.name).toLowerCase();
    if (!AUDIO_EXT.has(ext)) continue;
    const full = path.join(abs, e.name);
    audioFiles.push({
      rel: path.relative(ROOT, full).split(path.sep).join('/'),
      bytes: statSync(full).size,
    });
  }
}

for (const d of ASSET_DIRS) {
  const abs = path.join(ROOT, d);
  check(`asset dir exists: ${d}`, existsSync(abs), `${abs} is missing`);
  walk(abs);
}

// INSTRUMENT SANITY. A walk that silently matched nothing would make checks
// 2-6 pass on an empty set and prove nothing at all. `src/` alone is several
// hundred files, so anything under 100 means the walk is broken, not that the
// tree is clean.
check('walk reached the source tree', filesSeen > 100,
  `only saw ${filesSeen} files across ${ASSET_DIRS.join(', ')} — the walk is broken, `
  + 'not the tree');

// ---------------------------------------------------------------------------
// 2. Manifest load
// ---------------------------------------------------------------------------

/** One vendored neural TTS voice, with the provenance that justifies shipping it. */
interface VoiceModelCredit {
  dir: string;
  file: string;
  voice: string;
  role: string;
  url: string;
  licenceUrl: string;
  author: string;
  licence: string;
  note?: string;
}

interface ManifestShape {
  policy: { allowed: string[] };
  scannedDirs: string[];
  credits: AudioCredit[];
  voiceModelPolicy?: { allowed: string[] };
  voiceModels?: VoiceModelCredit[];
  voiceModelsRejected?: Array<{ voice: string; licence: string; why: string }>;
}

let manifest: ManifestShape | null = null;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as ManifestShape;
} catch (e) {
  check('audio-credits.json parses', false, String(e));
}

check('audio-credits.json parses', manifest !== null);
check('manifest has a credits array', Array.isArray(manifest?.credits));
check('manifest has a policy.allowed array', Array.isArray(manifest?.policy?.allowed));

const credits: AudioCredit[] = manifest?.credits ?? [];
const byFile = new Map<string, AudioCredit>();
for (const c of credits) byFile.set(String(c.file).split('\\').join('/'), c);

// ---------------------------------------------------------------------------
// 3. Coverage — every audio file found must be credited
// ---------------------------------------------------------------------------

for (const f of audioFiles) {
  check(`credited: ${f.rel}`, byFile.has(f.rel),
    `${f.rel} (${f.bytes} bytes) is an audio asset with no entry in `
    + 'scripts/audio-credits.json. Every imported sound needs {file, url, author, licence}.');
}

// ...and no stale entries pointing at files that are gone.
for (const c of credits) {
  const rel = String(c.file).split('\\').join('/');
  check(`manifest entry resolves: ${rel}`, existsSync(path.join(ROOT, rel)),
    `credited but not on disk — delete the entry or restore the file`);
}

// ---------------------------------------------------------------------------
// 4-6. Licence policy
// ---------------------------------------------------------------------------

for (const c of credits) {
  const id = c.file ?? '(no file)';
  check(`entry has url: ${id}`, typeof c.url === 'string' && c.url.length > 0);
  check(`entry has author: ${id}`, typeof c.author === 'string' && c.author.length > 0);
  check(`entry has licence: ${id}`, typeof c.licence === 'string' && c.licence.length > 0);

  const lic = String(c.licence ?? '');

  // Named refusals first, so the message says why rather than just "not allowed".
  for (const f of FORBIDDEN_AUDIO_LICENCES) {
    check(`licence not forbidden (${f.pattern}): ${id}`, !f.pattern.test(lic),
      `'${lic}' — ${f.why}`);
  }

  check(`licence allowed: ${id}`, ALLOWED_AUDIO_LICENCES.includes(lic),
    `'${lic}' is not one of: ${ALLOWED_AUDIO_LICENCES.join(', ')}. `
    + 'Adding a licence to the allow-list is a deliberate decision, not an import.');
}

// ---------------------------------------------------------------------------
// 7-8. The two copies must agree
// ---------------------------------------------------------------------------

const norm = (list: readonly AudioCredit[]): string =>
  JSON.stringify(list.map((c) => ({
    file: String(c.file).split('\\').join('/'),
    url: c.url, author: c.author, licence: c.licence, note: c.note ?? null,
  })));

check('AUDIO_CREDITS matches audio-credits.json', norm(AUDIO_CREDITS) === norm(credits),
  `sfx.ts AUDIO_CREDITS has ${AUDIO_CREDITS.length} entries, the JSON has `
  + `${credits.length}. They must be identical — the panel renders one and the `
  + 'guard reads the other.');

check('policy.allowed matches ALLOWED_AUDIO_LICENCES',
  JSON.stringify(manifest?.policy?.allowed ?? []) === JSON.stringify(ALLOWED_AUDIO_LICENCES),
  `JSON: ${JSON.stringify(manifest?.policy?.allowed)} vs `
  + `sfx.ts: ${JSON.stringify(ALLOWED_AUDIO_LICENCES)}`);

check('manifest scannedDirs matches this guard',
  JSON.stringify(manifest?.scannedDirs ?? []) === JSON.stringify(ASSET_DIRS),
  'the manifest documents which dirs are audited; keep it true');

// ---------------------------------------------------------------------------
// 9. Vendored TTS voices
// ---------------------------------------------------------------------------

const voiceModels = manifest?.voiceModels ?? [];
const voicePolicy = manifest?.voiceModelPolicy?.allowed ?? [];

check('manifest has a voiceModelPolicy.allowed array', Array.isArray(manifest?.voiceModelPolicy?.allowed));
check('manifest has a voiceModels array', Array.isArray(manifest?.voiceModels));
check('voiceModels is not empty', voiceModels.length > 0,
  'the villagers speak with SOMETHING; if this list is empty either a voice lost '
  + 'its licence record or the TTS path was deleted');

for (const v of voiceModels) {
  const id = v.voice ?? '(no voice)';
  check(`voice has dir: ${id}`, typeof v.dir === 'string' && v.dir.length > 0);
  check(`voice has url: ${id}`, typeof v.url === 'string' && v.url.length > 0);
  check(`voice has licenceUrl: ${id}`, typeof v.licenceUrl === 'string' && v.licenceUrl.length > 0,
    'the licence has to be checkable by somebody who is not you');
  check(`voice has author: ${id}`, typeof v.author === 'string' && v.author.length > 0);
  check(`voice has licence: ${id}`, typeof v.licence === 'string' && v.licence.length > 0);

  const lic = String(v.licence ?? '');
  for (const f of FORBIDDEN_AUDIO_LICENCES) {
    check(`voice licence not forbidden (${f.pattern}): ${id}`, !f.pattern.test(lic),
      `'${lic}' — ${f.why}`);
  }
  check(`voice licence allowed: ${id}`, voicePolicy.includes(lic),
    `'${lic}' is not one of: ${voicePolicy.join(', ')}. A Piper voice inherits its `
    + 'training data\'s licence; widening this list is a deliberate decision.');
}

/**
 * COVERAGE FROM THE SOURCE, not from the disk.
 *
 * `models/` is gitignored, so a checkout with no weights would make a
 * disk-only scan pass by finding nothing — the vacuous-green failure mode this
 * file exists to avoid. The authoritative list of voices the game will try to
 * speak with is in tts-worker.ts, and it is there whether or not the weights
 * have been fetched.
 */
const workerSrc = readFileSync(path.join(ROOT, 'src', 'game', 'voice', 'tts-worker.ts'), 'utf-8');
const referencedVoices = [...workerSrc.matchAll(/local\/([A-Za-z0-9._-]*piper[A-Za-z0-9._-]*)/g)]
  .map((m) => m[1]);
const uniqueVoices = [...new Set(referencedVoices)];

check('tts-worker.ts references at least one piper voice', uniqueVoices.length > 0,
  'the regex found no voice directories — if the worker was restructured, this '
  + 'guard is no longer reading it and must be updated');

for (const dirName of uniqueVoices) {
  check(`voice referenced by tts-worker.ts is licensed: ${dirName}`,
    voiceModels.some((v) => v.dir === `models/${dirName}`),
    `tts-worker.ts synthesizes on models/${dirName} but audio-credits.json has no `
    + 'voiceModels entry for it. Vendoring a voice without recording its licence is '
    + 'how an NC-licensed voice reaches a paid build.');
}

// ...and when the weights ARE present, the records must point at real bytes.
const MODELS_DIR = path.join(ROOT, 'models');
if (existsSync(MODELS_DIR)) {
  for (const v of voiceModels) {
    check(`voice file on disk: ${v.voice}`, existsSync(path.join(ROOT, v.file)),
      `${v.file} is credited but absent — run npm run weights`);
  }
  const onDisk = readdirSync(MODELS_DIR)
    .filter((d) => d.includes('--') && /piper/i.test(d)
      && statSync(path.join(MODELS_DIR, d)).isDirectory());
  for (const d of onDisk) {
    check(`vendored voice is licensed: ${d}`,
      voiceModels.some((v) => v.dir === `models/${d}`),
      `models/${d} is vendored and would be packed into the depot with no licence record`);
  }
}

// The rejected list is evidence of diligence, and it is also a live regression
// guard: it keeps the NC voice named so nobody re-proposes it, and the check
// below proves the forbidden matcher would actually have caught it.
const rejected = manifest?.voiceModelsRejected ?? [];
check('rejected voice candidates are recorded', rejected.length > 0,
  'the licence review found unusable candidates; recording them is what stops '
  + 'the next person repeating the search');
for (const r of rejected) {
  check(`rejected entry has a reason: ${r.voice ?? '(no voice)'}`,
    typeof r.why === 'string' && r.why.length > 0);
}
const ncCandidate = rejected.find((r) => /hfc_female/.test(r.voice ?? ''));
check('the NC female voice is named as rejected', ncCandidate !== undefined,
  'en_US-hfc_female-medium is the first hit for "piper female voice" and is '
  + 'CC BY-NC-SA; it must stay on the record as refused');
check('...and the forbidden matcher bites on its licence',
  ncCandidate !== undefined
  && FORBIDDEN_AUDIO_LICENCES.some((f) => f.pattern.test(ncCandidate.licence)),
  `'${ncCandidate?.licence}' should match an NC/SA pattern — if it does not, the `
  + 'patterns have drifted and would let it through');

// ---------------------------------------------------------------------------
// 10. The soundtrack
// ---------------------------------------------------------------------------
//
// Four compositions written and recorded by the developer, vendored into
// models/music/ and shipped in the depot. They are not third-party material and
// so are not in `credits` (see the _readme) — but "we own it" is a claim that
// still has to be RECORDED, because in two years the question "where did this
// track come from and are we clear to ship it?" will be asked by someone who
// was not here. The provenance trail that covers every SFX now covers the music.
//
// Coverage is taken from src/game/music/songs.ts rather than from the disk. A
// disk-only scan would pass vacuously on a checkout where the vendoring step
// has not been run, which is the exact failure this guard exists to prevent.

const music = manifest?.music ?? [];
const musicPolicy = manifest?.musicPolicy?.allowed ?? [];

check('manifest has a musicPolicy.allowed array', Array.isArray(manifest?.musicPolicy?.allowed));
check('manifest has a music array', Array.isArray(manifest?.music));
check('music is not empty', music.length > 0,
  'the game ships a soundtrack; an empty list means a track lost its provenance '
  + 'record or the music assets were dropped');

for (const m of music) {
  const id = m.title ?? m.id ?? '(no title)';
  check(`track has id: ${id}`, typeof m.id === 'string' && m.id.length > 0);
  check(`track has file: ${id}`, typeof m.file === 'string' && m.file.length > 0);
  check(`track has author: ${id}`, typeof m.author === 'string' && m.author.length > 0);
  check(`track states its rights: ${id}`, typeof m.rights === 'string' && m.rights.length > 0,
    'a self-owned work still needs the ownership written down');
  check(`track names its source master: ${id}`,
    typeof m.source === 'string' && m.source.startsWith('music-src/'),
    'the master it was vendored from, so the chain back to the original render is auditable');
  check(`track has licence: ${id}`, typeof m.licence === 'string' && m.licence.length > 0);

  const lic = String(m.licence ?? '');
  // The forbidden patterns apply here too. They are not expected to fire on the
  // developer's own work — they are here to catch a THIRD-PARTY track being
  // added to this list by mistake, where it would bypass the credits vetting.
  for (const f of FORBIDDEN_AUDIO_LICENCES) {
    check(`track licence not forbidden (${f.pattern}): ${id}`, !f.pattern.test(lic),
      `'${lic}' — ${f.why}. A third-party track belongs in 'credits', not here.`);
  }
  check(`track licence allowed: ${id}`, musicPolicy.includes(lic),
    `'${lic}' is not one of: ${musicPolicy.join(', ')}`);
}

// Coverage both ways against the engine's own catalogue.
{
  const songsSrc = readFileSync(
    path.join(ROOT, 'src', 'game', 'music', 'songs.ts'), 'utf-8');
  const files = [...songsSrc.matchAll(/^\s*file: '([^']+)',/gm)].map((m) => m[1]);
  const unique = [...new Set(files)];
  check('songs.ts names at least one music file', unique.length > 0,
    'the regex found no `file:` entries — if songs.ts was restructured this '
    + 'guard is no longer reading it and must be updated');

  for (const f of unique) {
    check(`track played by the engine is credited: ${f}`,
      music.some((m) => m.file === `models/music/${f}`),
      `src/game/music/songs.ts plays models/music/${f} but audio-credits.json has `
      + 'no music entry for it. Shipping audio without recording where it came '
      + 'from is exactly what this manifest exists to prevent.');
  }
  for (const m of music) {
    const base = String(m.file).replace(/^models\/music\//, '');
    check(`credited track is actually played: ${base}`, unique.includes(base),
      `${m.file} is credited but songs.ts never plays it — delete the entry or `
      + 'wire the track up');
  }
}

// ...and when the vendored files ARE present, the records must point at bytes.
const MUSIC_DIR = path.join(ROOT, 'models', 'music');
if (existsSync(MUSIC_DIR)) {
  for (const m of music) {
    check(`music file on disk: ${m.id}`, existsSync(path.join(ROOT, m.file)),
      `${m.file} is credited but absent — run npx tsx scripts/prepare-music.mts`);
  }
  const strays = readdirSync(MUSIC_DIR)
    .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()));
  for (const f of strays) {
    check(`vendored track is credited: ${f}`,
      music.some((m) => m.file === `models/music/${f}`),
      `models/music/${f} would be packed into the depot with no provenance record`);
  }
}

// ---------------------------------------------------------------------------
// Self-test of the forbidden patterns
// ---------------------------------------------------------------------------
//
// The patterns are the whole product here, and an empty credits list exercises
// none of them. These assert the matcher actually bites on the strings people
// paste out of freesound.org, and — just as important — does NOT bite on the
// two licences that are allowed.

{
  const mustReject = [
    'CC-BY-NC-4.0', 'CC BY-NC-SA 3.0', 'CC-BY-SA-4.0', 'NonCommercial',
    'BBC Sound Effects', 'GPL-3.0', 'AGPL-3.0', 'CC-BY-ND-4.0', 'ShareAlike',
  ];
  for (const lic of mustReject) {
    const hit = FORBIDDEN_AUDIO_LICENCES.some((f) => f.pattern.test(lic))
      || !ALLOWED_AUDIO_LICENCES.includes(lic);
    check(`policy rejects '${lic}'`, hit);
  }

  const mustAccept = ['CC0-1.0', 'CC-BY-4.0'];
  for (const lic of mustAccept) {
    const forbidden = FORBIDDEN_AUDIO_LICENCES.find((f) => f.pattern.test(lic));
    check(`policy accepts '${lic}'`,
      ALLOWED_AUDIO_LICENCES.includes(lic) && forbidden === undefined,
      forbidden ? `wrongly matched by ${forbidden.pattern}` : 'not in the allow-list');
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\naudio-credits: scanned ${filesSeen} files under `
  + `${ASSET_DIRS.join(', ')}; found ${audioFiles.length} audio asset(s); `
  + `${credits.length} manifest entr${credits.length === 1 ? 'y' : 'ies'}.`);
if (audioFiles.length === 0) {
  console.log('  (zero imported audio is the expected state — everything is synthesized)');
}
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
