/**
 * content-safety.ts — the content guardrail for AI-generated NPC dialogue.
 *
 * ## What this is for
 *
 * Steam's Content Survey requires developers shipping "Live-Generated" AI
 * content to state what guardrails prevent it generating ILLEGAL content, and
 * prerelease review evaluates AI output like any other content. This module is
 * that answer, and it is deliberately written to be readable by a reviewer:
 * the rules are data, not a model, so anyone can audit exactly what is blocked.
 *
 * ## What this is NOT for
 *
 * This is not a general "safety" or politeness filter, and it must never become
 * one. The game's NPCs are meant to talk about dark, crude, violent, grieving,
 * blasphemous and sexual subjects like adults in a harsh medieval world — that
 * is the point of the game, it is a deliberate design decision, and Steam
 * publishes plenty of mature content. Over-blocking would destroy the thing the
 * game is built around while doing nothing for legality.
 *
 * So the scope here is narrow on purpose: content that is outright illegal in
 * the markets the game would ship to, effectively regardless of jurisdiction.
 * In a medieval-fantasy conversation engine that reduces in practice to one
 * category — sexual content involving minors. Everything else an adult NPC
 * might say is mature content, not illegal content, and is left alone.
 *
 * ## Why a rule list rather than a classifier
 *
 * The generation model runs locally on the player's GPU, and a second model
 * for classification would double the memory budget and add latency to every
 * line — against a hard project rule that the LLM must never block gameplay.
 * A deterministic matcher costs microseconds, cannot itself be prompt-injected,
 * and can be read and verified by a human. It is checked on BOTH the player's
 * input and the model's output, so neither a crafted prompt nor a bad
 * generation reaches the screen.
 *
 * ## Honest limits
 *
 * Term matching is not semantic and can be evaded by someone determined to
 * evade it. It is one layer of four, and it is not the strongest one — the
 * model is. The shipped default is now stock `Qwen3-1.7B` (Apache-2.0), not
 * the abliterated build that shipped before 2026-07-25, so a layer of trained
 * refusal sits underneath this rule list rather than having been surgically
 * removed from the weights. `?npcllm=abliterated` still reaches an abliterated
 * model for comparison; under that flag this module is genuinely the only
 * thing left. See docs/AI_GUARDRAILS.md and docs/AI_MODEL_LICENSING.md.
 *
 * Pure module: no DOM, no GPU, no I/O. Node-testable.
 */

export type SafetyCategory = 'minor_sexual';

export interface SafetyVerdict {
  blocked: boolean;
  category: SafetyCategory | null;
  /**
   * Which rule fired, for logging and audit. NEVER shown to the player and
   * never fed back to the model — echoing it would just tell a probing user
   * exactly what to route around.
   */
  detail: string | null;
}

const ALLOW: SafetyVerdict = { blocked: false, category: null, detail: null };

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Character substitutions that defeat naive matching. Deliberately limited to
 * unambiguous visual homoglyphs — aggressive normalisation creates false
 * positives on ordinary words, which in this context means silently breaking
 * a conversation the player is entitled to have.
 */
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
  '@': 'a', '$': 's', '!': 'i', '|': 'i',
};

/**
 * Lowercase, strip accents, fold homoglyphs, collapse runs of a repeated
 * letter, and reduce to bare words.
 *
 * Digits are folded to letters for matching, so any age check must run on the
 * ORIGINAL text — see `hasMinorAge`.
 */
export function normalize(text: string): string[] {
  const folded = text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Digits and symbol homoglyphs fold when they touch a letter, so "ch1ld"
    // and "p0rn" resolve but a bare "14" stays a number.
    .replace(/(?<=[a-z])[013457@$]|[013457@$](?=[a-z])/g, (c) => LEET[c] ?? c)
    // "!" and "|" fold only BETWEEN letters. They are ordinary punctuation:
    // folding them at a word edge turns "go!" into "goi", which is how the
    // first version of this mangled every exclamation in the game.
    .replace(/(?<=[a-z])[!|](?=[a-z])/g, 'i')
    // "chiiiild" -> "child". Three or more collapse to ONE, not two: the
    // correct spelling of most of these words has a single letter there, so
    // collapsing to two ("chiild") still misses. English doubles are exactly
    // two, so "small" and "wee" are untouched — which matters, because
    // collapsing every run to one would turn the age qualifier "wee" into
    // "we" and make the commonest word in the language an age marker.
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return folded === '' ? [] : folded.split(' ');
}

// ---------------------------------------------------------------------------
// Term sets
// ---------------------------------------------------------------------------

/**
 * Terms that refer to a minor unambiguously. Co-occurrence with an explicit
 * sexual term is enough to block.
 */
const MINOR_STRONG = new Set([
  'child', 'children', 'childs', 'kid', 'kids', 'minor', 'minors',
  'underage', 'undearge', 'toddler', 'toddlers', 'infant', 'infants',
  'preteen', 'preteens', 'prepubescent', 'prepubertal', 'pubescent',
  'juvenile', 'adolescent', 'adolescents', 'schoolgirl', 'schoolgirls',
  'schoolboy', 'schoolboys', 'teen', 'teens', 'teenager', 'teenagers',
  'teenage', 'loli', 'lolis', 'lolicon', 'shota', 'shotacon',
]);

/**
 * Words that OFTEN refer to a minor but frequently do not. "Girl", "boy",
 * "lad" and "lass" are everyday medieval-fantasy address for adults — a
 * tavern keeper calling a grown woman "girl" is completely ordinary speech.
 * Blocking on these alone would misfire constantly on legitimate adult
 * conversation, so they only count when an age qualifier is attached.
 */
const MINOR_WEAK = new Set([
  'girl', 'girls', 'boy', 'boys', 'lad', 'lads', 'lass', 'lasses',
  'youngster', 'youngsters', 'youth', 'youths',
]);

/** Qualifiers that turn a weak term into a minor reference. */
const AGE_QUALIFIER = new Set([
  'little', 'small', 'young', 'younger', 'youngest', 'wee', 'tiny',
  'baby', 'infant', 'child', 'kid', 'underage', 'immature', 'pre',
]);

/**
 * Explicit sexual terms. Kept to unambiguous anatomical and act words:
 * romantic vocabulary ("lover", "kiss", "bed", "wed", "courting") is
 * deliberately EXCLUDED because it is normal adult conversation and the game
 * supports romance and marriage as mechanics.
 */
const SEXUAL = new Set([
  'sex', 'sexual', 'sexually', 'sexualize', 'sexualise', 'sexy',
  'rape', 'raped', 'raping', 'rapist', 'molest', 'molested', 'molesting',
  'molestation', 'incest', 'incestuous', 'pedophile', 'pedophilia',
  'paedophile', 'paedophilia', 'pedo', 'grooming', 'groomed',
  'porn', 'porno', 'pornography', 'pornographic', 'erotic', 'erotica',
  'nude', 'nudes', 'naked', 'genitals', 'genitalia', 'penis', 'vagina',
  'breasts', 'nipples', 'orgasm', 'masturbate', 'masturbating',
  'masturbation', 'intercourse', 'fondle', 'fondling', 'arousal',
  'aroused', 'horny', 'fuck', 'fucked', 'fucking', 'cum', 'creampie',
  'blowjob', 'handjob', 'anal', 'penetration', 'penetrate', 'virginity',
]);

/**
 * Phrases blocked on sight, independent of proximity. These have no innocent
 * reading, so requiring a co-occurrence window would only add a way around.
 */
const HARD_PHRASES: readonly string[] = [
  'child porn', 'child pornography', 'child sex', 'child sexual',
  'child abuse material', 'csam', 'kiddie porn', 'kiddy porn',
  'underage sex', 'underage porn', 'sex with a child',
  'sex with children', 'sex with a kid', 'sex with a minor',
  'sexualize a child', 'sexualise a child', 'lolicon', 'shotacon',
];

/** Words within this distance count as co-occurring. */
const WINDOW = 8;

// ---------------------------------------------------------------------------
// Age detection
// ---------------------------------------------------------------------------

/**
 * True when the ORIGINAL text states an age under 18.
 *
 * Runs on the raw string rather than the normalised words because
 * normalisation folds digits into letters. Requires an explicit age unit, so
 * ordinary quantities ("14 copper", "12 arrows") are not ages.
 */
export function hasMinorAge(text: string): boolean {
  const re = /\b([0-9]{1,2})\s*(?:-|\s)?\s*(?:year|yr|years|winters|summers)\b/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (n >= 1 && n < 18) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

/** Index positions of every word in `set`. */
function positionsOf(words: string[], set: Set<string>): number[] {
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) if (set.has(words[i])) out.push(i);
  return out;
}

/** True when a weak minor term at `i` carries an age qualifier beside it. */
function isQualified(words: string[], i: number): boolean {
  for (let k = Math.max(0, i - 2); k < i; k++) {
    if (AGE_QUALIFIER.has(words[k])) return true;
  }
  return false;
}

/**
 * Screen any text — player input or model output — for the prohibited
 * category. Fast enough to run on every message and every generated reply.
 */
export function screenText(text: string): SafetyVerdict {
  if (text.trim() === '') return ALLOW;

  const words = normalize(text);
  if (words.length === 0) return ALLOW;
  const joined = words.join(' ');

  for (const phrase of HARD_PHRASES) {
    if (joined.includes(phrase)) {
      return { blocked: true, category: 'minor_sexual', detail: `phrase:${phrase}` };
    }
  }

  const sexual = positionsOf(words, SEXUAL);
  if (sexual.length === 0) return ALLOW;

  // A stated age under 18 anywhere in a sexual message is enough on its own —
  // the proximity window would let "she's 14" and the explicit part sit in
  // separate sentences.
  if (hasMinorAge(text)) {
    return { blocked: true, category: 'minor_sexual', detail: 'stated-age-under-18' };
  }

  const minors: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (MINOR_STRONG.has(words[i])) minors.push(i);
    else if (MINOR_WEAK.has(words[i]) && isQualified(words, i)) minors.push(i);
  }
  if (minors.length === 0) return ALLOW;

  for (const m of minors) {
    for (const s of sexual) {
      if (Math.abs(m - s) <= WINDOW) {
        return {
          blocked: true,
          category: 'minor_sexual',
          detail: `proximity:${words[m]}~${words[s]}`,
        };
      }
    }
  }
  return ALLOW;
}

/** Screen the player's message before it is sent to the model. */
export function screenPlayerInput(text: string): SafetyVerdict {
  return screenText(text);
}

/**
 * Screen a generated reply before it is shown.
 *
 * Separate entry point from `screenPlayerInput` so the two can diverge later
 * without hunting call sites — and because they fail differently: a blocked
 * input never reaches the model at all, whereas a blocked output has already
 * been generated and must be discarded and replaced.
 */
export function screenNpcReply(text: string): SafetyVerdict {
  return screenText(text);
}

/**
 * In-character deflections used when something is blocked.
 *
 * Deliberately in-fiction and non-preachy. A modern content-policy notice
 * would break immersion, and telling the player exactly which rule fired just
 * teaches them how to word it differently. The NPC simply will not go there.
 */
export const SAFETY_DEFLECTIONS: readonly string[] = [
  '*goes very still* No. Not that. Ask me something else.',
  '*face hardens* You\'ll not speak of that here. Find another subject.',
  '*turns away sharply* I\'ve nothing to say to that. Nothing at all.',
  '*sets down what they were holding* No. We\'re done with that talk.',
];

/** Pick a deflection deterministically, so tests and replays are stable. */
export function safetyDeflection(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return SAFETY_DEFLECTIONS[(h >>> 0) % SAFETY_DEFLECTIONS.length];
}
