/**
 * Build the Steam depot directory.
 *
 *   node scripts/pack-steam.mjs                 # release build → dist-steam/
 *   node scripts/pack-steam.mjs --mode=default  # keeps __gameDebug (for harnesses)
 *   node scripts/pack-steam.mjs --skip-build    # reuse the dist/ already there
 *   node scripts/pack-steam.mjs --skip-models   # keep the 1 GB already copied
 *
 * Output is `dist-steam/`, and that directory IS the depot content — point
 * SteamPipe's `ContentRoot` at it. There is no installer: Steam ships a raw
 * directory and runs the exe from wherever it syncs it.
 *
 * WHY @electron/packager rather than electron-builder: builder's value is its
 * installers (NSIS, Squirrel, auto-update, code signing, differential updates)
 * and Steam wants none of them — it does distribution, patching and integrity
 * itself. builder's `--dir` target gets you here too, but drags in the NSIS and
 * winCodeSign toolchains as a side effect. packager does exactly the one job:
 * copy an Electron runtime, drop the app beside it, rename the exe.
 *
 * WHY asar: false — the app is six .cjs files plus steamworks.js, whose native
 * .node binding would need an unpack rule anyway. Leaving it loose costs
 * nothing at this size and means the depot is readable, so anyone auditing what
 * shipped can just look.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { packager } from '@electron/packager';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'dist-steam');
const TMP = path.join(REPO, 'dist-steam-tmp');
const APP_NAME = 'A Tale of Yarn';

const args = process.argv.slice(2);
const arg = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const MODE = arg('mode', 'release');
const SKIP_BUILD = args.includes('--skip-build');
// Re-copying 1.04 GB of weights on every iteration is minutes of nothing. The
// weights are inert — when only wrapper code or dist/ changed, keep them.
const SKIP_MODELS = args.includes('--skip-models');

const MB = 1024 * 1024;
const fmt = (n) => (n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(2)} GB`
  : n >= MB ? `${(n / MB).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { total += fs.statSync(p).size; files++; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { total, files };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─── 1. Build ────────────────────────────────────────────────────────────────

if (!SKIP_BUILD) {
  console.log(`[1/6] vite build (mode=${MODE})`);
  const env = { ...process.env };
  if (MODE === 'release') env.VITE_STEAM_RELEASE = '1';
  else delete env.VITE_STEAM_RELEASE;
  execFileSync('npx', ['vite', 'build'], { cwd: REPO, env, stdio: 'inherit', shell: true });
} else {
  console.log('[1/6] skipping build (--skip-build)');
}

const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'game.html'))) {
  console.error('no dist/game.html — run `npm run build` first');
  process.exit(1);
}

// ─── 2. Prune dist/ to the game path ─────────────────────────────────────────
//
// docs/PORTING.md §1.6/§2.9(6): dist/ is 24 MB, of which 21 MB is the ONNX
// runtime and ~380 KB is eSpeak NG — both on the index.html playground path,
// neither reachable from game.html. Dropping them is worth more than the bytes:
// eSpeak is GPL-3.0, and Valve's rules say an application containing
// third-party open-source code incompatible with the Steamworks SDK must not be
// distributed via Steam.
//
// Rather than maintain a denylist that silently rots when a chunk is renamed,
// walk the actual ES-module import graph out of game.html and ship its closure.
// If the walk under-collects, the game fails to boot and the offline harness
// (scripts/steam-pack-check.mjs) catches it on the very next run.

console.log('[2/6] pruning dist to the game.html module closure');

const entryHtml = fs.readFileSync(path.join(DIST, 'game.html'), 'utf8');
const keep = new Set(['game.html']);
const queue = [];

for (const m of entryHtml.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
  keep.add(m[1]);
  if (m[1].endsWith('.js')) queue.push(m[1]);
}

// Vite emits relative specifiers between chunks: `from"./x.js"`, `import"./x.js"`,
// `import("./x.js")`, and `new URL("./x.wasm",import.meta.url)`. One pattern
// covers all of them because they all end in a quoted "./name.ext".
const REF = /["']\.\/([\w.-]+\.(?:js|css|wasm|json|data))["']/g;

while (queue.length) {
  const rel = queue.pop();
  const file = path.join(DIST, 'assets', path.basename(rel));
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(REF)) {
    const next = `assets/${m[1]}`;
    if (keep.has(next)) continue;
    keep.add(next);
    if (next.endsWith('.js')) queue.push(next);
  }
}

const PRUNED = path.join(TMP, 'dist');
fs.rmSync(TMP, { recursive: true, force: true });
for (const rel of keep) {
  const src = path.join(DIST, rel);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(PRUNED, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const before = dirSize(DIST);
const after = dirSize(PRUNED);
console.log(`      dist ${fmt(before.total)} (${before.files} files)`
  + ` → ${fmt(after.total)} (${after.files} files)`);
const dropped = fs.readdirSync(path.join(DIST, 'assets'))
  .filter((f) => !keep.has(`assets/${f}`));
console.log(`      dropped: ${dropped.join(', ')}`);

// ─── 3. Stage the wrapper app ────────────────────────────────────────────────

console.log('[3/6] staging app/steam');
const STAGE = path.join(TMP, 'app');
fs.mkdirSync(STAGE, { recursive: true });
for (const f of fs.readdirSync(path.join(REPO, 'app', 'steam'))) {
  fs.copyFileSync(path.join(REPO, 'app', 'steam', f), path.join(STAGE, f));
}

// steamworks.js travels with the app. Provenance is printed loudly because
// package.json pins the GIT repo (docs/PORTING.md §2.6) but the git checkout
// ships no compiled binding — see the header of app/steam/steam.cjs.
const SW_SRC = path.join(REPO, 'node_modules', 'steamworks.js');
if (fs.existsSync(SW_SRC)) {
  const SW_DEST = path.join(STAGE, 'node_modules', 'steamworks.js');
  copyDir(SW_SRC, SW_DEST);
  const binding = path.join(SW_DEST, 'dist', 'win64', 'steamworksjs.win32-x64-msvc.node');
  if (fs.existsSync(binding)) {
    const st = fs.statSync(binding);
    console.log(`      steamworks.js native binding present (${fmt(st.size)})`);
  } else {
    console.log('      steamworks.js has NO native binding — Steam features will'
      + ' degrade gracefully (the game still runs). Build it with a Rust +'
      + ' MSVC toolchain: cd node_modules/steamworks.js && npm run build');
  }
} else {
  console.log('      steamworks.js not installed — skipping');
}

// ─── 4. Package ──────────────────────────────────────────────────────────────

console.log('[4/6] @electron/packager');
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(REPO, 'node_modules', 'electron', 'package.json'), 'utf8')).version;

const [appPath] = await packager({
  dir: STAGE,
  out: path.join(TMP, 'packaged'),
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  asar: false,
  prune: false,
  overwrite: true,
  name: APP_NAME,
  appVersion: '0.1.0',
  appCopyright: 'A Tale of Yarn',
  quiet: true,
});

// ─── 5. Assemble the depot ───────────────────────────────────────────────────

console.log('[5/6] assembling dist-steam');
// Clear the depot but leave the weights where they are. Renaming the models
// directory out of the way and back is what a first version did, and Windows
// refuses it with EPERM often enough (a 1 GB file the OS still has open) that
// deleting around it is the reliable shape.
if (SKIP_MODELS && fs.existsSync(OUT)) {
  for (const e of fs.readdirSync(OUT)) {
    if (e === 'resources') continue;
    fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
  }
  const resources = path.join(OUT, 'resources');
  if (fs.existsSync(resources)) {
    for (const e of fs.readdirSync(resources)) {
      if (e === 'models') continue;
      fs.rmSync(path.join(resources, e), { recursive: true, force: true });
    }
  }
} else {
  fs.rmSync(OUT, { recursive: true, force: true });
}
copyDir(appPath, OUT);

copyDir(PRUNED, path.join(OUT, 'resources', 'dist'));

const MODELS = path.join(REPO, 'models');
const shipModels = fs.existsSync(MODELS)
  ? fs.readdirSync(MODELS).filter((d) => {
    // Only the vendored HF-style repos — never the flux2/piper/whisper dirs,
    // which are the playground's and are not on the game path at all.
    const p = path.join(MODELS, d);
    return fs.statSync(p).isDirectory() && d.includes('--');
  })
  : [];
for (const d of SKIP_MODELS ? [] : shipModels) {
  process.stdout.write(`      models/${d} … `);
  copyDir(path.join(MODELS, d), path.join(OUT, 'resources', 'models', d));
  console.log(fmt(dirSize(path.join(OUT, 'resources', 'models', d)).total));
}
if (SKIP_MODELS) {
  console.log(`      models kept from the previous pack `
    + `(${fmt(dirSize(path.join(OUT, 'resources', 'models')).total)})`);
}
if (shipModels.length === 0 && !SKIP_MODELS) {
  console.log('      NO MODELS VENDORED — run `npx tsx scripts/fetch-weights.mts` first.');
}

// steam_appid.txt must sit next to the executable: the Steam API looks for it
// in the working directory when a game is launched outside the client.
fs.copyFileSync(path.join(REPO, 'app', 'steam', 'steam_appid.txt'),
  path.join(OUT, 'steam_appid.txt'));

fs.rmSync(TMP, { recursive: true, force: true });

// ─── 6. Report ───────────────────────────────────────────────────────────────

console.log('[6/6] done\n');
const parts = [
  ['exe + Electron runtime', dirSize(OUT).total
    - dirSize(path.join(OUT, 'resources', 'dist')).total
    - dirSize(path.join(OUT, 'resources', 'models')).total],
  ['resources/dist (game)', dirSize(path.join(OUT, 'resources', 'dist')).total],
  ['resources/models (weights)', dirSize(path.join(OUT, 'resources', 'models')).total],
];
console.log('─'.repeat(60));
for (const [label, bytes] of parts) console.log(`${fmt(bytes).padStart(10)}  ${label}`);
const total = dirSize(OUT);
console.log('─'.repeat(60));
console.log(`${fmt(total.total).padStart(10)}  TOTAL  (${total.files} files)`);
console.log(`\nmode=${MODE}  →  ${OUT}`);
console.log(`launch: "${path.join(OUT, `${APP_NAME}.exe`)}"`);
