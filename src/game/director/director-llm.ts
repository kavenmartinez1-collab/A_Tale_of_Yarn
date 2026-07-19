/**
 * Director generation loop — prompt → extract → validate → retry with error
 * feedback → FALLBACK_SPEC. Injectable ChatFn seam so unit tests and the e2e
 * mock need no engine import; the orchestrator (director.ts) adapts
 * InferenceSession.chat to DirectorChatFn.
 *
 * Mirrors the established tool-call pattern (src/chat/tools.ts): malformed
 * output is never dropped — every problem is fed back so the model can
 * correct itself, bounded by MAX_RETRIES.
 */

import { validateSpec, FALLBACK_SPEC, type DungeonSpec } from '../dungeon/dungeon-spec';
import {
  buildDirectorMessages, buildRetryMessage, extractSpecJson,
  type ChatMessage, type DungeonBrief,
} from './director-prompt';

/** Narrow seam over InferenceSession.chat — returns the final text only. */
export type DirectorChatFn = (
  messages: ChatMessage[],
) => Promise<{ text: string; stopReason: string }>;

/** Greedy: deterministic per prompt + GPU-argmax fast path. Variety comes
 *  from the seed-derived brief, not sampling temperature. */
export const DIRECTOR_SAMPLING = { temperature: 0, maxNewTokens: 600 } as const;

export const MAX_RETRIES = 2;

export interface SpecGenResult {
  spec: DungeonSpec;
  source: 'llm' | 'fallback';
  attempts: number;
  /** Errors from the last failed attempt (set when source is 'fallback'). */
  errors?: string[];
  /** The chat call itself threw (model/GPU failure, not bad output). Callers
   *  should treat the Director as unavailable rather than persist fallback. */
  chatError?: boolean;
}

export async function generateSpecWithRetries(
  chat: DirectorChatFn, brief: DungeonBrief,
): Promise<SpecGenResult> {
  const messages = buildDirectorMessages(brief);
  let lastErrors: string[] = [];
  let attempts = 0;
  let chatError = false;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    attempts = attempt;
    let text: string;
    let stopReason: string;
    try {
      ({ text, stopReason } = await chat(messages));
    } catch (err) {
      // The model call itself failed (load/GPU/abort) — retrying won't help.
      lastErrors = [`chat failed: ${err}`];
      chatError = true;
      break;
    }

    const errors: string[] = [];
    if (stopReason === 'max_length') {
      errors.push('your reply was cut off before it finished — answer with ONLY the JSON block, no extra prose');
    }
    const extracted = extractSpecJson(text);
    if (!extracted.ok) {
      errors.push(extracted.error);
    } else {
      const result = validateSpec(extracted.value);
      if ('errors' in result) {
        errors.push(...result.errors);
      } else if (errors.length === 0) {
        return { spec: result.spec, source: 'llm', attempts };
      }
    }

    lastErrors = errors;
    if (attempt <= MAX_RETRIES) {
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: buildRetryMessage(errors) });
    }
  }

  return { spec: FALLBACK_SPEC, source: 'fallback', attempts, errors: lastErrors, chatError };
}
