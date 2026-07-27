/**
 * Minimal RIFF/WAVE encoder — 16-bit PCM, for the audition renders.
 * Test/tooling infrastructure; nothing in the engine imports it.
 */

/** Encode planar float channels to a 16-bit PCM WAV. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * numCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

export interface LevelStats {
  peak: number;
  rms: number;
  peakDb: number;
  rmsDb: number;
  nonFinite: number;
  /** Largest sample-to-sample jump — a hard cut shows up here as an outlier. */
  maxDelta: number;
  /** 99.99th percentile of |delta|, the baseline maxDelta is judged against. */
  p9999Delta: number;
}

const dB = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12));

/** Peak / RMS / discontinuity statistics over a rendered buffer. */
export function analyse(channels: readonly Float32Array[], skipSamples = 0): LevelStats {
  let peak = 0;
  let sum = 0;
  let n = 0;
  let nonFinite = 0;
  let maxDelta = 0;
  const deltas: number[] = [];
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]!;
      if (!Number.isFinite(v)) nonFinite++;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (i >= skipSamples) {
        sum += v * v;
        n++;
      }
      if (i > 0) {
        const d = Math.abs(v - ch[i - 1]!);
        if (d > maxDelta) maxDelta = d;
        deltas.push(d);
      }
    }
  }
  deltas.sort((a, b) => a - b);
  const p9999 = deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.9999))]! : 0;
  const rms = n > 0 ? Math.sqrt(sum / n) : 0;
  return {
    peak,
    rms,
    peakDb: dB(peak),
    rmsDb: dB(rms),
    nonFinite,
    maxDelta,
    p9999Delta: p9999,
  };
}
