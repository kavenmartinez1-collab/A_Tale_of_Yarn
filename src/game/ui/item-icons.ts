/**
 * Procedural item icons — every inventory item gets a recognizable pictogram
 * drawn once on an offscreen canvas (48×48, transparent background) and
 * cached as a data URL. No art assets; shapes are keyed per item id with a
 * kind/held fallback, tinted by the item's registry color.
 *
 * ICON_DRAWERS is exported for node-side coverage tests (no canvas required).
 * Only `itemIcon` touches the DOM.
 */

import { itemDef, type GameItemId } from '../items';

const SIZE = 48;
const cache = new Map<GameItemId, string>();

function css(c: readonly [number, number, number], mul = 1): string {
  const to255 = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * mul * 255)));
  return `rgb(${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])})`;
}

type Ctx = CanvasRenderingContext2D;
type C3 = readonly [number, number, number];

const WOOD: C3 = [0.45, 0.31, 0.18];
const METAL_DARK: C3 = [0.28, 0.28, 0.30];

function outline(ctx: Ctx): void {
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number,
  fill: string): void {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fill();
  outline(ctx);
}

function circle(ctx: Ctx, x: number, y: number, r: number,
  fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  outline(ctx);
}

function poly(ctx: Ctx, pts: number[][], fill: string): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  outline(ctx);
}

// --- weapon/tool archetypes (drawn diagonally, grip bottom-left) ------------

function drawSword(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 4);
  rrect(ctx, -3, -21, 6, 26, css(c));               // blade
  poly(ctx, [[-3, -21], [0, -25], [3, -21]], css(c, 1.1)); // tip
  rrect(ctx, -8, 5, 16, 4, css([0.35, 0.35, 0.38])); // crossguard
  rrect(ctx, -2.5, 9, 5, 10, css(WOOD));             // grip
  circle(ctx, 0, 21, 3, css([0.35, 0.35, 0.38]));    // pommel
  ctx.restore();
}

function drawAxe(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 26);
  ctx.rotate(-Math.PI / 5);
  rrect(ctx, -2.5, -18, 5, 38, css(WOOD));           // shaft
  poly(ctx, [[-3, -18], [-16, -14], [-14, -2], [-3, -6]], css(c)); // blade
  rrect(ctx, 2.5, -16, 5, 8, css(c, 0.85));          // back poll
  ctx.restore();
}

function drawPickaxe(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 26);
  ctx.rotate(-Math.PI / 6);
  rrect(ctx, -2.5, -16, 5, 36, css(WOOD));           // shaft
  poly(ctx, [[-18, -10], [0, -20], [18, -10], [16, -7], [0, -15], [-16, -7]],
    css(c));                                          // curved twin spikes
  ctx.restore();
}

function drawBow(ctx: Ctx, c: C3): void {
  ctx.beginPath();
  ctx.arc(18, 24, 16, -Math.PI / 2.3, Math.PI / 2.3); // limb arc
  ctx.strokeStyle = css(c);
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.beginPath();                                    // string
  ctx.moveTo(24, 9);
  ctx.lineTo(24, 39);
  ctx.strokeStyle = 'rgba(235, 235, 225, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawStaff(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 8);
  rrect(ctx, -2, -18, 4, 40, css(c));                 // shaft
  circle(ctx, 0, -19, 5, css(c, 1.35));               // knob
  ctx.restore();
}

// --- material / loot pictograms ---------------------------------------------

function drawCoins(ctx: Ctx, c: C3, pile: boolean): void {
  const coin = (x: number, y: number) => {
    circle(ctx, x, y, 7, css(c));
    circle(ctx, x, y, 4, css(c, 1.18));
  };
  if (pile) {
    coin(15, 33); coin(33, 33); coin(24, 34);
    coin(19, 22); coin(29, 22); coin(24, 12);
  } else {
    coin(17, 29); coin(31, 29); coin(24, 18);
  }
}

function drawHerb(ctx: Ctx, c: C3): void {
  ctx.beginPath();                                    // stem
  ctx.moveTo(24, 40);
  ctx.quadraticCurveTo(23, 26, 24, 12);
  ctx.strokeStyle = css(c, 0.7);
  ctx.lineWidth = 2.5;
  ctx.stroke();
  poly(ctx, [[24, 22], [12, 16], [22, 12]], css(c));  // left leaf
  poly(ctx, [[24, 28], [36, 22], [26, 17]], css(c, 1.15)); // right leaf
  poly(ctx, [[24, 14], [19, 7], [27, 8]], css(c, 1.25));   // top leaf
}

function drawGem(ctx: Ctx, c: C3): void {
  poly(ctx, [[24, 8], [38, 20], [24, 40], [10, 20]], css(c));
  poly(ctx, [[24, 8], [30, 20], [24, 40], [18, 20]], css(c, 1.3));
}

function drawFlask(ctx: Ctx, c: C3): void {
  rrect(ctx, 21, 8, 6, 6, css([0.5, 0.42, 0.35]));    // cork/neck
  poly(ctx, [[21, 14], [27, 14], [34, 34], [30, 40], [18, 40], [14, 34]],
    css(c));                                          // body
  circle(ctx, 24, 32, 4, css(c, 1.3));                // liquid glint
}

function drawBone(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(Math.PI / 4);
  rrect(ctx, -3, -13, 6, 26, css(c));
  circle(ctx, -4, -14, 4.5, css(c));
  circle(ctx, 4, -14, 4.5, css(c));
  circle(ctx, -4, 14, 4.5, css(c));
  circle(ctx, 4, 14, 4.5, css(c));
  ctx.restore();
}

function drawKey(ctx: Ctx, c: C3): void {
  ctx.beginPath();
  ctx.arc(24, 14, 7, 0, Math.PI * 2);                 // bow (ring)
  ctx.strokeStyle = css(c);
  ctx.lineWidth = 4;
  ctx.stroke();
  rrect(ctx, 22, 21, 4, 18, css(c));                  // stem
  rrect(ctx, 26, 32, 6, 3.5, css(c));                 // teeth
  rrect(ctx, 26, 37, 4, 3.5, css(c));
}

function drawLogs(ctx: Ctx, c: C3): void {
  const log = (y: number) => {
    rrect(ctx, 10, y, 30, 9, css(c));
    circle(ctx, 40, y + 4.5, 4.5, css(c, 1.25));      // end grain
    circle(ctx, 40, y + 4.5, 2, css(c, 0.8));
  };
  log(25);
  log(14);
}

function drawStone(ctx: Ctx, c: C3): void {
  poly(ctx, [[12, 36], [8, 24], [18, 12], [34, 12], [40, 26], [32, 36]],
    css(c));
  poly(ctx, [[18, 12], [26, 20], [34, 12]], css(c, 1.15)); // top facet
}

function drawOre(ctx: Ctx, c: C3): void {
  drawStone(ctx, c);
  circle(ctx, 20, 24, 2.5, css([0.85, 0.55, 0.25]));  // metal flecks
  circle(ctx, 29, 28, 2.5, css([0.85, 0.55, 0.25]));
  circle(ctx, 25, 18, 2, css([0.9, 0.62, 0.3]));
}

function drawBerries(ctx: Ctx, c: C3): void {
  poly(ctx, [[24, 12], [17, 6], [28, 7]], css([0.3, 0.5, 0.22])); // leaf
  circle(ctx, 18, 24, 6.5, css(c));
  circle(ctx, 30, 24, 6.5, css(c, 0.9));
  circle(ctx, 24, 33, 6.5, css(c, 1.1));
}

function drawMeal(ctx: Ctx, c: C3): void {
  circle(ctx, 19, 20, 5, css(c, 1.1));                // berries above the rim
  circle(ctx, 29, 20, 5, css(c, 0.95));
  circle(ctx, 24, 17, 5, css(c, 1.2));
  ctx.beginPath();                                    // bowl
  ctx.arc(24, 22, 14, 0, Math.PI);
  ctx.closePath();
  ctx.fillStyle = css([0.55, 0.40, 0.28]);
  ctx.fill();
  outline(ctx);
}

// --- Phase E family helpers -------------------------------------------------

/** Herb with a small colored flower at the top (used for warming/cooling herb). */
function drawFlowerHerb(ctx: Ctx, stemC: C3, flowerC: C3): void {
  ctx.beginPath();
  ctx.moveTo(24, 40);
  ctx.quadraticCurveTo(22, 28, 24, 14);
  ctx.strokeStyle = css(stemC, 0.75);
  ctx.lineWidth = 2.5;
  ctx.stroke();
  poly(ctx, [[24, 28], [14, 22], [20, 17]], css(stemC));
  poly(ctx, [[24, 22], [34, 18], [28, 14]], css(stemC, 1.1));
  circle(ctx, 24, 10, 5, css(flowerC));               // bloom
  circle(ctx, 24, 10, 2.5, css(flowerC, 1.4));
}

/** Round bottle/gourd shape with optional liquid color fill inside. */
function drawBottle(ctx: Ctx, bodyC: C3, liquidC: C3 | null, neckTall = false): void {
  const neckH = neckTall ? 10 : 6;
  rrect(ctx, 21, 8, 6, neckH, css([0.45, 0.35, 0.22]));  // cork/neck
  // Gourd body = circle with bottom cut
  ctx.beginPath();
  ctx.arc(24, 30, 13, 0, Math.PI * 2);
  ctx.fillStyle = css(bodyC);
  ctx.fill();
  outline(ctx);
  if (liquidC !== null) {
    // Liquid fill (bottom third)
    ctx.save();
    ctx.beginPath();
    ctx.arc(24, 30, 13, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = css(liquidC, 0.85);
    ctx.fillRect(11, 33, 26, 13);
    ctx.restore();
  }
}

/** Waterskin — flattened oval pouch with stitching hint. */
function drawWaterskin(ctx: Ctx, c: C3): void {
  rrect(ctx, 20, 7, 8, 5, css([0.35, 0.25, 0.15]));   // tie/neck
  ctx.beginPath();
  ctx.ellipse(24, 28, 12, 15, 0, 0, Math.PI * 2);
  ctx.fillStyle = css(c);
  ctx.fill();
  outline(ctx);
  // Stitching line
  ctx.beginPath();
  ctx.moveTo(24, 14);
  ctx.lineTo(24, 40);
  ctx.strokeStyle = css(c, 0.6);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Metal flask — straight-sided with cap. */
function drawMetalFlask(ctx: Ctx, c: C3): void {
  rrect(ctx, 21, 8, 6, 5, css(METAL_DARK));           // cap
  rrect(ctx, 18, 13, 12, 26, css(c));                 // body
  rrect(ctx, 20, 35, 8, 4, css(c, 0.8));              // base flare
  // Sheen stripe
  rrect(ctx, 22, 15, 3, 20, css(c, 1.3));
}

/** Ingot bar — flat parallelogram. */
function drawIngot(ctx: Ctx, c: C3): void {
  poly(ctx, [[10, 34], [12, 20], [38, 20], [36, 34]], css(c));      // face
  poly(ctx, [[12, 20], [18, 14], [44, 14], [38, 20]], css(c, 1.2)); // top
  poly(ctx, [[38, 20], [44, 14], [44, 28], [36, 34]], css(c, 0.75)); // side
}

/** Ore chunk — stone with distinct mineral-color flecks. */
function drawOreChunk(ctx: Ctx, stoneC: C3, fleckC: C3): void {
  drawStone(ctx, stoneC);
  circle(ctx, 20, 22, 2.5, css(fleckC));
  circle(ctx, 29, 27, 2.5, css(fleckC));
  circle(ctx, 24, 17, 2, css(fleckC, 1.2));
}

/** Plank — two horizontal boards side by side. */
function drawPlanks(ctx: Ctx, c: C3): void {
  rrect(ctx, 8, 15, 32, 8, css(c));
  rrect(ctx, 8, 26, 32, 8, css(c, 0.85));
  // Grain lines
  for (const x of [16, 24, 32]) {
    ctx.beginPath();
    ctx.moveTo(x, 15);
    ctx.lineTo(x, 34);
    ctx.strokeStyle = css(c, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Thread spool — barrel with wound line. */
function drawThread(ctx: Ctx, c: C3): void {
  rrect(ctx, 16, 14, 16, 20, css(c));                 // spool body
  rrect(ctx, 13, 12, 22, 5, css(c, 0.7));             // top flange
  rrect(ctx, 13, 31, 22, 5, css(c, 0.7));             // bottom flange
  // Wound lines
  for (const y of [18, 22, 26, 30]) {
    ctx.beginPath();
    ctx.moveTo(16, y);
    ctx.lineTo(32, y);
    ctx.strokeStyle = css(c, 1.3);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Rope coil — spiral of thick cord. */
function drawRope(ctx: Ctx, c: C3): void {
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(24, 25, 10 - i * 3, 0, Math.PI * 1.75);
    ctx.strokeStyle = css(c, 1 - i * 0.15);
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

/** Bow string — a taut line segment with loop ends. */
function drawBowString(ctx: Ctx, c: C3): void {
  // Two small loops at each end
  circle(ctx, 24, 10, 4, css(c));
  circle(ctx, 24, 38, 4, css(c));
  ctx.beginPath();
  ctx.moveTo(24, 10);
  ctx.lineTo(24, 38);
  ctx.strokeStyle = css(c);
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Arrow shaft — thin rod with feathered end. */
function drawArrowShaft(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 5);
  rrect(ctx, -1.5, -18, 3, 36, css(c));
  // Fletching
  poly(ctx, [[0, 18], [-5, 12], [0, 8]], css([0.85, 0.82, 0.78]));
  poly(ctx, [[0, 18], [5, 12], [0, 8]], css([0.85, 0.82, 0.78]));
  ctx.restore();
}

/** Full arrow — shaft + tip. */
function drawArrow(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 5);
  rrect(ctx, -1.5, -18, 3, 34, css(WOOD));            // shaft
  poly(ctx, [[-3, -18], [0, -26], [3, -18]], css(c)); // tip
  poly(ctx, [[0, 16], [-5, 10], [0, 6]], css([0.85, 0.82, 0.78])); // fletching
  poly(ctx, [[0, 16], [5, 10], [0, 6]], css([0.85, 0.82, 0.78]));
  ctx.restore();
}

/** Hide — irregular flat pelt shape. */
function drawHide(ctx: Ctx, c: C3): void {
  poly(ctx, [
    [24, 8], [36, 12], [40, 24], [36, 38],
    [24, 42], [12, 38], [8, 24], [12, 12],
  ], css(c));
  // Texture hint
  ctx.beginPath();
  ctx.ellipse(24, 26, 7, 10, 0, 0, Math.PI * 2);
  ctx.strokeStyle = css(c, 0.6);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Leather sheet — rectangular with stitching. */
function drawLeather(ctx: Ctx, c: C3): void {
  rrect(ctx, 10, 14, 28, 22, css(c));
  // Stitching border
  ctx.beginPath();
  ctx.rect(13, 17, 22, 16);
  ctx.strokeStyle = css(c, 0.55);
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Wool clump — fluffy overlapping circles. */
function drawWool(ctx: Ctx, c: C3): void {
  circle(ctx, 18, 28, 8, css(c));
  circle(ctx, 30, 28, 8, css(c, 0.9));
  circle(ctx, 24, 22, 9, css(c, 1.05));
  circle(ctx, 18, 20, 6, css(c, 0.95));
  circle(ctx, 30, 20, 6, css(c));
}

/** Wool yarn ball — circle with crossing lines. */
function drawWoolYarn(ctx: Ctx, c: C3): void {
  circle(ctx, 24, 26, 14, css(c));
  // Cross-hatch yarn lines
  for (let a = 0; a < Math.PI; a += Math.PI / 4) {
    ctx.save();
    ctx.translate(24, 26);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(14, 0);
    ctx.strokeStyle = css(c, 0.6);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
}

/** Bone needle — thin with eye hole. */
function drawBoneNeedle(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 6);
  rrect(ctx, -1.5, -20, 3, 40, css(c));               // needle body
  // Eye hole
  ctx.beginPath();
  ctx.ellipse(0, -15, 2.5, 1.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fill();
  // Tip taper
  poly(ctx, [[-1.5, 18], [0, 22], [1.5, 18]], css(c, 1.2));
  ctx.restore();
}

/** Feather — curved quill with barbs. */
function drawFeather(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 7);
  // Quill
  ctx.beginPath();
  ctx.moveTo(0, 20);
  ctx.quadraticCurveTo(-2, 0, 0, -20);
  ctx.strokeStyle = css(c, 0.7);
  ctx.lineWidth = 2;
  ctx.stroke();
  // Vanes
  for (let y = -16; y < 18; y += 4) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(-8, y - 2, -10, y - 6);
    ctx.strokeStyle = css(c);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(8, y - 2, 10, y - 6);
    ctx.strokeStyle = css(c, 0.85);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

/** Egg — rounded oval with slight taper. */
function drawEgg(ctx: Ctx, c: C3): void {
  ctx.beginPath();
  ctx.ellipse(24, 27, 11, 14, 0, 0, Math.PI * 2);
  ctx.fillStyle = css(c);
  ctx.fill();
  outline(ctx);
  // Sheen spot
  ctx.beginPath();
  ctx.ellipse(20, 20, 3, 2, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = css(c, 1.35);
  ctx.fill();
}

/** Dragon scale — hexagonal faceted tile. */
function drawDragonScale(ctx: Ctx, c: C3): void {
  // Hexagon
  const hex: number[][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    hex.push([24 + 16 * Math.cos(a), 24 + 16 * Math.sin(a)]);
  }
  poly(ctx, hex, css(c));
  // Inner highlight facets
  const inner: number[][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    inner.push([24 + 8 * Math.cos(a), 24 + 8 * Math.sin(a)]);
  }
  poly(ctx, inner, css(c, 1.3));
}

/** Griffin feather — larger, with golden quill. */
function drawGriffinFeather(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 8);
  // Quill — golden
  ctx.beginPath();
  ctx.moveTo(0, 22);
  ctx.quadraticCurveTo(-2, 4, 0, -22);
  ctx.strokeStyle = css([0.85, 0.72, 0.30], 1);
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Wide vanes
  for (let y = -18; y < 20; y += 5) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(-11, y - 3, -13, y - 8);
    ctx.strokeStyle = css(c, y < 0 ? 1.1 : 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(11, y - 3, 13, y - 8);
    ctx.strokeStyle = css(c, 0.8);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

/** Meat — raw or cooked slab. */
function drawMeat(ctx: Ctx, c: C3, cooked: boolean): void {
  // Bone stub
  rrect(ctx, 31, 10, 6, 12, css([0.88, 0.85, 0.75]));
  // Meat chunk
  poly(ctx, [
    [10, 22], [12, 14], [30, 12], [38, 18],
    [36, 36], [16, 38], [8, 30],
  ], css(c));
  if (cooked) {
    // Char lines
    for (const pts of [[[14, 18], [22, 28]], [[22, 16], [30, 26]]]) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.strokeStyle = css([0.25, 0.15, 0.10]);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

/** Plant fiber — loose bundle of strands. */
function drawFiber(ctx: Ctx, c: C3): void {
  for (let i = -2; i <= 2; i++) {
    const x = 24 + i * 4;
    ctx.beginPath();
    ctx.moveTo(x, 38);
    ctx.quadraticCurveTo(x + i, 24, x - i * 0.5, 10);
    ctx.strokeStyle = css(c, 0.8 + i * 0.06);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Tie band
  rrect(ctx, 16, 26, 16, 4, css(c, 0.6));
}

/** Gourd fruit — round body with stem. */
function drawGourd(ctx: Ctx, c: C3): void {
  // Stem
  rrect(ctx, 22, 7, 4, 7, css([0.35, 0.50, 0.20]));
  // Body
  ctx.beginPath();
  ctx.arc(24, 28, 14, 0, Math.PI * 2);
  ctx.fillStyle = css(c);
  ctx.fill();
  outline(ctx);
  // Ridge lines
  for (const a of [-0.4, 0, 0.4]) {
    ctx.beginPath();
    ctx.arc(24, 28, 14, Math.PI * 0.6 + a, Math.PI * 1.4 + a);
    ctx.strokeStyle = css(c, 0.65);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Cactus flesh — green irregular chunk with dots. */
function drawCactusFlesh(ctx: Ctx, c: C3): void {
  poly(ctx, [
    [14, 38], [10, 26], [14, 14], [24, 10],
    [34, 14], [38, 26], [34, 38],
  ], css(c));
  // Spine dots
  for (const [x, y] of [[20, 18], [28, 16], [32, 24], [16, 30], [26, 34]]) {
    circle(ctx, x, y, 1.5, css([0.92, 0.90, 0.85]));
  }
}

/** Reeds — three upright stalks. */
function drawReeds(ctx: Ctx, c: C3): void {
  for (const [x, tip, lean] of [[18, 8, -1], [24, 5, 0], [30, 9, 1]] as [number, number, number][]) {
    ctx.beginPath();
    ctx.moveTo(x, 40);
    ctx.quadraticCurveTo(x + lean * 2, 24, x + lean * 3, tip);
    ctx.strokeStyle = css(c);
    ctx.lineWidth = 3;
    ctx.stroke();
    // Seed head
    rrect(ctx, x + lean * 3 - 2.5, tip - 4, 5, 8, css(c, 1.2));
  }
}

/** Flax — slender stems with small blue flowers. */
function drawFlax(ctx: Ctx, c: C3): void {
  for (const [x, lean] of [[20, -1], [24, 0], [28, 1]] as [number, number][]) {
    ctx.beginPath();
    ctx.moveTo(x, 40);
    ctx.quadraticCurveTo(x + lean, 24, x + lean * 2, 8);
    ctx.strokeStyle = css(c, 0.8);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Flower heads (blue tint)
  circle(ctx, 20, 10, 4, css([0.40, 0.60, 0.90]));
  circle(ctx, 24, 6, 4, css([0.45, 0.65, 0.92]));
  circle(ctx, 28, 9, 4, css([0.38, 0.58, 0.88]));
}

/** Mushroom — cap on stubby stem. */
function drawMushroom(ctx: Ctx, c: C3): void {
  rrect(ctx, 20, 28, 8, 12, css([0.82, 0.78, 0.70])); // stem
  // Cap
  ctx.beginPath();
  ctx.arc(24, 26, 13, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = css(c);
  ctx.fill();
  outline(ctx);
  // Spots
  circle(ctx, 20, 22, 2.5, css([0.95, 0.92, 0.88]));
  circle(ctx, 28, 20, 2, css([0.95, 0.92, 0.88]));
  circle(ctx, 24, 26, 1.5, css([0.95, 0.92, 0.88]));
}

/** Coal lump — dark jagged chunk. */
function drawCoal(ctx: Ctx, c: C3): void {
  poly(ctx, [
    [14, 36], [9, 24], [16, 12], [28, 10],
    [38, 18], [36, 32], [26, 40],
  ], css(c));
  // Shiny facets
  poly(ctx, [[16, 12], [22, 18], [28, 10]], css(c, 2.0));
  poly(ctx, [[28, 10], [36, 16], [38, 18]], css(c, 1.6));
}

/** Fire starter — two sticks forming an X with spark. */
function drawFireStarter(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(Math.PI / 4);
  rrect(ctx, -2, -18, 4, 36, css(c));
  ctx.restore();
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 4);
  rrect(ctx, -2, -18, 4, 36, css(WOOD));
  ctx.restore();
  // Spark at crossing
  circle(ctx, 24, 24, 3.5, css([1.0, 0.85, 0.30]));
}

/** Torch — stick with flame. */
function drawTorch(ctx: Ctx, c: C3): void {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 10);
  rrect(ctx, -2.5, 0, 5, 20, css(WOOD));              // handle
  rrect(ctx, -3.5, -10, 7, 12, css(c, 0.9));          // head wrap
  // Flame
  poly(ctx, [[0, -10], [-5, -20], [0, -28], [5, -20]], css([1.0, 0.72, 0.10]));
  poly(ctx, [[0, -12], [-2, -20], [0, -25], [2, -20]], css([1.0, 0.95, 0.55]));
  ctx.restore();
}

/** Campfire kit — logs in a pile with kindling. */
function drawCampfireKit(ctx: Ctx, c: C3): void {
  // Base logs
  ctx.save();
  ctx.translate(24, 30);
  ctx.rotate(Math.PI / 6);
  rrect(ctx, -14, -3, 28, 6, css(c));
  ctx.restore();
  ctx.save();
  ctx.translate(24, 30);
  ctx.rotate(-Math.PI / 6);
  rrect(ctx, -14, -3, 28, 6, css(c, 0.85));
  ctx.restore();
  // Coal/kindling top
  rrect(ctx, 20, 20, 8, 8, css([0.22, 0.22, 0.24]));
  // Small flame
  poly(ctx, [[24, 20], [20, 13], [24, 8], [28, 13]], css([1.0, 0.72, 0.10]));
}

/** Tent — triangular silhouette with door flap. */
function drawTent(ctx: Ctx, c: C3): void {
  // Main tent body
  poly(ctx, [[8, 38], [24, 8], [40, 38]], css(c));
  // Door flap (slightly darker)
  poly(ctx, [[24, 38], [20, 30], [24, 18], [28, 30]], css(c, 0.75));
  // Ground pegs
  rrect(ctx, 10, 36, 4, 5, css(WOOD));
  rrect(ctx, 34, 36, 4, 5, css(WOOD));
}

/** Cooking pot — dark cauldron shape. */
function drawCookingPot(ctx: Ctx, c: C3): void {
  // Handles
  rrect(ctx, 8, 20, 8, 5, css(METAL_DARK));
  rrect(ctx, 32, 20, 8, 5, css(METAL_DARK));
  // Body
  poly(ctx, [[12, 20], [36, 20], [38, 38], [10, 38]], css(c));
  // Rim
  rrect(ctx, 10, 16, 28, 6, css(c, 0.8));
  // Bubble in lid (open pot)
  circle(ctx, 24, 20, 3, css([0.55, 0.75, 0.85]));
}

/** Armor piece: hood/cap (head slot) with visor hint. */
function drawArmorHead(ctx: Ctx, c: C3): void {
  // Dome
  ctx.beginPath();
  ctx.arc(24, 26, 14, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = css(c);
  ctx.fill();
  outline(ctx);
  // Brim
  rrect(ctx, 10, 26, 28, 5, css(c, 0.85));
  // Face guard / visor slot
  rrect(ctx, 17, 22, 14, 5, css(c, 0.65));
}

/** Armor piece: chest/tunic (body slot). */
function drawArmorBody(ctx: Ctx, c: C3): void {
  // Shoulder pauldrons
  rrect(ctx, 8, 12, 10, 8, css(c, 0.9));
  rrect(ctx, 30, 12, 10, 8, css(c, 0.9));
  // Chest plate
  poly(ctx, [[12, 18], [36, 18], [38, 40], [10, 40]], css(c));
  // Center line
  ctx.beginPath();
  ctx.moveTo(24, 18);
  ctx.lineTo(24, 40);
  ctx.strokeStyle = css(c, 0.6);
  ctx.lineWidth = 1;
  ctx.stroke();
  // Neckline
  ctx.beginPath();
  ctx.arc(24, 18, 6, Math.PI, 0);
  ctx.strokeStyle = css(c, 0.7);
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Armor piece: leggings (legs slot). */
function drawArmorLegs(ctx: Ctx, c: C3): void {
  // Belt
  rrect(ctx, 10, 10, 28, 6, css(c, 0.8));
  // Left leg
  poly(ctx, [[10, 16], [22, 16], [22, 42], [10, 42]], css(c));
  // Right leg
  poly(ctx, [[26, 16], [38, 16], [38, 42], [26, 42]], css(c));
  // Knee guard hints
  rrect(ctx, 12, 24, 8, 5, css(c, 1.1));
  rrect(ctx, 28, 24, 8, 5, css(c, 1.1));
}

/** Potion bottle — classic round-bottom with stopper, tinted by effect color. */
function drawPotion(ctx: Ctx, bodyC: C3, glintC: C3): void {
  rrect(ctx, 21, 7, 6, 5, css([0.48, 0.38, 0.28]));   // stopper
  rrect(ctx, 22, 12, 4, 5, css([0.42, 0.35, 0.25]));  // neck
  ctx.beginPath();
  ctx.arc(24, 30, 13, 0, Math.PI * 2);
  ctx.fillStyle = css(bodyC);
  ctx.fill();
  outline(ctx);
  // Glint
  ctx.beginPath();
  ctx.ellipse(20, 24, 3, 5, -0.4, 0, Math.PI * 2);
  ctx.fillStyle = css(glintC, 1.4);
  ctx.fill();
}

/** Stew bowl — bowl with chunky contents. */
function drawStew(ctx: Ctx, c: C3): void {
  // Contents (meat + veg) above bowl rim
  circle(ctx, 18, 20, 5, css([0.65, 0.30, 0.18]));
  circle(ctx, 28, 19, 5, css([0.45, 0.60, 0.25]));
  circle(ctx, 23, 17, 5, css(c, 1.1));
  // Bowl
  ctx.beginPath();
  ctx.arc(24, 26, 14, 0, Math.PI);
  ctx.closePath();
  ctx.fillStyle = css([0.32, 0.28, 0.22]);
  ctx.fill();
  outline(ctx);
  // Rim highlight
  rrect(ctx, 10, 24, 28, 3, css([0.42, 0.38, 0.32]));
}

// --- registry: id → draw function map ---------------------------------------

/**
 * Maps every GameItemId to its draw function.
 * Exported so node-side tests can verify coverage without a canvas.
 * draw(ctx, id) remains the internal caller.
 */
export const ICON_DRAWERS: Record<GameItemId, (ctx: Ctx) => void> = {
  // Director loot
  gold_small:    (ctx) => { drawCoins(ctx, [0.85, 0.68, 0.21], false); },
  gold_large:    (ctx) => { drawCoins(ctx, [0.92, 0.75, 0.25], true); },
  healing_herb:  (ctx) => { drawHerb(ctx, [0.35, 0.65, 0.30]); },
  ancient_relic: (ctx) => { drawGem(ctx, [0.55, 0.45, 0.75]); },
  torch_oil:     (ctx) => { drawFlask(ctx, [0.75, 0.58, 0.22]); },
  old_bone:      (ctx) => { drawBone(ctx, [0.85, 0.82, 0.72]); },
  rusty_key:     (ctx) => { drawKey(ctx, [0.55, 0.38, 0.25]); },
  iron_sword:    (ctx) => { drawSword(ctx, [0.70, 0.72, 0.76]); },
  iron_axe:      (ctx) => { drawAxe(ctx, [0.66, 0.68, 0.72]); },
  hunter_bow:    (ctx) => { drawBow(ctx, [0.48, 0.34, 0.20]); },
  oak_staff:     (ctx) => { drawStaff(ctx, [0.52, 0.38, 0.22]); },

  // Spawn-kit tools
  bronze_axe:     (ctx) => { drawAxe(ctx, [0.72, 0.50, 0.30]); },
  bronze_pickaxe: (ctx) => { drawPickaxe(ctx, [0.70, 0.48, 0.28]); },
  iron_pickaxe:   (ctx) => { drawPickaxe(ctx, [0.66, 0.68, 0.72]); },

  // Gathered materials
  logs:    (ctx) => { drawLogs(ctx, [0.45, 0.31, 0.18]); },
  stone:   (ctx) => { drawStone(ctx, [0.55, 0.54, 0.56]); },
  ore:     (ctx) => { drawOreChunk(ctx, [0.45, 0.42, 0.44], [0.68, 0.50, 0.32]); },
  berries: (ctx) => { drawBerries(ctx, [0.60, 0.15, 0.25]); },

  // Crafted (legacy)
  meal: (ctx) => { drawMeal(ctx, [0.65, 0.2, 0.3]); },

  // Plants / gathered (Phase E)
  plant_fiber:  (ctx) => { drawFiber(ctx, [0.45, 0.60, 0.25]); },
  flax:         (ctx) => { drawFlax(ctx, [0.55, 0.70, 0.40]); },
  reeds:        (ctx) => { drawReeds(ctx, [0.50, 0.55, 0.25]); },
  gourd:        (ctx) => { drawGourd(ctx, [0.55, 0.65, 0.20]); },
  cactus_flesh: (ctx) => { drawCactusFlesh(ctx, [0.35, 0.68, 0.35]); },
  warming_herb: (ctx) => { drawFlowerHerb(ctx, [0.60, 0.50, 0.22], [0.95, 0.60, 0.15]); },
  cooling_herb: (ctx) => { drawFlowerHerb(ctx, [0.30, 0.65, 0.60], [0.35, 0.75, 0.95]); },
  mushroom:     (ctx) => { drawMushroom(ctx, [0.72, 0.52, 0.35]); },

  // Ores / minerals
  coal:       (ctx) => { drawCoal(ctx, [0.20, 0.20, 0.22]); },
  copper_ore: (ctx) => { drawOreChunk(ctx, [0.50, 0.40, 0.35], [0.82, 0.48, 0.25]); },
  tin_ore:    (ctx) => { drawOreChunk(ctx, [0.52, 0.52, 0.48], [0.75, 0.75, 0.68]); },

  // Animal drops
  hide:            (ctx) => { drawHide(ctx, [0.58, 0.42, 0.28]); },
  wool:            (ctx) => { drawWool(ctx, [0.90, 0.88, 0.85]); },
  feather:         (ctx) => { drawFeather(ctx, [0.92, 0.90, 0.88]); },
  bone:            (ctx) => { drawBone(ctx, [0.88, 0.85, 0.75]); },
  meat_raw:        (ctx) => { drawMeat(ctx, [0.78, 0.30, 0.28], false); },
  egg_bird:        (ctx) => { drawEgg(ctx, [0.92, 0.88, 0.78]); },
  egg_dragon:      (ctx) => { drawEgg(ctx, [0.65, 0.20, 0.20]); },
  egg_griffin:     (ctx) => { drawEgg(ctx, [0.80, 0.72, 0.35]); },
  dragon_scale:    (ctx) => { drawDragonScale(ctx, [0.20, 0.55, 0.30]); },
  griffin_feather: (ctx) => { drawGriffinFeather(ctx, [0.88, 0.80, 0.45]); },

  // Processed materials
  sticks:       (ctx) => { drawArrowShaft(ctx, [0.48, 0.34, 0.20]); },
  planks:       (ctx) => { drawPlanks(ctx, [0.62, 0.46, 0.28]); },
  thread:       (ctx) => { drawThread(ctx, [0.85, 0.82, 0.78]); },
  bow_string:   (ctx) => { drawBowString(ctx, [0.88, 0.85, 0.80]); },
  rope:         (ctx) => { drawRope(ctx, [0.62, 0.52, 0.35]); },
  arrow_shaft:  (ctx) => { drawArrowShaft(ctx, [0.52, 0.38, 0.22]); },
  copper_ingot: (ctx) => { drawIngot(ctx, [0.75, 0.42, 0.22]); },
  tin_ingot:    (ctx) => { drawIngot(ctx, [0.68, 0.68, 0.62]); },
  bronze_ingot: (ctx) => { drawIngot(ctx, [0.72, 0.50, 0.28]); },
  iron_ingot:   (ctx) => { drawIngot(ctx, [0.68, 0.70, 0.74]); },
  leather:      (ctx) => { drawLeather(ctx, [0.55, 0.38, 0.22]); },
  wool_yarn:    (ctx) => { drawWoolYarn(ctx, [0.88, 0.85, 0.82]); },
  bone_needle:  (ctx) => { drawBoneNeedle(ctx, [0.90, 0.88, 0.78]); },
  meat_cooked:  (ctx) => { drawMeat(ctx, [0.65, 0.35, 0.18], true); },

  // Containers
  gourd_bottle: (ctx) => { drawBottle(ctx, [0.55, 0.65, 0.20], [0.35, 0.60, 0.75]); },
  gourd_bowl:   (ctx) => { drawBottle(ctx, [0.52, 0.62, 0.18], null); },
  waterskin:    (ctx) => { drawWaterskin(ctx, [0.52, 0.36, 0.20]); },
  iron_flask:   (ctx) => { drawMetalFlask(ctx, [0.66, 0.68, 0.72]); },
  cooking_pot:  (ctx) => { drawCookingPot(ctx, [0.30, 0.30, 0.32]); },

  // Full containers (Phase H) — blue-tinted variants of the empties
  gourd_bottle_full: (ctx) => { drawBottle(ctx, [0.35, 0.55, 0.72], [0.45, 0.75, 0.95]); },
  waterskin_full:    (ctx) => { drawWaterskin(ctx, [0.32, 0.50, 0.68]); },
  iron_flask_full:   (ctx) => { drawMetalFlask(ctx, [0.40, 0.55, 0.78]); },

  // Fire / shelter
  fire_starter: (ctx) => { drawFireStarter(ctx, [0.55, 0.38, 0.22]); },
  torch:        (ctx) => { drawTorch(ctx, [0.75, 0.55, 0.20]); },
  campfire_kit: (ctx) => { drawCampfireKit(ctx, [0.45, 0.31, 0.18]); },
  fiber_tent:   (ctx) => { drawTent(ctx, [0.55, 0.60, 0.40]); },
  wool_tent:    (ctx) => { drawTent(ctx, [0.75, 0.72, 0.65]); },
  hide_tent:    (ctx) => { drawTent(ctx, [0.58, 0.42, 0.28]); },

  // Weapons (Phase E)
  arrow:        (ctx) => { drawArrow(ctx, [0.55, 0.54, 0.56]); },
  bronze_sword: (ctx) => { drawSword(ctx, [0.72, 0.50, 0.28]); },
  spear:        (ctx) => { drawStaff(ctx, [0.60, 0.45, 0.25]); },
  composite_bow:(ctx) => { drawBow(ctx, [0.42, 0.30, 0.18]); },

  // Armor: fiber tier
  fiber_hood:     (ctx) => { drawArmorHead(ctx, [0.55, 0.60, 0.40]); },
  fiber_tunic:    (ctx) => { drawArmorBody(ctx, [0.52, 0.58, 0.38]); },
  fiber_leggings: (ctx) => { drawArmorLegs(ctx, [0.50, 0.56, 0.36]); },

  // Armor: leather tier
  leather_cap:      (ctx) => { drawArmorHead(ctx, [0.55, 0.38, 0.22]); },
  leather_tunic:    (ctx) => { drawArmorBody(ctx, [0.52, 0.36, 0.20]); },
  leather_leggings: (ctx) => { drawArmorLegs(ctx, [0.50, 0.34, 0.18]); },

  // Armor: iron tier
  iron_helm:  (ctx) => { drawArmorHead(ctx, [0.68, 0.70, 0.74]); },
  iron_chest: (ctx) => { drawArmorBody(ctx, [0.66, 0.68, 0.72]); },
  iron_legs:  (ctx) => { drawArmorLegs(ctx, [0.65, 0.67, 0.71]); },

  // Consumables with effectClass
  healing_potion: (ctx) => { drawPotion(ctx, [0.75, 0.20, 0.25], [1.0, 0.60, 0.65]); },
  warming_potion: (ctx) => { drawPotion(ctx, [0.85, 0.45, 0.15], [1.0, 0.80, 0.50]); },
  cooling_potion: (ctx) => { drawPotion(ctx, [0.25, 0.60, 0.85], [0.55, 0.90, 1.0]); },
  stamina_potion: (ctx) => { drawPotion(ctx, [0.30, 0.75, 0.40], [0.60, 1.0, 0.70]); },
  hearty_stew:    (ctx) => { drawStew(ctx, [0.65, 0.35, 0.18]); },
};

/** True if the id has an explicit icon drawer (useful for node-side tests). */
export function hasIcon(id: GameItemId): boolean {
  return Object.prototype.hasOwnProperty.call(ICON_DRAWERS, id);
}

// Keep the internal draw function using the map
function draw(ctx: Ctx, id: GameItemId): void {
  const fn = ICON_DRAWERS[id];
  if (fn !== undefined) {
    fn(ctx);
  } else {
    // Deliberate fallback: draw the item's def color as a gem (should never
    // be reached now that every id has an explicit entry above).
    drawGem(ctx, itemDef(id).color);
  }
}

/** Data URL for the item's pictogram (drawn once, cached). */
export function itemIcon(id: GameItemId): string {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return '';
  draw(ctx, id);
  const url = canvas.toDataURL();
  cache.set(id, url);
  return url;
}
