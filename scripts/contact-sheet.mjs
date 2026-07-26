/**
 * Contact sheets — tile a play session's filmstrip into a few large images.
 *
 *   node scripts/contact-sheet.mjs <playDir>
 *
 * A play session is 15-25 frames. Reviewing those one at a time loses the
 * thing that matters most: how the world reads *in motion*, over time. Tiling
 * them into a grid turns a session into something you can take in at a glance
 * and compare across — which is the difference between "here is a screenshot
 * I framed" and "here is what playing actually looks like".
 *
 * Uses the browser that is already a dependency to composite, so this adds no
 * image library. Each tile is captioned with its frame index and the beat note
 * from session.json, so a problem can be traced back to the exact moment.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const playDir = process.argv[2] || 'scripts/shots/play';
const PER_SHEET = 12;   // 4 x 3
const TILE_W = 460;

const sessions = fs.readdirSync(playDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (sessions.length === 0) {
  console.log(`no session directories under ${playDir}`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

for (const name of sessions) {
  const dir = path.join(playDir, name);
  const frames = fs.readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).sort();
  if (frames.length === 0) continue;

  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf-8'));
  } catch { /* captions are optional */ }

  for (let s = 0; s * PER_SHEET < frames.length; s++) {
    const slice = frames.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const tiles = slice.map((f) => {
      const i = frames.indexOf(f);
      const rec = log[i] ?? {};
      const b64 = fs.readFileSync(path.join(dir, f)).toString('base64');
      const pos = rec.pos ? `${rec.pos[0]}, ${rec.pos[1]}, ${rec.pos[2]}` : '';
      const meta = [
        rec.fps !== undefined ? `${rec.fps}fps` : '',
        rec.drawn !== undefined ? `${rec.drawn} ent` : '',
        rec.prompt ? `"${rec.prompt}"` : '',
      ].filter(Boolean).join('  ');
      return `<figure>
        <img src="data:image/png;base64,${b64}">
        <figcaption><b>${i}</b> ${escapeHtml(rec.beat ?? '')}
        <span>${escapeHtml(pos)}${meta ? ' — ' + escapeHtml(meta) : ''}</span></figcaption>
      </figure>`;
    }).join('\n');

    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { margin:0; background:#14181f; font:12px/1.35 system-ui, sans-serif;
             color:#c9d3e0; padding:10px; }
      h1 { font-size:15px; margin:2px 0 10px; color:#8fb4e8; font-weight:600; }
      .grid { display:grid; grid-template-columns:repeat(4, ${TILE_W}px); gap:10px; }
      figure { margin:0; }
      img { width:${TILE_W}px; display:block; border-radius:3px; }
      figcaption { padding:4px 2px 0; }
      figcaption b { color:#f0c674; margin-right:5px; }
      figcaption span { display:block; color:#7d8899; font-size:11px; }
    </style>
    <h1>${escapeHtml(name)} — frames ${s * PER_SHEET}–${s * PER_SHEET + slice.length - 1}</h1>
    <div class="grid">${tiles}</div>`);

    const out = path.join(playDir, `sheet-${name}-${s}.png`);
    await page.locator('body').screenshot({ path: out });
    console.log(`${out}  (${slice.length} frames)`);
  }
}

await browser.close();

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
