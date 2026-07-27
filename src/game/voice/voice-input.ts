/**
 * Push-to-talk voice input for NPC conversation.
 *
 * Hold V (or LB on a pad — gamepad.ts synthesises the same KeyV) and speak;
 * release and the transcript lands in the chat panel's text box. From there it
 * is ordinary typed text and takes the ordinary path: the same input element,
 * the same `sendMessage`, the same content-safety screen. Voice deliberately
 * creates NO second pipeline into the model.
 *
 * ── WHY RELEASE FILLS THE BOX INSTEAD OF SENDING ────────────────────────────
 *
 * Because a misrecognition here is not a typo, it is a consequence. Player
 * speech is screened by `screenPlayerInput` and then handed to the NPC, and the
 * reply path applies a deterministic threat floor (`detectThreat` →
 * `threatActionFor` → `handleNpcAction`) that can turn an NPC hostile, close
 * the panel mid-sentence, and put a bounty on the player. Speech recognition
 * mishears; "I'll kill some time" is not a sentence anyone should be arrested
 * for. Auto-send makes the model's error the player's crime.
 *
 * The second reason is that Whisper does not fail by returning nothing. Fed
 * silence it confidently emits " you" (measured — scripts/test-voice-accuracy
 * .mts asserts this exact behaviour, because a harness that treats silence as
 * empty is not testing anything). A release-to-send design would post that.
 *
 * So: release → transcribe → fill the box, focus it, leave the caret at the end
 * so a wrong word can be fixed → the player confirms. Confirming is ONE button
 * on either device: Enter on a keyboard (the panel's existing handler, which
 * this module does not touch), or A on a pad. The cost is one button press
 * against a class of failure the player cannot undo.
 *
 * ── HOW THE PAD CONFIRM WORKS ───────────────────────────────────────────────
 *
 * `gamepad.ts` dispatches synthetic events on `window`, so `e.target` is the
 * window and they can never reach a focused `<input>`. That is exactly what
 * lets us distinguish them: a pad's A arrives as `KeyE` with `target === window`
 * while a keyboard's E, typed into the box, arrives with `target === input`.
 * The confirm listener below accepts only the former, so typing the letter "e"
 * never sends and no keyboard behaviour changes.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 *
 * The microphone opens on key-DOWN and closes on key-UP. Not once per session
 * and not held between utterances: the OS capture indicator should be lit when
 * and only when the player is holding the key. This costs a `getUserMedia` per
 * utterance (~20-80 ms once permission is granted), which is why the recording
 * indicator appears only when capture is actually live — the light is the cue
 * to start speaking, as it is in every other push-to-talk.
 *
 * Nothing here is a gameplay timer, so `performance.now()` is correct and
 * `gameNowMs` is not needed: no world state, respawn, or sentence advances on
 * a voice event. Determinism rules do not bind for the same reason — but there
 * is no `Math.random()` here regardless.
 */
import { startMic, type Recorder } from '../../audio/mic';
import { buildVoicePrompt, type VoiceContext } from './vocabulary';

export type VoiceState =
  | 'idle'
  | 'unsupported'
  | 'arming'      // getUserMedia in flight, key still down
  | 'recording'
  | 'transcribing'
  | 'error';

export interface VoiceInputOptions {
  /** The chat panel's text field. The transcript is written here, verbatim. */
  input: HTMLInputElement;
  /** Submit whatever is currently in the box — the panel's own sendMessage. */
  submit: () => void;
  /** True while voice input is allowed (chat panel open and accepting input). */
  canCapture: () => boolean;
  /** Live proper nouns for prompt biasing. */
  context: () => VoiceContext;
  /** UI notification: state, plus a human-readable detail for errors. */
  onState: (state: VoiceState, detail?: string) => void;
}

/** Ignore taps shorter than this — a brush of the key is not an utterance. */
const MIN_HOLD_MS = 250;
/** Hard stop. Whisper's window is 30 s and a stuck key must not run forever. */
const MAX_HOLD_MS = 25_000;

// ---- The STT worker is process-wide, not per-panel --------------------------
//
// A conversation builds a fresh VoiceInput and throws it away on close, but
// loading 75 MB of int8 graphs takes ~1-2 s and doing that per NPC would make
// voice feel broken exactly when the player has just learned to use it. So the
// worker, its request table and its sequence live here and outlive every panel.
// An idle worker holding weights costs no frame time.

let workerSeq = 0;
let sharedWorker: Worker | null = null;
type Resolve = (r: { text: string; ms: number; encodeMs: number }) => void;
const inFlight = new Map<number, { resolve: Resolve; reject: (e: Error) => void }>();
/** Set by whichever VoiceInput is live, so worker-level errors reach the UI. */
let onWorkerError: ((message: string) => void) | null = null;

function sttWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  // `new URL(..., import.meta.url)` is how Vite recognises a worker and emits
  // it as its own chunk. That form is invisible to a naive text scan of the
  // bundle, which is precisely the hazard scripts/pack-steam.mjs now guards
  // against with an explicit required-asset manifest.
  const w = new Worker(new URL('./stt-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent) => {
    const m = ev.data as {
      type: string; id?: number; text?: string; ms?: number; encodeMs?: number; message?: string;
    };
    if (m.type === 'result' && m.id !== undefined) {
      inFlight.get(m.id)?.resolve({ text: m.text ?? '', ms: m.ms ?? 0, encodeMs: m.encodeMs ?? 0 });
      inFlight.delete(m.id);
    } else if (m.type === 'error') {
      const msg = m.message ?? 'transcription failed';
      if (m.id !== undefined) {
        inFlight.get(m.id)?.reject(new Error(msg));
        inFlight.delete(m.id);
      } else {
        onWorkerError?.(msg);
      }
    }
  };
  w.onerror = (ev) => {
    const msg = ev.message || 'speech worker failed to start';
    for (const [, p] of inFlight) p.reject(new Error(msg));
    inFlight.clear();
    onWorkerError?.(msg);
  };
  sharedWorker = w;
  return w;
}

/**
 * Drop the shared worker. Not called on panel close — see above. Exposed for
 * tests and for a future memory-pressure path.
 */
export function releaseSttWorker(): void {
  sharedWorker?.terminate();
  sharedWorker = null;
  inFlight.clear();
}

export class VoiceInput {
  private recorder: Recorder | null = null;
  private state: VoiceState = 'idle';
  private held = false;
  private startedAt = 0;
  private maxTimer: number | null = null;
  private pendingConfirm = false;
  private disposed = false;
  private readonly opts: VoiceInputOptions;

  /** Last measured leg timings, for __gameDebug and the latency harness. */
  lastTimings: { captureMs: number; transcribeMs: number; encodeMs: number } | null = null;

  constructor(opts: VoiceInputOptions) {
    this.opts = opts;
    onWorkerError = (message) => { if (!this.disposed) this.setState('error', message); };
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      // http:// on a non-loopback host, or a build with no media stack. The
      // packaged app is 127.0.0.1, which IS a secure context, so this is a
      // dev-page condition — say so rather than failing silently on press.
      this.setState('unsupported');
    }
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
  }

  /** Current state — the indicator and the harness both read this. */
  get current(): VoiceState { return this.state; }

  /** True once a transcript is sitting in the box waiting to be confirmed. */
  get awaitingConfirm(): boolean { return this.pendingConfirm; }

  /**
   * Start loading the model without recording anything.
   *
   * Called when the chat panel opens. The 75 MB of int8 graphs take ~1-2 s to
   * read and initialise, and doing it while the player reads the greeting is
   * the difference between voice feeling instant and feeling broken on the
   * first press.
   */
  warm(): void {
    if (this.state === 'unsupported' || this.disposed) return;
    sttWorker().postMessage({ type: 'load' });
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    this.clearMaxTimer();
    // Release the microphone on ANY teardown path. A panel closed mid-hold
    // must not leave the capture indicator lit.
    this.recorder?.cancel();
    this.recorder = null;
    this.held = false;
    this.pendingConfirm = false;
    if (this.disposed) onWorkerError = null;
    // The worker outlives the panel deliberately — see releaseSttWorker().
  }

  private setState(s: VoiceState, detail?: string): void {
    this.state = s;
    this.opts.onState(s, detail);
  }

  private transcribe(audio: Float32Array): Promise<{ text: string; ms: number; encodeMs: number }> {
    const id = ++workerSeq;
    const prompt = buildVoicePrompt(this.opts.context());
    return new Promise((resolve, reject) => {
      inFlight.set(id, { resolve, reject });
      // Transfer the sample buffer rather than copy it: a 25 s clip is 1.6 MB
      // and this runs on the frame the player let go of the key.
      sttWorker().postMessage({ type: 'transcribe', id, audio, prompt }, [audio.buffer]);
    });
  }

  // ---- Key handling -------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyE' && this.pendingConfirm) {
      // Pad A. Only the synthetic, window-targeted event — a real "e" typed
      // into the box has `target === input` and must stay a letter.
      if (e.target === window || e.target === document.body) {
        e.preventDefault();
        this.pendingConfirm = false;
        this.opts.submit();
      }
      return;
    }
    if (e.code !== 'KeyV') return;
    // Typing "v" into the chat box is a letter, not a hold. gamepad.ts targets
    // `window`, so the pad is unaffected by this guard.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.repeat) return;              // keyboard auto-repeat is not a new press
    if (this.held) return;
    if (!this.opts.canCapture()) return;
    if (this.state === 'unsupported') { this.setState('unsupported'); return; }
    if (this.state === 'arming' || this.state === 'recording' || this.state === 'transcribing') return;
    e.preventDefault();
    void this.beginCapture();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyV' || !this.held) return;
    e.preventDefault();
    this.held = false;
    void this.endCapture();
  };

  // ---- Capture ------------------------------------------------------------

  private async beginCapture(): Promise<void> {
    this.held = true;
    this.pendingConfirm = false;
    this.setState('arming');
    let rec: Recorder;
    try {
      rec = await startMic();
    } catch (err) {
      this.held = false;
      const name = (err as { name?: string })?.name;
      this.setState('error', name === 'NotAllowedError'
        ? 'microphone permission denied'
        : name === 'NotFoundError' ? 'no microphone found'
          : `microphone unavailable (${name ?? 'unknown'})`);
      return;
    }
    if (!this.held || this.disposed) {
      // Released (or the panel closed) while the device was opening. Nothing
      // was worth capturing in that window, and the mic must not stay open.
      rec.cancel();
      this.setState('idle');
      return;
    }
    this.recorder = rec;
    this.startedAt = performance.now();
    this.setState('recording');
    this.maxTimer = window.setTimeout(() => {
      if (this.state === 'recording') { this.held = false; void this.endCapture(); }
    }, MAX_HOLD_MS);
  }

  private clearMaxTimer(): void {
    if (this.maxTimer !== null) { window.clearTimeout(this.maxTimer); this.maxTimer = null; }
  }

  private async endCapture(): Promise<void> {
    this.clearMaxTimer();
    const rec = this.recorder;
    this.recorder = null;
    if (!rec) { if (this.state !== 'error') this.setState('idle'); return; }

    const heldMs = performance.now() - this.startedAt;
    if (heldMs < MIN_HOLD_MS) {
      rec.cancel();
      this.setState('idle', 'hold to talk');
      return;
    }

    this.setState('transcribing');
    const t0 = performance.now();
    try {
      const audio = await rec.stop();
      const captureMs = performance.now() - t0;
      const { text, ms, encodeMs } = await this.transcribe(audio);
      this.lastTimings = {
        captureMs: Math.round(captureMs), transcribeMs: ms, encodeMs,
      };
      if (this.disposed || !this.opts.canCapture()) { this.setState('idle'); return; }
      if (!text) { this.setState('idle', 'nothing heard'); return; }
      this.fill(text);
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err));
    }
  }

  /** Put the transcript in the box exactly as typed text would arrive. */
  private fill(text: string): void {
    const el = this.opts.input;
    // Append rather than replace: a player who typed half a sentence and then
    // spoke the rest should get both, and it makes an accidental hold
    // non-destructive.
    el.value = el.value.trim() ? `${el.value.replace(/\s+$/, '')} ${text}` : text;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // `input` so anything listening for edits (now or later) sees it — the
    // transcript is indistinguishable from typing by design.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this.pendingConfirm = true;
    this.setState('idle');
  }
}
