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

interface ManifestShape {
  policy: { allowed: string[] };
  scannedDirs: string[];
  credits: AudioCredit[];
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
