// Verify the captured screenshots — the regression test for capture.ps1.
//
//   node scripts/shots/audit.mjs              audit every figure in shots.json
//   node scripts/shots/audit.mjs <file.png>   audit one arbitrary file (probe captures)
//
// Six things are checked. Every one of them was actually wrong in a previous generation of the
// assets, which is the point -- each rule exists because its absence let a defect ship:
//
//   size     Every full-window figure is exactly CANON, and each strip figure its declared crop.
//            The old assets came in six sizes because each was cropped by hand.
//   edges    Every perimeter pixel is --bg or --border for its theme (scrim-aware). The old dark shots
//            had a teal `0,28,37` last row -- desktop showing through the window rim, because the
//            crop rect overshot the client area. This is the check that keeps that from coming back.
//   callout  A figure declaring a callout contains exactly one connected run of #3DC46C, and one
//            not declaring it contains none.
//   clear    The callout's strokes keep a gap from the content, and the LEFT gap equals the RIGHT
//            one. Wide groups used to have 16px on the left and 0 or -7px on the right, so the
//            frame was drawn over the row's action buttons.
//   alignX   Every figure on a tab starts its callout at the same x. `present-on` sat on 475 while
//            its six siblings sat on 474.
//   inside   No page background within 2px of a redact rect, which means it stayed inside its
//            control. Three rects overhung the input's bottom border by 4-8px, so the pixelation
//            painted over the field's own frame.
//   noscroll No scrollbar thumb, unless the figure declares `scrolls`. The Operations figures
//            carried one because the window was ~24px too short for the content.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = join(DOCS, 'src/assets');

const CANON = { width: 1670, height: 1938 };
// What may legitimately appear on the client-rect perimeter, per theme: the window background
// (main.go BackgroundColour / the CSS --bg token) and --border, because the header/tab-bar and
// footer hairlines run the full width and so touch x=0 and x=W-1. Values read off styles.css.
const THEME = {
  light: { bg: [240, 242, 246], border: [212, 217, 227] },
  dark: { bg: [24, 26, 32], border: [52, 56, 68] },
};
// A figure with a dialog open dims the whole page behind a modal scrim, and a dialog opened FROM a
// dialog dims it twice -- so the perimeter is bg/border multiplied by some factor. Measured: one
// scrim is ~0.45, two ~0.20. Rather than allowlist each depth (brittle, and a third dialog would
// fail), the check derives the factor from the perimeter's own dominant colour and then requires
// every perimeter pixel to be bg or border at THAT SAME factor. A foreign colour -- the window rim
// catching the desktop, which is what put a teal 0,28,37 row in the old dark assets -- is not a
// scrimmed app token and so cannot satisfy it.
const EDGE_TOL = 3;

const CALLOUT = [61, 196, 108];

async function load(file) {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const raw = await img.ensureAlpha().raw().toBuffer();
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  return { width, height, raw, at };
}

/** Perimeter colours that are not the theme's bg/border at the image's own scrim factor.
 *  skipBottom excludes the last row, which for a CROPPED figure is an artificial slice through
 *  page content rather than the window's client edge -- the rule simply does not apply there. */
function edgeStrays({ width, height, at }, theme, skipBottom = false) {
  const { bg, border } = THEME[theme];
  const seen = new Map();
  const note = (x, y) => {
    const k = at(x, y).join(',');
    if (!seen.has(k)) seen.set(k, { n: 0, first: `${x},${y}` });
    seen.get(k).n++;
  };
  const lastRow = skipBottom ? height - 2 : height - 1;
  for (let x = 0; x < width; x++) { note(x, 0); if (!skipBottom) note(x, height - 1); }
  for (let y = 0; y <= lastRow; y++) { note(0, y); note(width - 1, y); }

  // The dominant perimeter colour is the (possibly scrimmed) background; take the scrim factor
  // from bg's largest channel, where rounding costs the least precision.
  const dominant = [...seen].sort((a, b) => b[1].n - a[1].n)[0][0].split(',').map(Number);
  const ch = bg.indexOf(Math.max(...bg));
  const k = bg[ch] === 0 ? 1 : dominant[ch] / bg[ch];
  const near = (c, want) => want.every((v, i) => Math.abs(c[i] - v * k) <= EDGE_TOL);

  const strays = new Map();
  for (const [key, v] of seen) {
    const c = key.split(',').map(Number);
    if (!near(c, bg) && !near(c, border)) strays.set(key, v);
  }
  strays.scrim = k;
  return strays;
}

/** Connected components of the exact callout green, as bounding boxes. */
function calloutRects({ width: W, height: H, raw }) {
  const hit = new Uint8Array(W * H);
  let any = 0;
  for (let k = 0, i = 0; k < W * H; k++, i += 4) {
    if (raw[i] === CALLOUT[0] && raw[i + 1] === CALLOUT[1] && raw[i + 2] === CALLOUT[2]) {
      hit[k] = 1;
      any++;
    }
  }
  if (!any) return [];
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let k = 0; k < W * H; k++) {
    if (!hit[k] || seen[k]) continue;
    const stack = [k];
    seen[k] = 1;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    while (stack.length) {
      const c = stack.pop();
      const x = c % W, y = (c - x) / W;
      n++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (const q of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1]) {
        if (q >= 0 && hit[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (n >= 400) out.push({ n, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}


/** Columns near the right edge that are non-background for most of the body: a scrollbar thumb. */
function scrollbarColumns({ width: W, height: H, at }, theme) {
  const { bg } = THEME[theme];
  const page = at(3, Math.floor(H / 3));
  const near = (c, w) => w.every((v, i) => Math.abs(c[i] - v) <= 6);
  const cols = [];
  for (let x = W - 60; x < W; x++) {
    let hits = 0, total = 0;
    for (let y = 200; y < H - 120; y += 4) {
      total++;
      if (!near(at(x, y), page)) hits++;
    }
    if (total && hits > total * 0.5) cols.push(x);
  }
  void bg;
  return cols;
}

/** Clearance in px between the callout's vertical strokes and the content they enclose.
 *
 *  Measured against the content's BOUNDING BOX across the whole frame, not a single row. A row-wise
 *  measurement is meaningless here: the Comments group's middle row has content only on its left,
 *  so the right-hand walk ran 982px through empty space and called the frame lopsided, while a
 *  Role-Details row reaches the stroke and reported 0. The bounding box is also what contentbox.mjs
 *  derives the rect from, so this checks the same thing the generator promised. */
function calloutClearance({ at }, [cx, cy, cw, ch], scrollbar = new Set()) {
  const STROKE = 4;
  const x0 = cx + STROKE, x1 = cx + cw - 1 - STROKE;
  const y0 = cy + STROKE, y1 = cy + ch - 1 - STROKE;
  const page = at(x0 + 1, y0 + 1);
  const isBg = (x, y) => at(x, y).every((v, i) => Math.abs(v - page[i]) <= 6);
  let left = 1e9, right = -1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // The frame is allowed to cross the scrollbar lane -- it is empty space, not content. Without
      // this the widest frames report 0 right-clearance against a bar they legitimately span.
      if (scrollbar.has(x)) continue;
      if (isBg(x, y)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < 0) return { left: 0, right: 0, empty: true };
  return { left: left - x0, right: x1 - right };
}

/** Does the ring just outside a redact rect touch the PAGE background?
 *
 *  Counting distinct colours there does not work: a domain-only blur starts mid-address, so the
 *  ring legitimately contains glyphs and reports dozens of colours while being perfectly contained.
 *  What actually distinguishes "inside the control" is that everything within a couple of pixels is
 *  still control fill or text -- never the page behind it. If the rect overhangs the control's
 *  border it destroys that border, and the page background shows up in the ring. */
function redactEscapes({ width: W, height: H, at }, [rx, ry, rw, rh], ring = 2) {
  const page = at(3, Math.min(H - 1, ry + Math.floor(rh / 2)));
  // Tolerance 2, not 4: a modal scrim multiplies every colour, which squeezes the distance between
  // the input's fill and the page behind it from ~9 to ~4 -- at tolerance 4 every dialog figure
  // reported hundreds of false escapes. A genuine overhang exposes the page colour exactly.
  const isPage = (c) => c.every((v, i) => Math.abs(v - page[i]) <= 2);
  let hits = 0;
  const check = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (isPage(at(x, y))) hits++;
  };
  for (let d = 1; d <= ring; d++) {
    for (let x = rx - d; x <= rx + rw - 1 + d; x++) { check(x, ry - d); check(x, ry + rh - 1 + d); }
    for (let y = ry - d; y <= ry + rh - 1 + d; y++) { check(rx - d, y); check(rx + rw - 1 + d, y); }
  }
  return hits;
}

const arg = process.argv[2];
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };

if (arg) {
  // Ad-hoc single file: infer the theme from the filename, or try both.
  const img = await load(arg);
  const theme = arg.includes('dark') ? 'dark' : 'light';
  console.log(`${arg}  ${img.width}x${img.height}  (as ${theme})`);
  const strays = edgeStrays(img, theme);
  if (strays.size === 0) console.log(`  edges  clean — --bg/--border at scrim ${strays.scrim.toFixed(3)}`);
  else for (const [c, v] of strays) console.log(`  edges  stray ${c} x${v.n} (first at ${v.first})`);
  for (const r of calloutRects(img)) console.log(`  callout  rect(${r.x},${r.y},${r.w}x${r.h})`);
  process.exit(strays.size ? 1 : 0);
}

const MIN_CLEARANCE = 3;   // px of background between stroke and content
const CLEARANCE_SKEW = 2;  // px the two sides may differ by (antialiasing, odd widths)
const RING_ESCAPES = 0;    // page-background pixels allowed in the ring outside a redaction

const manifest = JSON.parse(readFileSync(join(DOCS, 'scripts/shots/shots.json'), 'utf8'));
const anchors = new Map();  // dir -> the x every callout on that tab must share
for (const fig of manifest.figures) {
  if (fig.skip) continue;
  const expect = { width: CANON.width, height: fig.crop ?? CANON.height };
  for (const theme of ['light', 'dark']) {
    const rel = `${fig.dir}/${fig.name}-${theme}.png`;
    const file = join(ASSETS, rel);
    if (!existsSync(file)) { fail(`${rel} missing`); continue; }
    const img = await load(file);
    const notes = [];
    if (img.width !== expect.width || img.height !== expect.height) {
      fail(`${rel} is ${img.width}x${img.height}, want ${expect.width}x${expect.height}`);
      continue;
    }
    const strays = edgeStrays(img, theme, Boolean(fig.crop));
    if (strays.size) {
      const worst = [...strays].sort((a, b) => b[1].n - a[1].n)[0];
      fail(`${rel} edge bleed: ${strays.size} stray colour(s), worst ${worst[0]} x${worst[1].n} at ${worst[1].first}`);
    }
    const scrollbar = new Set(scrollbarColumns(img, theme));
    const rects = calloutRects(img);
    if (fig.callout) {
      if (rects.length !== 1) fail(`${rel} has ${rects.length} callout rect(s), want 1`);
      else {
        const [r] = rects;
        const [cx, cy, cw, ch] = fig.callout;
        if (r.x !== cx || r.y !== cy || r.w !== cw || r.h !== ch) {
          fail(`${rel} callout is (${r.x},${r.y},${r.w}x${r.h}), manifest says (${cx},${cy},${cw}x${ch})`);
        } else {
          const { left, right } = calloutClearance(img, fig.callout, scrollbar);
          if (left < MIN_CLEARANCE || right < MIN_CLEARANCE) {
            fail(`${rel} callout clearance ${left}/${right}px — the stroke is on the content`);
          } else if (Math.abs(left - right) > CLEARANCE_SKEW) {
            fail(`${rel} callout clearance is lopsided: ${left}px left vs ${right}px right`);
          } else notes.push(`callout ${r.w}x${r.h} clear ${left}/${right}`);
          const seenX = anchors.get(fig.dir);
          if (seenX === undefined) anchors.set(fig.dir, { x: cx, by: rel });
          else if (seenX.x !== cx) {
            fail(`${rel} callout starts at x=${cx}, but ${seenX.by} on the same tab starts at x=${seenX.x}`);
          }
        }
      }
    } else if (rects.length) {
      fail(`${rel} has an unexpected callout rect (${rects[0].x},${rects[0].y})`);
    }

    for (const r of fig.redact ?? []) {
      const escaped = redactEscapes(img, r);
      if (escaped > RING_ESCAPES) {
        fail(`${rel} redaction (${r.join(',')}) touches the page background at ${escaped} px — it overhangs its control`);
      }
    }

    if (!fig.scrolls && scrollbar.size >= 8) {
      const cols = [...scrollbar].sort((a, b) => a - b);
      fail(`${rel} shows a scrollbar at x ${cols[0]}..${cols[cols.length - 1]}`);
    }
    if (!strays.size) notes.unshift(`${img.width}x${img.height} edges clean`);
    console.log(`  ok    ${rel}  ${notes.join(', ')}`);
  }
}
console.log(failures ? `\n${failures} failure(s)` : '\nall figures pass');
process.exit(failures ? 1 : 0);
