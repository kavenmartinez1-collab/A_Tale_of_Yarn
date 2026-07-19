/**
 * Live debug capture — lets an agent see exactly what the player sees.
 *
 * F8 saves one snapshot; F9 toggles auto-capture (one every 2 s). Each
 * snapshot is the WebGPU canvas as a PNG data-URL plus a JSON state dump,
 * POSTed to the dev server (`/api/capture` in vite.config.ts), which writes
 * a ring buffer of the last ~40 frames to scripts/shots/live/.
 *
 * Capture MUST run inside the same rAF task that rendered the frame —
 * WebGPU canvases can read back blank once the frame is presented — so the
 * frame loop calls maybeCapture() right after a successful renderFrame().
 * Dev-only in practice: the POST just fails silently without the server.
 */

const AUTO_INTERVAL_MS = 2000;

export class DebugCapture {
  auto = false;
  private pending: string | null = null;
  private lastAuto = 0;
  private inFlight = false;

  /** Queue one snapshot (tagged manual/auto) for the next rendered frame. */
  request(tag = 'manual'): void {
    this.pending = tag;
  }

  /** Toggle 2 s auto-capture; returns the new state. */
  toggleAuto(): boolean {
    this.auto = !this.auto;
    return this.auto;
  }

  /**
   * Call right after a successful render, still inside the rAF task.
   * `state` is only evaluated when a capture is actually due.
   */
  maybeCapture(
    canvas: HTMLCanvasElement, now: number, state: () => unknown,
  ): void {
    let tag = this.pending;
    if (tag === null && this.auto && now - this.lastAuto >= AUTO_INTERVAL_MS) {
      tag = 'auto';
    }
    if (tag === null || this.inFlight) return;
    this.pending = null;
    this.lastAuto = now;
    this.inFlight = true;
    try {
      // Synchronous read-back while the frame is still current.
      const png = canvas.toDataURL('image/png');
      void fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, time: Date.now(), png, state: state() }),
      }).catch(() => { /* no dev server (prod build) — ignore */ })
        .finally(() => { this.inFlight = false; });
    } catch {
      this.inFlight = false;
    }
  }
}
