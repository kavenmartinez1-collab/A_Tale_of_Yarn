/**
 * Action gate: a model-emitted NPC action only takes effect when the
 * player's own message supports it.
 *
 * Actions have real gameplay consequences: `hostile` starts a fight, `follow`
 * makes the NPC a companion, `invite_home` opens their door, `charmed` and the
 * proposal verbs move romance. A small model does not hold the rule "only when
 * the traveller actually did X". Measured with scripts/test-npc-live.mts
 * (2026-10-28, LFM3-1.7B): `charmed` after a question about the gods,
 * `follow` after small talk about the weather, `invite_home` in answer to a
 * robbery threat, and `hostile` after a confession that did not threaten the
 * NPC. The game's own principle (npc-trade.ts, docs/AI_MODEL_LICENSING.md) is
 * that a verb fired during civil talk is a worse bug than a miss.
 *
 * So each verb is grounded in the same deterministic detectors stub mode
 * already uses for the player's text (npc-memory.ts). When the detector agrees,
 * the model's verb wins as before (it may pick `afraid` over `hostile`, or
 * `reject_proposal` over `accept_proposal`, which the detectors cannot);
 * when it does not, the verb is dropped and the deterministic threat floor
 * (threatActionFor) still applies. Model-independent: the same gate holds for
 * every NPC model.
 */
import {
  detectThreat, detectFlirt, detectFollowRequest, detectStayRequest, detectHomeRequest,
} from './npc-memory';
import type { NpcActionKind } from './npc-trade';

/** True when `playerSaid` gives the NPC a reason to take action `kind`. */
export function isActionGrounded(kind: NpcActionKind, playerSaid: string): boolean {
  switch (kind) {
    case 'hostile':
    case 'afraid':
    case 'end':
      return detectThreat(playerSaid) !== null;
    case 'charmed':
      return detectFlirt(playerSaid) !== null;
    case 'accept_proposal':
    case 'reject_proposal':
      return detectFlirt(playerSaid) === 'proposal';
    case 'follow':
      return detectFollowRequest(playerSaid);
    case 'stay':
      return detectStayRequest(playerSaid);
    case 'invite_home':
      return detectHomeRequest(playerSaid);
  }
}
