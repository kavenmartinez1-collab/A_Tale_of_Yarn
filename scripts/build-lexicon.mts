/**
 * Bake the shipped English pronunciation lexicon.
 *
 * WHY: the game cannot phonemize with eSpeak NG — it is GPL-3.0 and
 * `pack-steam.mjs` hard-fails on any asset matching /espeak/i. So the
 * dictionary is baked at build time from the CMU Pronouncing Dictionary
 * (BSD-2-Clause, freely redistributable) and `src/audio/g2p-en.ts` reads it at
 * runtime. eSpeak stays a development-only dependency of the companion app and
 * of the parity fixtures; none of its bytes reach the depot.
 *
 * WHAT IT PRODUCES, into models/rhasspy--piper-en-us-joe-medium/:
 *   lexicon-en-us.txt      one `word<TAB>ipa` line per entry (~126k)
 *   LICENSE-cmudict.txt    the BSD-2-Clause notice, shipped alongside
 *
 * The directory name carries `--` deliberately: `pack-steam.mjs` ships only
 * model directories whose name contains it, and `local-server.cjs`'s
 * `resolveRepoDir` maps `<org>--<repo>` back to the repo id the loader asks
 * for. So this lands in the depot with no change to either.
 *
 * Run: npx tsx scripts/build-lexicon.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const OUT_DIR = path.join(REPO_ROOT, 'models', 'rhasspy--piper-en-us-joe-medium');

const CMUDICT_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict';
const CMUDICT_LICENSE_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/LICENSE';

// ── ARPAbet → eSpeak-style en-us IPA ─────────────────────────────────────────
// Stress marks go BEFORE the vowel, which is where eSpeak puts them.
const VOWEL: Record<string, string> = {
  AA: 'ɑː', AE: 'æ', AH: 'ʌ', AO: 'ɔː', AW: 'aʊ', AY: 'aɪ',
  EH: 'ɛ', ER: 'ɜː', EY: 'eɪ', IH: 'ɪ', IY: 'iː',
  OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'uː',
};
const VOWEL_UNSTRESSED: Record<string, string> = {
  AH: 'ə', ER: 'ɚ', IY: 'i', IH: 'ɪ', UW: 'uː', OW: 'oʊ', AO: 'ɔː', AA: 'ɑː',
};
const CONS: Record<string, string> = {
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ',
  K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'ɹ', S: 's', SH: 'ʃ',
  T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};

/**
 * Sentence-level reductions eSpeak applies to unstressed function words and
 * CMUdict does not — CMUdict lists citation forms. These are the most frequent
 * words in any English text, so they dominate perceived naturalness: the
 * citation "tˈuː" for "to" reads as emphatic on every single occurrence.
 * Measured worth: +10.2 points of exact-match parity (55.3% → 65.5%).
 */
const FUNCTION_WORD: Record<string, string> = {
  a: 'ɐ', an: 'ɐn', the: 'ðə', to: 'tə', and: 'ænd', of: 'ɒv', for: 'fɔːɹ',
  than: 'ðɐn', that: 'ðæt', was: 'wʌz', is: 'ɪz', are: 'ɑːɹ', or: 'ɔːɹ',
  as: 'ɐz', at: 'ɐt', but: 'bʌt', from: 'fɹʌm', in: 'ɪn', it: 'ɪt', on: 'ɒn',
  you: 'juː', your: 'jɔːɹ', my: 'maɪ', me: 'miː', he: 'hiː', she: 'ʃiː',
  we: 'wiː', they: 'ðeɪ', them: 'ðɛm', his: 'hɪz', her: 'hɜːɹ', with: 'wɪð',
  not: 'nɒt', have: 'hæv', has: 'hɐz', had: 'hæd', will: 'wɪl', would: 'wʊd',
  can: 'kɐn', could: 'kʊd', do: 'duː', does: 'dʌz', did: 'dɪd', be: 'biː',
  been: 'bɪn', by: 'baɪ', if: 'ɪf', so: 'soʊ', no: 'noʊ', up: 'ʌp',
};

const isVowelTok = (t: string): boolean => {
  const m = /^([A-Z]+)[0-2]$/.exec(t);
  return m !== null && m[1] in VOWEL;
};

export function arpaToIpa(arpa: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < arpa.length; i++) {
    const m = /^([A-Z]+)([0-2])?$/.exec(arpa[i]);
    if (!m) continue;
    const [, base, stress] = m;
    if (base in VOWEL) {
      const mark = stress === '1' ? 'ˈ' : stress === '2' ? 'ˌ' : '';
      let sym = stress === '0' && base in VOWEL_UNSTRESSED
        ? VOWEL_UNSTRESSED[base] : VOWEL[base];
      // eSpeak's unstressed schwa is [ɪ]-coloured in a non-final syllable
      // ("intelligence" → ɪntˈɛlɪdʒəns) and a true schwa only word-finally or
      // before a liquid/nasal ("...əl", "...ɚ"). Worth +3.9 points of parity.
      if (base === 'AH' && stress === '0') {
        const nextBase = /^[A-Z]+/.exec(arpa[i + 1] ?? '')?.[0] ?? '';
        const last = i >= arpa.length - 2;
        if (!last && !['L', 'R', 'M', 'N', 'NG'].includes(nextBase)) sym = 'ɪ';
      }
      out.push(mark + sym);
    } else if (base in CONS) {
      // eSpeak flaps an intervocalic T/D before an unstressed vowel, and after
      // /r/: "computers" → kəmpjˈuːɾɚz, "artificial" → ˌɑːɹɾɪfˈɪʃəl.
      const prev = arpa[i - 1] ?? '';
      const next = arpa[i + 1] ?? '';
      if ((base === 'T' || base === 'D')
        && (isVowelTok(prev) || prev === 'R') && isVowelTok(next) && /0$/.test(next)) {
        out.push('ɾ');
      } else {
        out.push(CONS[base]);
      }
    }
  }
  return out.join('');
}

async function fetchText(url: string, cache: string): Promise<string> {
  if (fs.existsSync(cache) && fs.statSync(cache).size > 0) {
    console.log(`  (cached) ${path.basename(cache)}`);
    return fs.readFileSync(cache, 'utf8');
  }
  console.log(`  fetching ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const text = await resp.text();
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, text);
  return text;
}

async function main(): Promise<void> {
  console.log('build-lexicon: CMU Pronouncing Dictionary → piper IPA\n');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cacheDir = path.join(REPO_ROOT, 'node_modules', '.cache', 'cmudict');

  const dictText = await fetchText(CMUDICT_URL, path.join(cacheDir, 'cmudict.dict'));
  const licenseText = await fetchText(CMUDICT_LICENSE_URL, path.join(cacheDir, 'LICENSE'));

  const lines: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const line of dictText.split('\n')) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const parts = clean.split(/\s+/);
    const raw = parts[0];
    if (/\(\d\)$/.test(raw)) continue; // alternate pronunciation — keep the first
    const word = raw.toLowerCase();
    // The dictionary contains punctuation-only entries and symbols the
    // tokenizer will never hand us; they would only bloat the file.
    if (!/^[a-z][a-z'.-]*$/.test(word)) { skipped++; continue; }
    if (seen.has(word)) continue;
    seen.add(word);
    const ipa = FUNCTION_WORD[word] ?? arpaToIpa(parts.slice(1));
    if (!ipa) { skipped++; continue; }
    lines.push(`${word}\t${ipa}`);
  }

  // Function words that CMUdict spells differently (or not at all) still need
  // to be present with the reduced form.
  for (const [w, ipa] of Object.entries(FUNCTION_WORD)) {
    if (!seen.has(w)) { lines.push(`${w}\t${ipa}`); seen.add(w); }
  }

  lines.sort();
  const outPath = path.join(OUT_DIR, 'lexicon-en-us.txt');
  const body = `${lines.join('\n')}\n`;
  fs.writeFileSync(outPath, body, 'utf8');

  const licPath = path.join(OUT_DIR, 'LICENSE-cmudict.txt');
  fs.writeFileSync(licPath,
    'The pronunciations in lexicon-en-us.txt are derived from the CMU\n'
    + 'Pronouncing Dictionary (http://www.speech.cs.cmu.edu/cgi-bin/cmudict),\n'
    + 'transcribed from ARPAbet to IPA by scripts/build-lexicon.mts.\n\n'
    + `${licenseText}\n`, 'utf8');

  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`\n  entries      ${lines.length}`);
  console.log(`  skipped      ${skipped} (non-alphabetic or empty)`);
  console.log(`  ${path.relative(REPO_ROOT, outPath).replace(/\\/g, '/')}  ${kb(Buffer.byteLength(body))}`);
  console.log(`  ${path.relative(REPO_ROOT, licPath).replace(/\\/g, '/')}  BSD-2-Clause\n`);
}

main().catch((err) => {
  console.error(`\nbuild-lexicon failed: ${err?.stack ?? err}`);
  process.exit(1);
});
