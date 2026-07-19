/**
 * Deterministic unit tests for the Director core (prompt builder, extraction,
 * retry loop, spec store). Pure CPU — no GPU, no DOM, no server. Run:
 *   npx tsx scripts/test-director.mts
 *
 * The golden prompt hash is the prompt-drift tripwire: any change to the
 * prompt text fails this and must be deliberate (bump PROMPT_VERSION in
 * director-prompt.ts — which also invalidates persisted specs — and update
 * the constant in the same commit).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildBrief, buildDirectorMessages, buildRetryMessage, extractSpecJson,
  PROMPT_VERSION,
} from '../src/game/director/director-prompt';
import type { ChatMessage } from '../src/game/director/director-prompt';
import {
  generateSpecWithRetries, DIRECTOR_SAMPLING, MAX_RETRIES,
} from '../src/game/director/director-llm';
import {
  createSpecStore, storeKey, STORE_PREFIX,
} from '../src/game/director/director-store';
import type { StoredSpec } from '../src/game/director/director-store';
import { validateSpec, FALLBACK_SPEC } from '../src/game/dungeon/dungeon-spec';
import type { DungeonSpec } from '../src/game/dungeon/dungeon-spec';
import { DUNGEON_FIXTURES } from '../src/game/dungeon/dungeon-fixtures';

/** Update ONLY on deliberate prompt changes (see header). */
const GOLDEN_PROMPT_HASH: number | null = 0xa82ce094;

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'director-golden.json');
const golden = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  goldenPromptBrief: { seed: number; dcx: number; dcz: number; entranceY: number };
  validSpec: DungeonSpec;
  noEntranceSpec: unknown;
  transcripts: Record<string, { text: string; stopReason: string }[]>;
};

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

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Resolve <SPEC>/<NO_ENTRANCE_SPEC> placeholders in a fixture transcript. */
function transcript(name: string): { text: string; stopReason: string }[] {
  return golden.transcripts[name].map((r) => ({
    stopReason: r.stopReason,
    text: r.text
      .replace('<SPEC>', JSON.stringify(golden.validSpec))
      .replace('<NO_ENTRANCE_SPEC>', JSON.stringify(golden.noEntranceSpec)),
  }));
}

/** ChatFn that replays a scripted transcript and records every call. */
function scriptedChat(replies: { text: string; stopReason: string }[]) {
  let i = 0;
  const calls: ChatMessage[][] = [];
  const fn = async (messages: ChatMessage[]) => {
    calls.push(messages.map((m) => ({ ...m })));
    if (i >= replies.length) throw new Error('transcript exhausted');
    return replies[i++];
  };
  return { fn, calls };
}

function fakeStorage(seedEntries?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seedEntries ?? {}));
  const s: Storage = {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
  return { storage: s, map: m };
}

// ── Brief determinism + spread ───────────────────────────────────────────

{
  const a = buildBrief(0x1234, 7, -3, 15.5);
  const b = buildBrief(0x1234, 7, -3, 15.5);
  check('brief: deterministic', JSON.stringify(a) === JSON.stringify(b));
  check('brief: flavor words distinct', a.flavorWords[0] !== a.flavorWords[1]);
  check('brief: two flavor words', a.flavorWords.length === 2);

  const themes = new Set<string>();
  const flavors = new Set<string>();
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      const br = buildBrief(0x1234, x, z, 10);
      themes.add(br.themeHint);
      flavors.add(br.flavorWords[0]);
    }
  }
  check('brief: theme spread over cells', themes.size === 3, `got ${themes.size}`);
  check('brief: flavor spread over cells', flavors.size >= 6, `got ${flavors.size}`);

  const c = buildBrief(0x9999, 7, -3, 15.5);
  check('brief: seed changes output',
    JSON.stringify(a) !== JSON.stringify(c));
}

// ── Prompt build + golden hash ───────────────────────────────────────────

{
  const { seed, dcx, dcz, entranceY } = golden.goldenPromptBrief;
  const msgs = buildDirectorMessages(buildBrief(seed, dcx, dcz, entranceY));
  check('prompt: system+user', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
  check('prompt: teaches items', msgs[0].content.includes('gold_small'));
  check('prompt: user names theme hint', /Theme: (crypt|cave|ruin)/.test(msgs[1].content));
  check('prompt: version is 3', PROMPT_VERSION === 3);

  // Few-shots embedded in the system prompt must themselves validate.
  for (const i of [0, 1]) {
    check(`prompt: few-shot fixture ${i} validates`, 'spec' in validateSpec(DUNGEON_FIXTURES[i]));
    check(`prompt: few-shot fixture ${i} embedded`,
      msgs[0].content.includes(JSON.stringify(DUNGEON_FIXTURES[i])));
  }

  const hash = fnv1a(new TextEncoder().encode(JSON.stringify(msgs)));
  if (GOLDEN_PROMPT_HASH === null) {
    console.log(`golden prompt hash: 0x${hash.toString(16)} (set GOLDEN_PROMPT_HASH)`);
  } else {
    check('prompt: golden hash', hash === GOLDEN_PROMPT_HASH,
      `got 0x${hash.toString(16)}, want 0x${GOLDEN_PROMPT_HASH.toString(16)}`);
  }

  const retry = buildRetryMessage(['bad thing one', 'bad thing two']);
  check('retry msg: lists errors', retry.includes('bad thing one') && retry.includes('bad thing two'));
  check('retry msg: demands json fence', retry.includes('```json'));
}

// ── extractSpecJson ──────────────────────────────────────────────────────

{
  const spec = JSON.stringify(golden.validSpec);
  const cases: [string, string, boolean][] = [
    ['fenced json', '```json\n' + spec + '\n```', true],
    ['bare fence', '```\n' + spec + '\n```', true],
    ['prose then fence', 'Here is your dungeon:\n```json\n' + spec + '\n```', true],
    ['think prefix', '<think>\nhmm braces { } here\n</think>\n```json\n' + spec + '\n```', true],
    ['two fences takes last', '```json\n{"draft": true}\n```\nActually:\n```json\n' + spec + '\n```', true],
    ['trailing prose after fence', '```json\n' + spec + '\n```\nEnjoy!', true],
    ['no fence bare json', 'Sure thing. ' + spec + ' Hope you like it.', true],
    ['no fence no json', 'I cannot help with that.', false],
    ['truncated fence', '```json\n' + spec.slice(0, spec.length / 2), false],
    ['fence with broken json', '```json\n{"version": 1,,}\n```', false],
  ];
  for (const [name, text, wantOk] of cases) {
    const r = extractSpecJson(text);
    check(`extract: ${name}`, r.ok === wantOk, r.ok ? '' : r.error);
    if (r.ok && wantOk && name !== 'two fences takes last') {
      check(`extract: ${name} validates`, 'spec' in validateSpec(r.value));
    }
    if (name === 'two fences takes last' && r.ok) {
      check('extract: last fence content wins',
        JSON.stringify(r.value) === spec);
    }
  }
}

// ── generateSpecWithRetries ──────────────────────────────────────────────

const brief = buildBrief(0x1234, 2, 2, 10);

{
  const { fn, calls } = scriptedChat(transcript('validFirst'));
  const r = await generateSpecWithRetries(fn, brief);
  check('gen valid-first: source llm', r.source === 'llm');
  check('gen valid-first: 1 attempt', r.attempts === 1 && calls.length === 1);
  check('gen valid-first: spec name', r.spec.name === golden.validSpec.name);
}

{
  const { fn, calls } = scriptedChat(transcript('badJsonThenFixed'));
  const r = await generateSpecWithRetries(fn, brief);
  check('gen bad-json: recovers', r.source === 'llm' && r.attempts === 2);
  const retryMsgs = calls[1];
  check('gen bad-json: echoes assistant', retryMsgs.some((m) => m.role === 'assistant'));
  check('gen bad-json: feeds back parse error',
    retryMsgs[retryMsgs.length - 1].content.includes('not valid JSON'));
}

{
  const { fn, calls } = scriptedChat(transcript('schemaErrorsThenFixed'));
  const r = await generateSpecWithRetries(fn, brief);
  check('gen schema-errors: recovers', r.source === 'llm' && r.attempts === 2);
  check('gen schema-errors: feeds back validator error',
    calls[1][calls[1].length - 1].content.includes('entrance'));
}

{
  const { fn, calls } = scriptedChat(transcript('tripleFail'));
  const r = await generateSpecWithRetries(fn, brief);
  check('gen triple-fail: fallback', r.source === 'fallback');
  check('gen triple-fail: 3 attempts', r.attempts === MAX_RETRIES + 1 && calls.length === 3);
  check('gen triple-fail: FALLBACK_SPEC', r.spec === FALLBACK_SPEC);
  check('gen triple-fail: errors reported', (r.errors?.length ?? 0) > 0);
}

{
  const { fn, calls } = scriptedChat(transcript('maxLengthThenFixed'));
  const r = await generateSpecWithRetries(fn, brief);
  check('gen max-length: is a failure then recovers', r.source === 'llm' && r.attempts === 2);
  check('gen max-length: feeds back cutoff error',
    calls[1][calls[1].length - 1].content.includes('cut off'));
}

{
  const fn = async () => { throw new Error('device lost'); };
  const r = await generateSpecWithRetries(fn, brief);
  check('gen chat-throws: fallback without retries', r.source === 'fallback' && r.attempts === 1);
  check('gen chat-throws: error captured', (r.errors?.[0] ?? '').includes('device lost'));
  check('gen chat-throws: flagged as chat error', r.chatError === true);
}

{
  const { fn } = scriptedChat(transcript('tripleFail'));
  const r = await generateSpecWithRetries(fn, brief);
  check('gen bad-output fallback: NOT a chat error', r.chatError === false);
}

check('sampling: greedy contract', DIRECTOR_SAMPLING.temperature === 0);
check('sampling: bounded output', DIRECTOR_SAMPLING.maxNewTokens <= 1024);

// ── Spec store ───────────────────────────────────────────────────────────

{
  const key = storeKey(0x1234, 5, -7);
  check('store: key prefix', key.startsWith(STORE_PREFIX));
  check('store: key has cell + seed', key.includes(`${0x1234}:5,-7`));
  check('store: key versioned', key.includes(`v1.${PROMPT_VERSION}:`));

  const { storage, map } = fakeStorage();
  const store = createSpecStore(storage);
  check('store: miss is null', store.load(1, 0, 0) === null);

  const entry: StoredSpec = { spec: golden.validSpec, source: 'llm', savedAt: 123 };
  store.save(0x1234, 5, -7, entry);
  const back = store.load(0x1234, 5, -7);
  check('store: round-trip', back !== null && back.spec.name === golden.validSpec.name
    && back.source === 'llm' && back.savedAt === 123);
  check('store: wrong cell still null', store.load(0x1234, 5, -6) === null);

  map.set(storeKey(2, 0, 0), 'not json at all');
  check('store: corrupt json -> null', store.load(2, 0, 0) === null);
  map.set(storeKey(3, 0, 0),
    JSON.stringify({ spec: golden.noEntranceSpec, source: 'llm', savedAt: 1 }));
  check('store: invalid spec -> null', store.load(3, 0, 0) === null);
  map.set(storeKey(4, 0, 0),
    JSON.stringify({ spec: golden.validSpec, source: 'weird', savedAt: 1 }));
  check('store: bad source -> null', store.load(4, 0, 0) === null);

  const throwing: Storage = {
    ...storage,
    setItem: () => { throw new Error('QuotaExceededError'); },
    getItem: () => { throw new Error('SecurityError'); },
  };
  const badStore = createSpecStore(throwing);
  let threw = false;
  try {
    badStore.save(1, 0, 0, entry);
    check('store: quota load degrades to null', badStore.load(1, 0, 0) === null);
  } catch {
    threw = true;
  }
  check('store: storage throws are swallowed', !threw);
}

// ── Result ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 || (GOLDEN_PROMPT_HASH as number | null) === null) {
  if (GOLDEN_PROMPT_HASH === null) console.error('GOLDEN_PROMPT_HASH not set yet');
  process.exit(1);
}
