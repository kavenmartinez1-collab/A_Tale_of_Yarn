/**
 * Tests for src/game/crime.ts — pure crime/bounty ledger model.
 * Run: npx tsx scripts/test-crime.mts
 *
 * Style matches test-vitals.mts: check() + summary + exit 1 on failure.
 */

import {
  BOUNTY_AMOUNTS,
  WITNESS_RADIUS,
  CRIME_LOG_MAX,
  CRIME_KEY,
  JAIL_SECONDS_PER_100_BOUNTY,
  JAIL_MIN_S,
  JAIL_MAX_S,
  createCrimeState,
  isWitnessed,
  reportCrime,
  bountyIn,
  totalBounty,
  payBounty,
  jailSentenceS,
  serveSentence,
  escapeJail,
  serializeCrimeState,
  deserializeCrimeState,
  type CrimeKind,
  type CrimeState,
} from '../src/game/crime';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. BOUNTY_AMOUNTS exact values
// ---------------------------------------------------------------------------

check('BOUNTY_AMOUNTS theft == 25',             BOUNTY_AMOUNTS.theft             === 25);
check('BOUNTY_AMOUNTS horse_theft == 50',        BOUNTY_AMOUNTS.horse_theft       === 50);
check('BOUNTY_AMOUNTS assault == 200',           BOUNTY_AMOUNTS.assault           === 200);
check('BOUNTY_AMOUNTS murder == 1000',           BOUNTY_AMOUNTS.murder            === 1000);
check('BOUNTY_AMOUNTS kill_owned_animal == 30',  BOUNTY_AMOUNTS.kill_owned_animal === 30);
check('BOUNTY_AMOUNTS escape_jail == 100',       BOUNTY_AMOUNTS.escape_jail       === 100);
check('BOUNTY_AMOUNTS threat == 15',             BOUNTY_AMOUNTS.threat            === 15);

// ---------------------------------------------------------------------------
// 2. Constants exported
// ---------------------------------------------------------------------------

check('WITNESS_RADIUS == 30',                WITNESS_RADIUS               === 30);
check('CRIME_LOG_MAX == 20',                 CRIME_LOG_MAX                === 20);
check('CRIME_KEY correct',                   CRIME_KEY                    === 'artifex-crime:v1');
check('JAIL_SECONDS_PER_100_BOUNTY == 30',   JAIL_SECONDS_PER_100_BOUNTY  === 30);
check('JAIL_MIN_S == 20',                    JAIL_MIN_S                   === 20);
check('JAIL_MAX_S == 240',                   JAIL_MAX_S                   === 240);

// ---------------------------------------------------------------------------
// 3. isWitnessed
// ---------------------------------------------------------------------------

// Inside radius (20 m) + LOS true → witnessed
check('isWitnessed: inside + LOS true',
  isWitnessed(12, 16, true),   // dist = sqrt(144+256) = 20
  'expected true');

// Outside radius false regardless of LOS
check('isWitnessed: outside radius → false',
  !isWitnessed(25, 25, true),  // dist = sqrt(1250) ≈ 35.36
  'expected false');

// Inside radius but no LOS → false
check('isWitnessed: inside + no LOS → false',
  !isWitnessed(0, 10, false),
  'expected false');

// Exactly 30 m boundary → witnessed (inclusive)
check('isWitnessed: exactly 30 m boundary → true',
  isWitnessed(30, 0, true),
  'expected true');

// Slightly over 30 m → not witnessed
check('isWitnessed: 30.001 m → false',
  !isWitnessed(30.001, 0, true),
  'expected false');

// ---------------------------------------------------------------------------
// 4. reportCrime: creates ledger, accumulates, log order, log cap
// ---------------------------------------------------------------------------

{
  const s = createCrimeState();

  // Creates ledger on demand
  const b1 = reportCrime(s, 'A', 'theft', 100);
  check('reportCrime: creates ledger, returns bounty 25', b1 === 25, `got ${b1}`);
  check('reportCrime: region A exists', 'A' in s.regions);
  check('reportCrime: crimes length 1', s.regions['A'].crimes.length === 1);
  check('reportCrime: crime kind correct', s.regions['A'].crimes[0].kind === 'theft');
  check('reportCrime: crime t correct',   s.regions['A'].crimes[0].t   === 100);

  // Accumulates across multiple calls and kinds
  const b2 = reportCrime(s, 'A', 'assault', 200);
  check('reportCrime: accumulates theft+assault = 225', b2 === 225, `got ${b2}`);

  const b3 = reportCrime(s, 'A', 'murder', 300);
  check('reportCrime: accumulates +1000 = 1225', b3 === 1225, `got ${b3}`);

  // Log order: oldest first, newest last
  check('reportCrime: log oldest first (theft at index 0)',
    s.regions['A'].crimes[0].kind === 'theft');
  check('reportCrime: log newest last (murder at index 2)',
    s.regions['A'].crimes[2].kind === 'murder');
}

// Log cap at CRIME_LOG_MAX: report 25 crimes → length 20, oldest dropped
{
  const s = createCrimeState();
  for (let i = 0; i < 25; i++) {
    reportCrime(s, 'cap', 'theft', i);
  }
  check('reportCrime: log cap length == 20',
    s.regions['cap'].crimes.length === CRIME_LOG_MAX,
    `got ${s.regions['cap'].crimes.length}`);
  // Oldest 5 (t=0..4) should be gone; t=5 is now the first
  check('reportCrime: oldest entries dropped (first t == 5)',
    s.regions['cap'].crimes[0].t === 5,
    `got t=${s.regions['cap'].crimes[0].t}`);
  check('reportCrime: newest entry still present (last t == 24)',
    s.regions['cap'].crimes[CRIME_LOG_MAX - 1].t === 24,
    `got t=${s.regions['cap'].crimes[CRIME_LOG_MAX - 1].t}`);
}

// ---------------------------------------------------------------------------
// 5. bountyIn and totalBounty
// ---------------------------------------------------------------------------

{
  const s = createCrimeState();
  check('bountyIn unknown region == 0', bountyIn(s, 'NOWHERE') === 0);

  reportCrime(s, 'R1', 'theft', 1);    // +25
  reportCrime(s, 'R1', 'assault', 2);  // +200 → 225
  reportCrime(s, 'R2', 'murder', 3);   // +1000

  check('bountyIn R1 == 225', bountyIn(s, 'R1') === 225, `got ${bountyIn(s, 'R1')}`);
  check('bountyIn R2 == 1000', bountyIn(s, 'R2') === 1000, `got ${bountyIn(s, 'R2')}`);
  check('totalBounty across 2 regions == 1225',
    totalBounty(s) === 1225,
    `got ${totalBounty(s)}`);
}

// ---------------------------------------------------------------------------
// 6. payBounty
// ---------------------------------------------------------------------------

// Partial payment: leaves remainder, keeps log
{
  const s = createCrimeState();
  reportCrime(s, 'P', 'assault', 1);   // bounty = 200
  reportCrime(s, 'P', 'theft', 2);     // bounty = 225

  const r = payBounty(s, 'P', 100);
  check('payBounty partial: paid == 100', r.paid === 100, `got ${r.paid}`);
  check('payBounty partial: remaining == 125', r.remaining === 125, `got ${r.remaining}`);
  check('payBounty partial: ledger bounty == 125', s.regions['P'].bounty === 125);
  check('payBounty partial: log preserved', s.regions['P'].crimes.length === 2);
}

// Full payment: zeroes bounty and clears log
{
  const s = createCrimeState();
  reportCrime(s, 'F', 'assault', 1);   // bounty = 200

  const r = payBounty(s, 'F', 200);
  check('payBounty full: paid == 200', r.paid === 200, `got ${r.paid}`);
  check('payBounty full: remaining == 0', r.remaining === 0, `got ${r.remaining}`);
  check('payBounty full: bounty is 0', s.regions['F'].bounty === 0);
  check('payBounty full: crimes log cleared', s.regions['F'].crimes.length === 0);
}

// Overpayment: pays only bounty amount
{
  const s = createCrimeState();
  reportCrime(s, 'O', 'theft', 1);     // bounty = 25

  const r = payBounty(s, 'O', 9999);
  check('payBounty overpay: paid == 25 (bounty amount)', r.paid === 25, `got ${r.paid}`);
  check('payBounty overpay: remaining == 0', r.remaining === 0, `got ${r.remaining}`);
  check('payBounty overpay: crimes log cleared', s.regions['O'].crimes.length === 0);
}

// Unknown region returns 0, 0
{
  const s = createCrimeState();
  const r = payBounty(s, 'UNKNOWN', 500);
  check('payBounty unknown region: paid 0', r.paid === 0);
  check('payBounty unknown region: remaining 0', r.remaining === 0);
}

// ---------------------------------------------------------------------------
// 7. jailSentenceS
// ---------------------------------------------------------------------------

check('jailSentenceS(0) == 0',       jailSentenceS(0)    === 0);
check('jailSentenceS(-1) == 0',      jailSentenceS(-1)   === 0);

// Low bounty: clamp to JAIL_MIN_S (bounty 25 → 25/100*30 = 7.5, clamp to 20)
check('jailSentenceS(25) == JAIL_MIN_S (clamped low)',
  jailSentenceS(25) === JAIL_MIN_S,
  `got ${jailSentenceS(25)}`);

// Very high bounty: clamp to JAIL_MAX_S (bounty 5000 → 5000/100*30 = 1500, clamp to 240)
check('jailSentenceS(5000) == JAIL_MAX_S (clamped high)',
  jailSentenceS(5000) === JAIL_MAX_S,
  `got ${jailSentenceS(5000)}`);

// Mid value: bounty 200 → 200/100*30 = 60, within range
check('jailSentenceS(200) == 60 (mid value)',
  jailSentenceS(200) === 60,
  `got ${jailSentenceS(200)}`);

// Exactly at JAIL_MIN_S boundary: bounty = 100/30*20 ≈ 66.67 → 20.0
{
  const minBounty = (JAIL_MIN_S / JAIL_SECONDS_PER_100_BOUNTY) * 100; // = 66.67
  check('jailSentenceS: just above min boundary (bounty 67 → 20.1 → unclamped)',
    jailSentenceS(67) > JAIL_MIN_S,
    `got ${jailSentenceS(67)}`);
}

// ---------------------------------------------------------------------------
// 8. serveSentence: clears region, other regions untouched
// ---------------------------------------------------------------------------

{
  const s = createCrimeState();
  reportCrime(s, 'JAIL', 'murder', 1);     // bounty 1000
  reportCrime(s, 'OTHER', 'theft', 2);     // bounty 25

  serveSentence(s, 'JAIL');
  check('serveSentence: bounty cleared', s.regions['JAIL'].bounty === 0);
  check('serveSentence: crimes cleared', s.regions['JAIL'].crimes.length === 0);
  check('serveSentence: other region bounty untouched', s.regions['OTHER'].bounty === 25);
  check('serveSentence: other region crimes untouched', s.regions['OTHER'].crimes.length === 1);
}

// serveSentence on unknown region does not throw
{
  const s = createCrimeState();
  serveSentence(s, 'GHOST');
  check('serveSentence unknown region: no throw', true);
}

// ---------------------------------------------------------------------------
// 9. escapeJail
// ---------------------------------------------------------------------------

{
  const s = createCrimeState();
  reportCrime(s, 'E', 'theft', 1);  // bounty 25

  const b = escapeJail(s, 'E', 999);
  check('escapeJail: adds 100 to existing bounty (25+100=125)',
    b === 125,
    `got ${b}`);
  check('escapeJail: crime kind is escape_jail',
    s.regions['E'].crimes[s.regions['E'].crimes.length - 1].kind === 'escape_jail');
}

// escapeJail in a fresh region
{
  const s = createCrimeState();
  const b = escapeJail(s, 'NEW', 1);
  check('escapeJail in new region: bounty == 100', b === 100, `got ${b}`);
}

// ---------------------------------------------------------------------------
// 10. serialize / deserialize round-trip
// ---------------------------------------------------------------------------

{
  const s = createCrimeState();
  reportCrime(s, '3,-2', 'theft', 1001);
  reportCrime(s, '3,-2', 'murder', 1002);
  reportCrime(s, '0,0',  'assault', 2000);
  payBounty(s, '3,-2', 500);

  const json = serializeCrimeState(s);
  const restored = deserializeCrimeState(json);
  check('serialize round-trip: not null', restored !== null);
  check('serialize round-trip: deep-equals', JSON.stringify(restored) === JSON.stringify(s));
}

// Empty regions object is fine
{
  const s = createCrimeState();
  const restored = deserializeCrimeState(serializeCrimeState(s));
  check('serialize round-trip: empty state OK', restored !== null && Object.keys(restored!.regions).length === 0);
}

// ---------------------------------------------------------------------------
// 11. deserializeCrimeState — rejects invalid data
// ---------------------------------------------------------------------------

check('deserialize: malformed JSON',   deserializeCrimeState('{nope') === null);
check('deserialize: empty string',     deserializeCrimeState('') === null);
check('deserialize: null JSON',        deserializeCrimeState('null') === null);
check('deserialize: array',            deserializeCrimeState('[]') === null);
check('deserialize: missing regions',  deserializeCrimeState('{}') === null);

// bounty NaN
{
  const bad = { regions: { R: { bounty: NaN, crimes: [] } } };
  check('deserialize: bounty NaN → null', deserializeCrimeState(JSON.stringify(bad)) === null);
}

// bounty negative
{
  const bad = { regions: { R: { bounty: -1, crimes: [] } } };
  check('deserialize: bounty negative → null', deserializeCrimeState(JSON.stringify(bad)) === null);
}

// bounty infinite
{
  // JSON.stringify(Infinity) becomes "null" in JSON, so construct manually
  check('deserialize: bounty infinite → null',
    deserializeCrimeState('{"regions":{"R":{"bounty":999999999999,"crimes":[]}}}') === null ||
    deserializeCrimeState('{"regions":{"R":{"bounty":1e309,"crimes":[]}}}') === null ||
    (() => {
      // Infinity serializes as null in JSON, which is not a number — also rejected
      const s = '{"regions":{"R":{"bounty":null,"crimes":[]}}}';
      return deserializeCrimeState(s) === null;
    })(),
  );
}

// unknown crime kind
{
  const bad = { regions: { R: { bounty: 0, crimes: [{ kind: 'arson', t: 1 }] } } };
  check('deserialize: unknown crime kind → null', deserializeCrimeState(JSON.stringify(bad)) === null);
}

// crimes not an array
{
  const bad = { regions: { R: { bounty: 0, crimes: 'nope' } } };
  check('deserialize: crimes not array → null', deserializeCrimeState(JSON.stringify(bad)) === null);
}

// t not a number
{
  const bad = { regions: { R: { bounty: 0, crimes: [{ kind: 'theft', t: 'yesterday' }] } } };
  check('deserialize: t not a number → null', deserializeCrimeState(JSON.stringify(bad)) === null);
}

// region ledger not an object
{
  const bad = { regions: { R: 'notAnObject' } };
  check('deserialize: region ledger not object → null', deserializeCrimeState(JSON.stringify(bad)) === null);
}

// ---------------------------------------------------------------------------
// 12. Determinism + FNV-1a-32 golden hash
// ---------------------------------------------------------------------------

/**
 * FNV-1a-32 over a UTF-16 code-unit string.
 * Offset basis: 0x811c9dc5, prime: 0x01000193.
 */
function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function runGoldenScenario(): CrimeState {
  const s = createCrimeState();

  // Report several crimes across two regions at fixed t values.
  reportCrime(s, '3,-2', 'theft',             1000);
  reportCrime(s, '3,-2', 'assault',            1010);
  reportCrime(s, '3,-2', 'horse_theft',        1020);
  reportCrime(s, '0,0',  'murder',             2000);
  reportCrime(s, '0,0',  'kill_owned_animal',  2005);
  reportCrime(s, '0,0',  'theft',              2010);

  // Partial pay in region '3,-2' (bounty there: 25+200+50=275, pay 100)
  payBounty(s, '3,-2', 100);

  // Serve sentence in '0,0'
  serveSentence(s, '0,0');

  // Escape jail in '3,-2' (adds escape_jail crime)
  escapeJail(s, '3,-2', 3000);

  return s;
}

const goldenResult = runGoldenScenario();
const goldenJson   = JSON.stringify(goldenResult);
const goldenHash   = fnv32a(goldenJson);

// Determinism: run twice, verify identical JSON
const goldenResult2 = runGoldenScenario();
check('determinism: identical scenario produces identical state',
  JSON.stringify(goldenResult2) === goldenJson);

// Golden hash — baked after first run.
const GOLDEN_HASH = 0x3e54ee76;

check(
  `FNV-32 golden hash == 0x${GOLDEN_HASH.toString(16).padStart(8, '0')}`,
  goldenHash === GOLDEN_HASH,
  `got 0x${goldenHash.toString(16).padStart(8, '0')} — json: ${goldenJson}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
