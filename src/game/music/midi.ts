/**
 * Standard MIDI File writer — the Ableton pipeline.
 *
 * Emits format-1 files: track 0 carries tempo / time signature / key
 * signature / name, track 1 carries the notes. That is the shape DAWs expect,
 * so a stem drops onto an instrument track with its tempo and key already
 * correct rather than needing to be re-guessed.
 *
 * Byte-deterministic by construction: no timestamps, no UUIDs, no map
 * iteration order that is not fixed by the caller.
 */

import type { NoteEvent } from './arranger';
import { MODES, type ModeName } from './theory';

export const PPQ = 480; // ticks per quarter note
export const TICKS_PER_STEP = PPQ / 4; // 16th-note grid

export interface MidiNote {
  tick: number;
  durTicks: number;
  midi: number;
  /** 1..127 */
  vel: number;
}

export interface SmfOptions {
  bpm: number;
  /** Sequence + track name. */
  name: string;
  notes: readonly MidiNote[];
  /** 0-based; 9 = GM percussion. */
  channel?: number;
  mode?: ModeName;
  /** Tonic pitch class, 0 = C. Used for the key-signature meta event. */
  tonicPc?: number;
  timeSig?: [number, number];
}

function vlq(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function str(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0x7f);
  return out;
}

function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function be16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}

function chunk(id: string, body: number[]): number[] {
  return [...str(id), ...be32(body.length), ...body];
}

/** Sharps(+)/flats(-) of a major key, by tonic pitch class. */
const MAJOR_SF: Record<number, number> = {
  0: 0,
  7: 1,
  2: 2,
  9: 3,
  4: 4,
  11: 5,
  6: 6,
  1: -5,
  8: -4,
  3: -3,
  10: -2,
  5: -1,
};

/** Semitones from the parent major's tonic up to each mode's tonic. */
const MODE_OFFSET: Record<ModeName, number> = {
  ionian: 0,
  dorian: 2,
  phrygian: 4,
  mixolydian: 7,
  aeolian: 9,
};

/** Key-signature meta payload [sf, mi] for a mode on a tonic pitch class. */
export function keySignature(tonicPc: number, mode: ModeName): [number, number] {
  const parent = (((tonicPc - MODE_OFFSET[mode]) % 12) + 12) % 12;
  const sf = MAJOR_SF[parent] ?? 0;
  const minorish = MODES[mode][2] === 3 ? 1 : 0;
  return [sf, minorish];
}

/** Conductor track: name, tempo, time signature, key signature. */
function metaTrack(opts: Pick<SmfOptions, 'bpm' | 'name' | 'mode' | 'tonicPc' | 'timeSig'>): number[] {
  const [num, den] = opts.timeSig ?? [4, 4];
  const usPerQuarter = Math.round(60_000_000 / opts.bpm);
  const meta: number[] = [];
  const pushMeta = (delta: number, type: number, data: number[]) => {
    meta.push(...vlq(delta), 0xff, type, ...vlq(data.length), ...data);
  };
  pushMeta(0, 0x03, str(opts.name));
  pushMeta(0, 0x51, [
    (usPerQuarter >>> 16) & 0xff,
    (usPerQuarter >>> 8) & 0xff,
    usPerQuarter & 0xff,
  ]);
  pushMeta(0, 0x58, [num, Math.round(Math.log2(den)), 24, 8]);
  if (opts.mode && opts.tonicPc !== undefined) {
    const [sf, mi] = keySignature(opts.tonicPc, opts.mode);
    pushMeta(0, 0x59, [sf & 0xff, mi]);
  }
  meta.push(...vlq(0), 0xff, 0x2f, 0x00);
  return meta;
}

/**
 * One note track. Note-offs are emitted before note-ons at the same tick, so a
 * repeated pitch never leaves a stuck note in the DAW.
 */
function noteTrack(name: string, notes: readonly MidiNote[], channel: number): number[] {
  const ch = channel & 0x0f;
  interface Ev {
    tick: number;
    order: number;
    bytes: number[];
  }
  const evs: Ev[] = [];
  for (const n of notes) {
    const midi = Math.max(0, Math.min(127, Math.round(n.midi)));
    const vel = Math.max(1, Math.min(127, Math.round(n.vel)));
    const on = Math.max(0, Math.round(n.tick));
    const off = Math.max(on + 1, Math.round(n.tick + n.durTicks));
    evs.push({ tick: on, order: 1, bytes: [0x90 | ch, midi, vel] });
    evs.push({ tick: off, order: 0, bytes: [0x80 | ch, midi, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1]! - b.bytes[1]!);

  const trk: number[] = [];
  trk.push(...vlq(0), 0xff, 0x03, ...vlq(name.length), ...str(name));
  let last = 0;
  for (const e of evs) {
    trk.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  trk.push(...vlq(0), 0xff, 0x2f, 0x00);
  return trk;
}

/** Encode one stem as a format-1 file (conductor track + one note track). */
export function writeSmf(opts: SmfOptions): Uint8Array {
  const header = chunk('MThd', [...be16(1), ...be16(2), ...be16(PPQ)]);
  return Uint8Array.from([
    ...header,
    ...chunk('MTrk', metaTrack(opts)),
    ...chunk('MTrk', noteTrack(opts.name, opts.notes, opts.channel ?? 0)),
  ]);
}

export interface SmfTrack {
  name: string;
  notes: readonly MidiNote[];
  channel: number;
}

/**
 * All layers in one format-1 file — the convenient thing to drag into a DAW,
 * where each track lands on its own instrument slot.
 */
export function writeSmfMulti(
  opts: Omit<SmfOptions, 'notes' | 'channel'> & { tracks: readonly SmfTrack[] },
): Uint8Array {
  const header = chunk('MThd', [...be16(1), ...be16(1 + opts.tracks.length), ...be16(PPQ)]);
  const body: number[] = [...header, ...chunk('MTrk', metaTrack(opts))];
  for (const t of opts.tracks) body.push(...chunk('MTrk', noteTrack(t.name, t.notes, t.channel)));
  return Uint8Array.from(body);
}

/**
 * Convert arranged note events (16th-grid, per bar) into absolute MIDI ticks.
 * `bar` and `step` come straight off the arranger, so the exported file and
 * the audible performance are the same data.
 */
export function notesToMidi(notes: readonly NoteEvent[]): MidiNote[] {
  return notes.map((n) => ({
    tick: (n.bar * 16 + n.step) * TICKS_PER_STEP,
    durTicks: Math.max(1, n.dur * TICKS_PER_STEP),
    midi: n.midi,
    vel: Math.max(1, Math.min(127, Math.round(n.vel * 127))),
  }));
}

/**
 * Build one per-layer stem. Used by both scripts/export-music-midi.mts and the
 * determinism test, so what is asserted is exactly what is written to disk.
 */
export function buildStem(
  name: string,
  notes: readonly NoteEvent[],
  plan: { bpm: number; mode: ModeName; tonicMidi: number },
  isPercussion: boolean,
): Uint8Array {
  return writeSmf({
    bpm: plan.bpm,
    name,
    notes: notesToMidi(notes),
    channel: isPercussion ? 9 : 0,
    mode: plan.mode,
    tonicPc: ((plan.tonicMidi % 12) + 12) % 12,
  });
}
