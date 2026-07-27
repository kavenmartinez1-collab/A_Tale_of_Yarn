/**
 * Vendor every model the game needs into `models/`, once, on a machine with
 * internet — so the packaged Steam build can run fully offline.
 *
 *   npx tsx scripts/fetch-weights.mts            # the ship set (~1.11 GB)
 *   npx tsx scripts/fetch-weights.mts --all      # + the ?npcllm=large 4B
 *   npx tsx scripts/fetch-weights.mts --check    # report only, download nothing
 *
 * WHY this exists (docs/PORTING.md §2.7): the weights are fetched from
 * huggingface.co at runtime today. Apache-2.0 explicitly permits redistribution
 * in object form, HuggingFace is a third-party availability dependency we do
 * not control, and Valve's reviewer needs the build to start on a machine of
 * unknown network quality. Bundling is the portable choice.
 *
 * ON-DISK LAYOUT — `models/<org>--<repo>/<file>`, e.g.
 *
 *   models/unsloth--Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf
 *   models/unsloth--Qwen3-1.7B-GGUF/tokenizer.json
 *   models/unsloth--Qwen3-1.7B-GGUF/tokenizer_config.json
 *
 * which `app/steam/local-server.cjs` resolves for repo id `unsloth/Qwen3-1.7B-GGUF`.
 *
 * THE TOKENIZER IS A SECOND, INDEPENDENT NETWORK DEPENDENCY and the easiest
 * thing to miss. `src/model/tokenizer.ts:88` fetches
 * `/api/hf-cache/<repo>/raw/main/tokenizer.json` with a bare hardcoded fetch —
 * not through hf-hub, so `useLocalCache()` does not cover it. If that probe
 * misses, it falls to `AutoTokenizer.from_pretrained`, which goes straight to
 * huggingface.co and would keep the shipped game online-only.
 *
 * `unsloth/Qwen3-1.7B-GGUF` ships no tokenizer files (verified: the repo tree
 * is GGUFs + config.json + imatrix). So the game today resolves the tokenizer
 * through `baseTokenizerRepo()` (tokenizer.ts:63) → `Qwen/Qwen3-8B`. We copy
 * *that* repo's tokenizer into the GGUF repo's directory: it makes the local
 * probe hit, and it reproduces byte-for-byte the tokenizer the verified build
 * already uses, rather than quietly substituting a different one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(REPO_ROOT, 'models');
const HF = 'https://huggingface.co';

interface Want {
  /** Repo id the game asks for — determines the destination directory. */
  repo: string;
  /** File within the destination directory. */
  file: string;
  /** Repo actually holding the bytes (differs for the borrowed tokenizer). */
  from?: string;
  /** Filename in `from`, when it differs. */
  fromFile?: string;
  why: string;
}

/** The shipping set — what a default build actually loads. */
const SHIP: Want[] = [
  {
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    why: 'NPC dialogue (NPC_MODELS.fast + .default) and the Dungeon Director — one download, one resident copy',
  },
  {
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'tokenizer.json',
    from: 'Qwen/Qwen3-8B',
    why: 'tokenizer.ts falls back to Qwen/Qwen3-8B for any qwen3 repo; placing it here makes the local probe hit',
  },
  {
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'tokenizer_config.json',
    from: 'Qwen/Qwen3-8B',
    why: 'chat template + special tokens, same source as the tokenizer',
  },

  // ---- Voice input (push-to-talk STT) --------------------------------------
  //
  // Xenova/whisper-base.en rather than the onnx-community mirror of the same
  // graphs: Xenova declares apache-2.0 on the repo card and onnx-community
  // declares no licence at all. The bytes may well be identical; the paperwork
  // is not, and this build ships to Valve. OpenAI's original whisper weights
  // are MIT (see THIRD_PARTY_NOTICES.md).
  //
  // base.en, not tiny.en. tiny.en is 35 MB smaller, but the entire point of
  // voice input here is that the player says "Tintreach" and "Castle Vhaeron"
  // to an NPC — proper nouns are the workload, and that is precisely where
  // tiny.en falls apart (measured in scripts/test-voice-accuracy.mts).
  //
  // `_quantized` is the int8 suffix transformers.js picks for dtype 'q8',
  // which is already its default on the wasm backend — naming the files here
  // means the vendored set and the requested set cannot drift.
  {
    repo: 'Xenova/whisper-base.en',
    file: 'onnx/encoder_model_quantized.onnx',
    why: 'STT encoder — int8, runs on ORT wasm/SIMD on the CPU, never the GPU queue',
  },
  {
    repo: 'Xenova/whisper-base.en',
    file: 'onnx/decoder_model_merged_quantized.onnx',
    why: 'STT decoder — the *merged* graph is the one transformers.js asks for (models.js:1158)',
  },
  {
    repo: 'Xenova/whisper-base.en',
    file: 'config.json',
    why: 'model architecture — WhisperForConditionalGeneration needs it before any session opens',
  },
  {
    repo: 'Xenova/whisper-base.en',
    file: 'generation_config.json',
    why: 'decoder start token, suppress lists, EOS — greedy decoding is wrong without it',
  },
  {
    repo: 'Xenova/whisper-base.en',
    file: 'preprocessor_config.json',
    why: 'log-mel frontend parameters (80 bins, 16 kHz, 30 s window) for WhisperFeatureExtractor',
  },
  {
    repo: 'Xenova/whisper-base.en',
    file: 'tokenizer.json',
    why: 'detokenisation, and the vocabulary the proper-noun prompt bias is tokenised against',
  },
  {
    repo: 'Xenova/whisper-base.en',
    file: 'tokenizer_config.json',
    why: 'special-token map — <|startofprev|> is how the vocabulary bias is injected',
  },
  // ── Villager voices ───────────────────────────────────────────────────────
  // The destination repo id is NOT the source repo id. `rhasspy/piper-voices`
  // is one repo holding every voice in every language; the game asks for
  // `rhasspy/piper-en-us-joe-medium`, which puts these two files in a
  // directory of their own. That matters twice over: `pack-steam.mjs` ships a
  // model directory only if its name contains `--`, and the depot's
  // local-server maps `<org>--<repo>` straight back to the repo id the worker
  // requests. Vendoring the whole voices repo would drag in ~900 voices.
  {
    repo: 'rhasspy/piper-en-us-joe-medium',
    file: 'en_US-joe-medium.onnx',
    from: 'rhasspy/piper-voices',
    fromFile: 'en/en_US/joe/medium/en_US-joe-medium.onnx',
    why: 'villager voices — piper VITS under ORT wasm on the CPU, never the GPU queue',
  },
  {
    repo: 'rhasspy/piper-en-us-joe-medium',
    file: 'en_US-joe-medium.onnx.json',
    from: 'rhasspy/piper-voices',
    fromFile: 'en/en_US/joe/medium/en_US-joe-medium.onnx.json',
    why: 'phoneme id map + sample rate for the voice above',
  },
];

/**
 * Files that are BUILT here rather than downloaded, checked the same way.
 *
 * The pronunciation lexicon cannot come from HF: it is derived from CMUdict
 * (BSD-2-Clause) by scripts/build-lexicon.mts. It exists because the shipped
 * game cannot phonemize with eSpeak NG — GPL-3.0, and pack-steam.mjs refuses to
 * build a depot containing it.
 */
const BUILT: Array<{ repo: string; file: string; build: string; why: string }> = [
  {
    repo: 'rhasspy/piper-en-us-joe-medium',
    file: 'lexicon-en-us.txt',
    build: 'scripts/build-lexicon.mts',
    why: 'English G2P dictionary (CMUdict, BSD-2-Clause) — the non-GPL eSpeak replacement',
  },
  {
    repo: 'rhasspy/piper-en-us-joe-medium',
    file: 'LICENSE-cmudict.txt',
    build: 'scripts/build-lexicon.mts',
    why: 'the BSD-2-Clause notice CMUdict requires be redistributed with it',
  },
];

/**
 * Only with --all. `?npcllm=large` is a dev comparison path; it is 2.5 GB and
 * the release build cannot select it (see src/game/release-flags.ts).
 *
 * `?npcllm=abliterated` is deliberately absent and must stay absent: the
 * upstream GGUF declares no licence and removing refusal behaviour is the
 * opposite of what Valve's Content Survey asks about (docs/PORTING.md §2.8,
 * docs/AI_MODEL_LICENSING.md). It is never vendored, so it can never ship.
 */
const OPTIONAL: Want[] = [
  {
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    why: 'dev-only ?npcllm=large comparison model',
  },
  {
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    file: 'tokenizer.json',
    from: 'Qwen/Qwen3-8B',
    why: 'same tokenizer family',
  },
  {
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    file: 'tokenizer_config.json',
    from: 'Qwen/Qwen3-8B',
    why: 'same tokenizer family',
  },
];

const MB = 1024 * 1024;
const fmt = (n: number) =>
  n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(2)} GB`
    : n >= MB ? `${(n / MB).toFixed(1)} MB`
      : `${(n / 1024).toFixed(1)} KB`;

/** HEAD the resolve URL to learn the true size (follows the CDN redirect). */
async function remoteSize(repo: string, file: string): Promise<number | null> {
  const resp = await fetch(`${HF}/${repo}/resolve/main/${file}`, { method: 'HEAD' });
  if (!resp.ok) return null;
  const linked = resp.headers.get('x-linked-size');
  const len = resp.headers.get('content-length');
  const n = Number(linked ?? len ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * Download with resume. A 1.1 GB pull over a flaky link should not restart from
 * zero, so bytes land in `<file>.part` and a re-run continues with a Range
 * request from wherever it stopped.
 */
async function download(want: Want, destDir: string): Promise<{ bytes: number; skipped: boolean }> {
  const srcRepo = want.from ?? want.repo;
  const srcFile = want.fromFile ?? want.file;
  const dest = path.join(destDir, want.file);
  const part = `${dest}.part`;

  // `file` may carry a sub-path — the ONNX repos keep their graphs under
  // `onnx/`, and transformers.js requests them at exactly that path. The
  // caller only mkdir'd the repo directory, so make the leaf's parent too.
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const want_ = await remoteSize(srcRepo, srcFile);

  // Small non-LFS files (tokenizer_config.json) are served through HF's
  // resolve-cache redirect, which answers HEAD with neither Content-Length nor
  // X-Linked-Size. There is nothing to resume on a 10 KB file, so take the
  // simple path rather than pretending we know the length.
  if (want_ === null) {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      return { bytes: fs.statSync(dest).size, skipped: true };
    }
    const resp = await fetch(`${HF}/${srcRepo}/resolve/main/${srcFile}`);
    if (!resp.ok) throw new Error(`GET ${srcRepo}/${srcFile} → ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(dest, buf);
    process.stdout.write(`  ${want.file} ← ${srcRepo}  ${fmt(buf.length)}\n`);
    return { bytes: buf.length, skipped: false };
  }

  if (fs.existsSync(dest) && fs.statSync(dest).size === want_) {
    return { bytes: want_, skipped: true };
  }

  let have = 0;
  if (fs.existsSync(part)) {
    have = fs.statSync(part).size;
    if (have > want_) { fs.rmSync(part); have = 0; }
  }

  process.stdout.write(
    `  ${want.file} ← ${srcRepo}  ${fmt(want_)}${have ? ` (resuming at ${fmt(have)})` : ''}\n`);

  while (have < want_) {
    const resp = await fetch(`${HF}/${srcRepo}/resolve/main/${srcFile}`,
      have > 0 ? { headers: { Range: `bytes=${have}-` } } : {});
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`GET ${srcRepo}/${srcFile} → ${resp.status} ${resp.statusText}`);
    }
    if (have > 0 && resp.status !== 206) {
      // Server ignored the Range and is sending the whole file — start over
      // rather than appending a duplicate prefix.
      fs.rmSync(part, { force: true });
      have = 0;
    }
    if (!resp.body) throw new Error('no response body');

    const sink = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    let last = Date.now();
    const src = Readable.fromWeb(resp.body as any);
    src.on('data', (c: Buffer) => {
      have += c.length;
      const now = Date.now();
      if (now - last > 1000) {
        last = now;
        const pct = ((have / want_) * 100).toFixed(1);
        process.stdout.write(`\r    ${pct}%  ${fmt(have)} / ${fmt(want_)}   `);
      }
    });
    try {
      await pipeline(src, sink);
    } catch (err) {
      process.stdout.write(`\n    interrupted (${err}) — retrying from ${fmt(have)}\n`);
      have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      continue;
    }
    have = fs.statSync(part).size;
    process.stdout.write(`\r    100%  ${fmt(have)} / ${fmt(want_)}   \n`);
  }

  if (have !== want_) throw new Error(`size mismatch: got ${have}, want ${want_}`);
  fs.renameSync(part, dest);
  return { bytes: have, skipped: false };
}

function dirFor(repo: string): string {
  return path.join(MODELS_DIR, repo.replace(/\//g, '--'));
}

async function main() {
  const all = process.argv.includes('--all');
  const checkOnly = process.argv.includes('--check');
  const wants = all ? [...SHIP, ...OPTIONAL] : SHIP;

  console.log(`Vendoring ${wants.length} file(s) into ${MODELS_DIR}`);
  console.log(all
    ? '(--all: includes the dev-only ?npcllm=large model)'
    : '(ship set only — pass --all for the dev-only 4B)');
  console.log('');

  let total = 0;
  let downloaded = 0;
  const rows: Array<[string, string, string]> = [];

  for (const want of wants) {
    const destDir = dirFor(want.repo);
    if (!checkOnly) fs.mkdirSync(destDir, { recursive: true });
    const rel = path.relative(REPO_ROOT, path.join(destDir, want.file)).replace(/\\/g, '/');

    if (checkOnly) {
      const p = path.join(destDir, want.file);
      const present = fs.existsSync(p);
      const size = present ? fs.statSync(p).size : 0;
      total += size;
      rows.push([rel, present ? fmt(size) : 'MISSING', want.why]);
      continue;
    }

    console.log(`${want.repo}`);
    const { bytes, skipped } = await download(want, destDir);
    total += bytes;
    if (!skipped) downloaded += bytes;
    rows.push([rel, `${fmt(bytes)}${skipped ? ' (present)' : ''}`, want.why]);
  }

  // Built artifacts — generate any that are missing, then report them like the
  // downloads so `--check` shows one complete picture of what the depot needs.
  for (const b of BUILT) {
    const destDir = dirFor(b.repo);
    const p = path.join(destDir, b.file);
    const rel = path.relative(REPO_ROOT, p).replace(/\\/g, '/');
    if (!fs.existsSync(p) && !checkOnly) {
      console.log(`${b.repo} — building ${b.file}`);
      const { execFileSync } = await import('node:child_process');
      execFileSync('npx', ['tsx', b.build], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    }
    const present = fs.existsSync(p);
    const size = present ? fs.statSync(p).size : 0;
    total += size;
    rows.push([rel, present ? fmt(size) : 'MISSING', b.why]);
  }

  console.log('');
  console.log('─'.repeat(96));
  for (const [file, size, why] of rows) {
    console.log(`${size.padStart(12)}  ${file}`);
    console.log(`${' '.repeat(14)}${why}`);
  }
  console.log('─'.repeat(96));
  console.log(`${fmt(total).padStart(12)}  TOTAL on disk`);
  if (!checkOnly) console.log(`${fmt(downloaded).padStart(12)}  downloaded this run`);
  console.log('');
  console.log('Depot estimate: these bytes + ~24 MB dist + ~350 MB Electron runtime.');
  console.log('Weights are Apache-2.0 (unsloth/Qwen3-1.7B-GGUF). See THIRD_PARTY_NOTICES.md.');
}

main().catch((err) => {
  console.error(`\nfetch-weights failed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
