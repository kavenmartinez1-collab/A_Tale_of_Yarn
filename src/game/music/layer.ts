/**
 * THE LAYER SEAM.
 *
 * A layer is "something that fills one bar with audio at a given time". Today
 * every layer is SynthLayer, which realises note events with the additive
 * voices in voices.ts. Tomorrow a layer may instead be a decoded loop rendered
 * out of Ableton from the MIDI stems that scripts/export-music-midi.mts
 * produces.
 *
 * Both live behind `LayerSource` below. The scheduler never learns which it
 * is holding: it hands over (notes, barTime, plan) and the layer decides. The
 * bus, the fades, the bar quantisation and the state machine are all
 * indifferent to the choice, so swapping one layer to audio is a local change.
 *
 * NOT BUILT (deliberately, per brief): the buffer loader. What it would need
 * is written down here so the seam is honest rather than aspirational —
 *
 *   class BufferLayer implements LayerSource {
 *     // loops: Map<`${region}-${intensity}`, AudioBuffer>, decoded up front
 *     scheduleBar(_notes, barTime, plan) {
 *       // pick loop by plan.region/plan.intensity; start a BufferSource at
 *       // barTime with playbackRate = plan.bpm / RENDERED_BPM; offset by
 *       // (plan.bar % loopBars) * plan.secPerBar so the loop stays phase-
 *       // locked to the engine's bar grid rather than to its own start.
 *     }
 *   }
 *
 * The two constraints a rendered loop must satisfy to drop in cleanly:
 *   1. Rendered at the region's base BPM from REGION_CONFIG, in D, in the
 *      region's mode — the MIDI export README states these per file.
 *   2. A whole number of bars long (4 or 8), so `plan.bar % loopBars` is a
 *      valid phase. Tails may overhang; they are not cut.
 */

import type { BarNotes, NoteEvent } from './arranger';
import { DRUM_PATCHES, PATCHES, noteFreq, noteHold, spawnDrum, spawnPitched } from './voices';
import type { BarPlan, LayerId } from './state';

export interface LayerSource {
  readonly id: LayerId;
  /**
   * Realise one bar. `barTime` is the absolute AudioContext time of the
   * downbeat. Implementations must never stop or disconnect anything that is
   * already sounding.
   */
  scheduleBar(notes: readonly NoteEvent[], barTime: number, plan: BarPlan): void;
  /** Absolute time at which the last scheduled voice goes silent. */
  readonly tailTime: number;
}

/**
 * Priority for the voice budget. When a bar would exceed MAX_VOICES the
 * lowest-priority onset is dropped — never an already-scheduled note, because
 * cancelling a sounding voice is exactly the mid-envelope cut we forbid.
 *
 * Rhythm and bass survive first (they carry the pulse), the arpeggiated pluck
 * is the designated casualty — it is the thickest and least load-bearing
 * texture, and it sits lowest in the mix at high intensity anyway.
 */
export const LAYER_PRIORITY: Record<LayerId, number> = {
  bass: 5,
  perc: 4,
  melody: 3,
  pad: 2,
  tension: 1,
  pluck: 0,
};

export const MAX_VOICES = 8;

/**
 * RESERVED SLOTS. Priority alone was not enough: it only breaks ties between
 * onsets at the SAME instant, so under a plain global cap a burst of early
 * bass and percussion could starve a melody note that began two 16ths later —
 * and a dropped melody note is a hole in the motif, which is the one thing
 * this engine exists to deliver.
 *
 * Each layer may always occupy its reservation. Anything beyond that needs a
 * globally free slot. The reservations sum to exactly MAX_VOICES, so every
 * layer's floor is guaranteed and the arpeggiated pluck (reservation 0) is
 * the only texture that ever competes — which is what we want, since a
 * dropped arpeggio note reads as rhythmic variation, not as damage.
 */
/**
 * Sized from the arrangement's ACTUAL polyphony, not from guesswork:
 *   pad      2 — the only genuinely two-voice layer (root + colour tone)
 *   bass     1 — the driving-eighths figure is written end-to-end, never overlapping
 *   melody   1 — the motif is strictly monophonic, by construction
 *   perc     2 — the frame drum's decay overlaps the following rim hit at boss
 *   tension  1 — one drone, handed over at the bar line
 *   pluck    1 — one arpeggio note at a time
 * Sum = MAX_VOICES, so every audible layer's floor is guaranteed and the one
 * spare slot goes to whoever asks first.
 */
export const LAYER_RESERVED: Record<LayerId, number> = {
  pad: 2,
  bass: 1,
  melody: 1,
  perc: 2,
  tension: 1,
  pluck: 1,
};

export class SynthLayer implements LayerSource {
  tailTime = 0;
  private _nodeCount = 0;

  constructor(
    readonly id: LayerId,
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly noise: AudioBuffer,
  ) {}

  get nodeCount(): number {
    return this._nodeCount;
  }

  scheduleBar(notes: readonly NoteEvent[], barTime: number, plan: BarPlan): void {
    const secPerStep = plan.secPerBar / 16;
    for (const n of notes) {
      const when = barTime + n.step * secPerStep;
      let v;
      if (n.drum) {
        v = spawnDrum(
          this.ctx,
          this.dest,
          DRUM_PATCHES[n.drum],
          this.noise,
          when,
          n.vel,
          // Deterministic walk through the shared noise buffer.
          ((plan.bar * 16 + n.step) * 0.0137) % 0.4,
        );
      } else {
        const patch = PATCHES[this.id as Exclude<LayerId, 'perc'>];
        if (!patch) continue;
        v = spawnPitched(
          this.ctx,
          this.dest,
          patch,
          noteFreq(n),
          when,
          noteHold(n, plan),
          n.vel,
        );
      }
      this.tailTime = Math.max(this.tailTime, v.endTime);
      this._nodeCount += v.nodeCount;
    }
  }
}

/** One onset, flattened across layers so the budget can be applied fairly. */
export interface Onset {
  layer: LayerId;
  note: NoteEvent;
  /** Absolute start time. */
  when: number;
  /** Absolute time this voice goes silent (estimate, for budget accounting). */
  until: number;
}

/**
 * Flatten a bar's layers into a single time-ordered onset list, ordered by
 * (start time, descending priority). Deterministic: the input order is fixed
 * by LAYERS and the sort is a total order with no ties left to chance.
 */
export function flattenBar(
  notes: BarNotes,
  barTime: number,
  plan: BarPlan,
  audible: (id: LayerId) => boolean,
): Onset[] {
  const secPerStep = plan.secPerBar / 16;
  const out: Onset[] = [];
  for (const id of Object.keys(notes) as LayerId[]) {
    if (!audible(id)) continue;
    for (const n of notes[id]) {
      const when = barTime + n.step * secPerStep;
      // Budget accounting counts a voice as occupying a slot from its onset
      // until shortly into its RELEASE, not for the whole tail. A released
      // voice is already decaying towards silence and costs almost nothing —
      // charging it the full release starved the arrangement (a 1.7 s pad
      // release held three slots across two whole bars).
      // A pitched voice holds a slot from its onset to its NOTE-OFF — the
      // polyphony sense of "voice", the same one a hardware synth means. Its
      // release tail is left uncounted on purpose: charging it made new notes
      // get dropped because two already-decaying tails were still nominally
      // occupying the layer, which is the opposite of what the budget is for.
      // Percussion has no note-off, so it is charged its decay.
      const tail = n.drum ? DRUM_PATCHES[n.drum].decay + 0.02 : 0;
      out.push({
        layer: id,
        note: n,
        when,
        until: when + (n.drum ? tail : noteHold(n, plan)),
      });
    }
  }
  out.sort(
    (a, b) =>
      a.when - b.when ||
      LAYER_PRIORITY[b.layer] - LAYER_PRIORITY[a.layer] ||
      a.note.midi - b.note.midi,
  );
  return out;
}

/**
 * Apply the voice budget to a time-ordered onset list.
 * Returns the kept onsets plus the count dropped, so tests can assert the drop
 * rate rather than trusting that it is small.
 */
/** A voice occupying a slot: when it frees up, and which layer owns it. */
export interface ActiveVoice {
  until: number;
  layer: LayerId;
}

/**
 * @param audibleLayers layers actually sounding this bar. A silent layer must
 *   NOT hold a reservation, or its floor starves the layers that are playing —
 *   at calm intensity, percussion and tension are silent, and reserving three
 *   slots for them was enough to drop every single arpeggio note.
 */
export function applyVoiceBudget(
  onsets: readonly Onset[],
  active: ActiveVoice[],
  audibleLayers: readonly LayerId[],
  maxVoices = MAX_VOICES,
): { kept: Onset[]; dropped: number; droppedBy: Partial<Record<LayerId, number>>; peak: number } {
  const kept: Onset[] = [];
  const droppedBy: Partial<Record<LayerId, number>> = {};
  let dropped = 0;
  let peak = 0;
  for (const o of onsets) {
    // Retire voices that have finished before this onset. The epsilon is
    // load-bearing: a note whose duration ends exactly where the next begins
    // is a HANDOVER, not an overlap, and the two times are computed by
    // different float expressions (step*secPerStep vs dur*secPerBar/16) so
    // they can differ in the last bit. Without it the driving bass figure
    // dropped six of its eight eighth-notes to a phantom self-overlap.
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i]!.until <= o.when + 1e-6) active.splice(i, 1);
    }
    const perLayer: Partial<Record<LayerId, number>> = {};
    for (const a of active) perLayer[a.layer] = (perLayer[a.layer] ?? 0) + 1;
    const inLayer = perLayer[o.layer] ?? 0;

    // Invariant: active.length + SUM_l max(0, reserved[l] - active_l) <= max.
    // Because the reservations sum to exactly `maxVoices`, that invariant makes
    // a within-reservation onset ALWAYS admissible, and forces an onset beyond
    // its reservation to leave every other layer's floor intact. Without the
    // outstanding-reservation term, a pluck taking a free slot could push the
    // total past the cap the moment a reserved layer claimed its floor.
    if (inLayer >= LAYER_RESERVED[o.layer]) {
      let outstanding = 0;
      for (const l of audibleLayers) {
        if (l === o.layer) continue;
        outstanding += Math.max(0, LAYER_RESERVED[l] - (perLayer[l] ?? 0));
      }
      if (active.length + 1 + outstanding > maxVoices) {
        dropped++;
        droppedBy[o.layer] = (droppedBy[o.layer] ?? 0) + 1;
        continue;
      }
    }
    active.push({ until: o.until, layer: o.layer });
    if (active.length > peak) peak = active.length;
    kept.push(o);
  }
  return { kept, dropped, droppedBy, peak };
}
