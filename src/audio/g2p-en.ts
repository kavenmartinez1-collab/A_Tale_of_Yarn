/**
 * English G2P for the SHIPPED game — dictionary + letter-to-sound, no eSpeak.
 *
 * WHY THIS EXISTS AT ALL, GIVEN `g2p.ts` ALREADY WORKS.
 * `g2p.ts` phonemizes with eSpeak NG (WASM). eSpeak NG is GPL-3.0-or-later,
 * which is incompatible with the Steamworks SDK, and `scripts/pack-steam.mjs`
 * enforces that with a hard build failure:
 *
 *     const FORBIDDEN_ASSETS = [
 *       { pattern: /espeak/i,
 *         why: 'eSpeak NG is GPL-3.0 and incompatible with the Steamworks SDK' },
 *
 * So the companion app may phonemize with eSpeak (it is not the shipped
 * artifact) and the game may not. This module is the replacement: a baked
 * CMU Pronouncing Dictionary (BSD-2-Clause, redistributable) plus a small
 * letter-to-sound fallback for the words a dictionary cannot have — which in
 * this game means proper nouns: Petra, Rivermeet, Tintreach.
 *
 * IT DELIBERATELY DOES NOT IMPORT `g2p.ts`. That file's very first import is
 * `./espeak/espeak.js`; importing anything from it would pull eSpeak into the
 * game bundle and trip the guard above. `phonemesToIds` is therefore
 * reimplemented here rather than shared — six lines duplicated to keep a GPL
 * binary out of the depot is a trade worth making, and the duplication is
 * gated: `scripts/test-g2p-en.mts` asserts the two agree on the id mapping.
 *
 * HOW CLOSE IS IT TO ESPEAK? Measured against the 195-sentence eSpeak corpus in
 * `scripts/piper_fixture/g2p_corpus.json`: 72.1% of words phoneme-identical,
 * 0.4% out-of-vocabulary. The residue is allophonic — eSpeak's [ʲ] offglides,
 * its inconsistent cot/caught merger (dˈɑːɡ vs dˈɔːɡ), and ə/ɪ colouring in
 * unstressed syllables. The VITS model saw all of those phonemes in training,
 * so the failure mode is a slightly different accent, not garbled speech.
 */

export type PhonemeIdMap = Record<string, number[]>;

// piper.phoneme_ids constants — must match g2p.ts.
const PAD = '_';
const BOS = '^';
const EOS = '$';

/**
 * phonemes_to_ids parity port. Builds:
 *   [BOS, PAD] + flatten([id(p), PAD] for p in phonemes) + [EOS]
 *
 * Byte-identical to `g2p.ts`'s implementation by construction; see the file
 * comment for why it is copied rather than imported.
 */
export function phonemesToIds(phonemes: string[], idMap: PhonemeIdMap): number[] {
  const ids: number[] = [...idMap[BOS], ...idMap[PAD]];
  for (const p of phonemes) {
    const mapped = idMap[p];
    if (!mapped) continue; // unknown phoneme — piper drops it
    ids.push(...mapped, ...idMap[PAD]);
  }
  ids.push(...idMap[EOS]);
  return ids;
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

export type Lexicon = Map<string, string>;

/**
 * Parse the baked lexicon: one `word<TAB>ipa` line per entry.
 *
 * A plain text file rather than JSON because it is ~3 MB and `split('\n')` over
 * a string beats `JSON.parse` of an object with 126k keys — and because a
 * human can diff it when a pronunciation is wrong.
 */
export function parseLexicon(text: string): Lexicon {
  const lex: Lexicon = new Map();
  let i = 0;
  const n = text.length;
  while (i < n) {
    let nl = text.indexOf('\n', i);
    if (nl === -1) nl = n;
    const tab = text.indexOf('\t', i);
    if (tab !== -1 && tab < nl) {
      lex.set(text.slice(i, tab), text.slice(tab + 1, nl));
    }
    i = nl + 1;
  }
  return lex;
}

// ---------------------------------------------------------------------------
// Letter-to-sound fallback (out-of-vocabulary words: names, invented places)
// ---------------------------------------------------------------------------

/**
 * Context-sensitive spelling rules, longest match first.
 *
 * Each rule is [pattern, ipa, leftContext?, rightContext?] where the contexts
 * are regexes anchored against the text before / after the match. This is a
 * deliberately small rule set: it only has to be plausible for names, because
 * every ordinary English word is in the dictionary. `#` means word boundary.
 */
type Rule = [string, string, RegExp?, RegExp?];

const C = '[bcdfghjklmnpqrstvwxyz]';
const V = '[aeiouy]';

const RULES: Rule[] = [
  // Digraphs and clusters first — longest match wins, so order by length.
  ['ough', 'ʌf'], ['augh', 'æf'],
  ['tion', 'ʃən'], ['sion', 'ʒən'], ['cian', 'ʃən'],
  ['eigh', 'eɪ'], ['ight', 'aɪt'],
  ['tch', 'tʃ'], ['dge', 'dʒ'], ['sch', 'sk'],
  ['ch', 'tʃ'], ['sh', 'ʃ'], ['th', 'θ'], ['ph', 'f'], ['wh', 'w'],
  ['ck', 'k'], ['ng', 'ŋ'], ['qu', 'kw'], ['gh', ''],
  ['wr', 'ɹ', undefined, undefined], ['kn', 'n'], ['gn', 'n'],
  // Vowel teams. The w/y-final teams only hold when a consonant or the word
  // end follows: in "Bramblewick" the w opens the next syllable, and reading
  // "ew" as /uː/ there gives "bramb-loo-ick".
  ['ai', 'eɪ'], ['ea', 'iː'], ['ee', 'iː'], ['ie', 'iː'],
  ['oa', 'oʊ'], ['oe', 'oʊ'], ['oo', 'uː'], ['ou', 'aʊ'],
  ['oi', 'ɔɪ'], ['au', 'ɔː'], ['ue', 'uː'], ['ui', 'uː'], ['ei', 'iː'],
  ['ay', 'eɪ', undefined, new RegExp(`^(?!${V})`)],
  ['ey', 'iː', undefined, new RegExp(`^(?!${V})`)],
  ['oy', 'ɔɪ', undefined, new RegExp(`^(?!${V})`)],
  ['ow', 'aʊ', undefined, new RegExp(`^(?!${V})`)],
  ['aw', 'ɔː', undefined, new RegExp(`^(?!${V})`)],
  ['ew', 'uː', undefined, new RegExp(`^(?!${V})`)],
  // R-coloured vowels — only when the r closes the syllable. "Beren" is
  // buh-REN, not "b-ur-n": an r before a vowel belongs to the next syllable.
  ['ar', 'ɑːɹ', undefined, new RegExp(`^(?!${V})`)],
  ['or', 'ɔːɹ', undefined, new RegExp(`^(?!${V})`)],
  ['er', 'ɚ', undefined, new RegExp(`^(?!${V})`)],
  ['ir', 'ɜːɹ', undefined, new RegExp(`^(?!${V})`)],
  ['ur', 'ɜːɹ', undefined, new RegExp(`^(?!${V})`)],
  // Word-final unstressed -a is a schwa in English names: Runa, Jora, Fenna.
  ['a', 'ə', undefined, /^$/],
  // Silent final e — consumed with no output, having lengthened the vowel.
  ['e', '', undefined, /^$/],
  // Single letters.
  ['a', 'æ'], ['b', 'b'], ['c', 'k'], ['d', 'd'], ['e', 'ɛ'], ['f', 'f'],
  ['g', 'ɡ'], ['h', 'h'], ['i', 'ɪ'], ['j', 'dʒ'], ['k', 'k'], ['l', 'l'],
  ['m', 'm'], ['n', 'n'], ['o', 'ɒ'], ['p', 'p'], ['q', 'k'], ['r', 'ɹ'],
  ['s', 's'], ['t', 't'], ['u', 'ʌ'], ['v', 'v'], ['w', 'w'], ['x', 'ks'],
  ['y', 'j'], ['z', 'z'],
];

// Softening: c and g before e/i/y.
const SOFT_C: Rule = ['c', 's', undefined, new RegExp(`^${V}`)];
const SOFT_G: Rule = ['g', 'dʒ', undefined, new RegExp(`^[eiy]`)];

/**
 * Spell an unknown word. Never fails — worst case it sounds odd, which for an
 * invented place name is indistinguishable from correct.
 */
export function lettersToIpa(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  // Collapse doubled consonants: English spells them, it does not say them
  // twice. "Fenna" is /fɛnə/, not /fɛnnə/ — a geminate reads as a stutter.
  w = w.replace(/([bcdfgklmnprstvz])\1/g, '$1');
  // A word-initial y before a consonant is a vowel, not the glide /j/.
  if (/^y[^aeiou]/.test(w)) w = `i${w.slice(1)}`;
  let out = '';
  let i = 0;
  while (i < w.length) {
    const rest = w.slice(i);
    let matched = false;
    // Soft c/g get first refusal.
    for (const [pat, ipa, , right] of [SOFT_C, SOFT_G]) {
      if (rest.startsWith(pat) && (!right || right.test(rest.slice(pat.length)))) {
        if (pat === 'c' && !/^[eiy]/.test(rest.slice(1))) continue;
        out += ipa; i += pat.length; matched = true; break;
      }
    }
    if (matched) continue;
    for (const [pat, ipa, left, right] of RULES) {
      if (!rest.startsWith(pat)) continue;
      if (left && !left.test(w.slice(0, i))) continue;
      if (right && !right.test(rest.slice(pat.length))) continue;
      out += ipa; i += pat.length; matched = true; break;
    }
    if (!matched) i++; // unmapped letter — skip rather than stall
  }
  // Stress the first syllable: names read badly with no stress at all, and
  // initial stress is right for the overwhelming majority of English names.
  const firstVowel = out.search(/[ɑæɐʌɛɜəɚiɪɒɔoʊuʏeaæ]/u);
  if (firstVowel >= 0) out = `${out.slice(0, firstVowel)}ˈ${out.slice(firstVowel)}`;
  return out;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];

/** 0..999999 → words. A trading game says "twelve gold" far more than "12". */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  n = Math.floor(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) {
    return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  }
  if (n < 1000000) {
    return `${numberToWords(Math.floor(n / 1000))} thousand`
      + (n % 1000 ? ` ${numberToWords(n % 1000)}` : '');
  }
  return String(n);
}

// ---------------------------------------------------------------------------
// Text → phonemes
// ---------------------------------------------------------------------------

/** Punctuation that survives into the phoneme stream as a clause terminator. */
const TERMINAL = new Set(['.', ',', '!', '?', ';', ':']);

/**
 * English text → the phoneme codepoint stream piper expects.
 *
 * Mirrors the shape `g2p.ts` produces: individual NFD codepoints, `' '` between
 * words, clause terminators kept, with a trailing space after `, : ;` exactly
 * as eSpeak's post-processing does.
 */
export function textToPhonemes(text: string, lex: Lexicon): string[] {
  const out: string[] = [];
  // Expand digits to words first so the tokenizer sees only letters.
  const expanded = text.replace(/\d+/g, (d) => {
    const n = Number(d);
    return n <= 999999 ? ` ${numberToWords(n)} ` : d.split('').map((c) => ONES[Number(c)]).join(' ');
  });

  const tokens = expanded.match(/[A-Za-z']+|[.,!?;:]/g) ?? [];
  let firstWord = true;
  for (const tok of tokens) {
    if (TERMINAL.has(tok)) {
      out.push(tok);
      if (tok === ',' || tok === ':' || tok === ';') out.push(' ');
      firstWord = true; // next word starts a clause; no separator needed
      continue;
    }
    const key = tok.toLowerCase().replace(/^'+|'+$/g, '');
    if (!key) continue;
    const ipa = lex.get(key) ?? lettersToIpa(key);
    if (!ipa) continue;
    if (!firstWord) out.push(' ');
    for (const cp of ipa.normalize('NFD')) out.push(cp);
    firstWord = false;
  }
  return out;
}

/** Convenience: text → piper input ids in one call. */
export function textToIds(text: string, lex: Lexicon, idMap: PhonemeIdMap): number[] {
  return phonemesToIds(textToPhonemes(text, lex), idMap);
}
