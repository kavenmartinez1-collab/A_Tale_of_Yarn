/**
 * recording-indicator.ts — is the microphone open, and what is it doing.
 *
 * ## Look, and why it is cream in a slate panel
 *
 * The NPC chat panel is cool slate (`#cdd6e4` on `rgba(10,14,20,.9)`), like
 * every other `.game-panel`. This one strip inside it is thread cream
 * `#f0e6c8` with `stroke-dasharray: 2.6 2.2` and round caps — the bow
 * reticle's idiom (ui/reticle.ts), the torch bar's idiom (ui/torch-bar.ts).
 *
 * That is deliberate and it is a rule, not an exception. Cream stitch-work in
 * this game means A LIVE READOUT OF SOMETHING REAL AND CURRENT: how much torch
 * is left, where the arrow will go. Panel slate means furniture — labels,
 * buttons, prices. An open microphone is the most "real and current" thing the
 * UI ever reports, and it is hardware, so it takes the stitch. A player who has
 * learned that cream means "this is live" reads this correctly the first time.
 *
 * The run of stitches travels while recording — thread being spun, not a bar
 * filling, because there is no total to fill toward. It is a pure CSS
 * animation on `stroke-dashoffset`: the frame loop never touches it, which is
 * the point, since the whole feature's promise is that it does not cost frames.
 *
 * ## Not a level meter
 *
 * It shows CAPTURE STATE, not amplitude. Reading amplitude would mean tapping
 * the audio graph on the main thread every frame to move a needle, which is
 * exactly the cost this design refuses. "The mic is open" is the thing the
 * player actually needs to know.
 */
import type { VoiceState } from './voice-input';

const CSS = `
#npc-voice {
  display: none;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  min-height: 14px;
  user-select: none;
}
#npc-voice.on { display: flex; }
#npc-voice svg {
  display: block;
  overflow: visible;
  filter: drop-shadow(0 1px 1.5px rgba(8,10,14,0.85));
  flex: none;
}
#npc-voice line {
  stroke-dasharray: 2.6 2.2;
  stroke-linecap: round;
  stroke-width: 2.6;
  fill: none;
  stroke: rgba(240, 230, 200, 0.20);
}
/* Recording: the stitch runs. 4.8 is one dash+gap, so it loops seamlessly. */
#npc-voice.rec line {
  stroke: #f0e6c8;
  animation: npc-voice-spin 0.5s linear infinite;
}
@keyframes npc-voice-spin {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: -4.8; }
}
/* Thinking: the same thread, dimmed and breathing rather than travelling. */
#npc-voice.busy line {
  stroke: #f0e6c8;
  animation: npc-voice-ebb 1.15s ease-in-out infinite;
}
@keyframes npc-voice-ebb {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}
#npc-voice.err line { stroke: #e8934a; }
#npc-voice .label {
  font: 600 11px system-ui, sans-serif;
  color: #f0e6c8;
  letter-spacing: 0.3px;
  text-shadow: 0 1px 2px rgba(8,10,14,0.9);
  text-transform: uppercase;
  opacity: 0.85;
}
#npc-voice.err .label { color: #e8934a; text-transform: none; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Stitch run length in px — the width of the chat input's left half. */
const RUN = 74;

export class RecordingIndicator {
  readonly el: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  /** Last applied class string; the DOM is only touched on a real change. */
  private applied = '';

  constructor() {
    injectCss();
    this.el = document.createElement('div');
    this.el.id = 'npc-voice';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(RUN));
    svg.setAttribute('height', '6');
    svg.setAttribute('viewBox', `0 0 ${RUN} 6`);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '1'); line.setAttribute('y1', '3');
    line.setAttribute('x2', String(RUN - 1)); line.setAttribute('y2', '3');
    svg.appendChild(line);
    this.el.appendChild(svg);

    this.label = document.createElement('span');
    this.label.className = 'label';
    this.el.appendChild(this.label);
  }

  /**
   * Reflect a capture state. `detail` carries the reason for 'error', and the
   * transient nudges ("hold to talk") that arrive with 'idle'.
   */
  set(state: VoiceState, detail?: string): void {
    let cls = 'on';
    let text = '';
    switch (state) {
      case 'arming':
        // Not "listening" — the device is not open yet, and telling the player
        // to speak before it is loses their first word.
        cls = 'on busy'; text = 'opening mic…'; break;
      case 'recording':
        cls = 'on rec'; text = 'listening…'; break;
      case 'transcribing':
        cls = 'on busy'; text = 'transcribing…'; break;
      case 'error':
        cls = 'on err'; text = detail ?? 'voice unavailable'; break;
      case 'unsupported':
        cls = 'on err'; text = 'no microphone available'; break;
      default:
        // Idle with a nudge stays visible; idle proper hides the whole strip.
        if (detail) { cls = 'on err'; text = detail; } else { cls = ''; text = ''; }
    }
    if (cls !== this.applied) { this.el.className = cls; this.applied = cls; }
    if (this.label.textContent !== text) this.label.textContent = text;
  }
}
