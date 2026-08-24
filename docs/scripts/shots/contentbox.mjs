// Derive a callout rect from a capture instead of eyeballing one.
//
//   node scripts/shots/contentbox.mjs <capture.png> --band <y0>:<y1> [options]
//
//     --band  y0:y1     rows to measure (required)
//     --pad   N         clearance around the content, default 20
//     --scan  minX:maxX restrict the content MEASUREMENT (not the output rect)
//     --anchor N        pin the frame's left edge to this x; the pad is then implied
//
// Prints the tight content box and a rect ready to pass to Save-ClientShot -Callout.
//
// Why this exists: the callout rects in the first generation of assets were drawn freehand, so
// they varied and had to be re-guessed whenever the app's layout moved (it did move between 1.0.0
// and 1.1.2 -- labels shortened, the Comments columns swapped). Deriving the box from the pixels
// makes a re-shoot mechanical.
//
// Three rules the output obeys, all of which were broken at some point:
//
//  1. Left and right clearance are EQUAL. The first version clamped the right edge to --scan, so
//     any group whose content reached the scan limit silently lost its right pad while keeping the
//     full left one -- the frame then sat on the row's action buttons and looked shifted left.
//     --scan bounds the measurement only; it must never constrain the output.
//  2. Every frame on a tab starts at the same x, whatever its width -- that is what --anchor is
//     for. Deriving the left edge per figure put `present-on` on 475 and its six siblings on 474,
//     because the PRESENT ON label's first glyph starts a pixel right of the inputs below it.
//  3. The frame may cross the scrollbar lane. It is empty space, and treating it as a boundary is
//     what created problem 1.
import sharp from 'sharp';

const argv = process.argv.slice(2);
const file = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};
const band = flag('band');
if (!file || !band) {
  console.error('usage: contentbox.mjs <capture.png> --band y0:y1 [--pad N] [--scan minX:maxX] [--anchor N]');
  process.exit(2);
}
const [y0, y1] = band.split(':').map(Number);
const pad = Number(flag('pad', 20));
const [scanMin, scanMax] = (flag('scan', '') || ':').split(':');
const anchorRaw = flag('anchor');

const img = sharp(file);
const { width: W, height: H } = await img.metadata();
const raw = await img.ensureAlpha().raw().toBuffer();
const minX = Math.max(0, Number(scanMin || 0));
const maxX = Math.min(W - 1, Number(scanMax || W - 1));

// Background = the most common colour in the band's LEFT GUTTER, not the whole band. Sampling the
// whole band picks the wrong colour whenever a band is dominated by cards rather than page (the
// DB-templates group is a stack of them, and reported its card fill as "background", which made
// every actual background pixel count as content and returned the full client width). The gutter
// left of the panel's content inset is always page background. Taking it from the image rather
// than a hardcoded token keeps this working on either theme and on a scrimmed dialog capture.
const GUTTER = 8;
const hist = new Map();
for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
  for (let x = 0; x < GUTTER; x++) {
    const i = (y * W + x) * 4;
    const k = `${raw[i]},${raw[i + 1]},${raw[i + 2]}`;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
}
const bg = [...hist].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);

let x0 = 1e9, x1 = -1, ty0 = 1e9, ty1 = -1;
for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
  for (let x = minX; x <= maxX; x++) {
    const i = (y * W + x) * 4;
    // Tolerance swallows the antialiasing halo around glyphs, which otherwise reports a box a
    // pixel or two wider than the text actually reads.
    if (Math.abs(raw[i] - bg[0]) <= 6 && Math.abs(raw[i + 1] - bg[1]) <= 6 && Math.abs(raw[i + 2] - bg[2]) <= 6) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < ty0) ty0 = y;
    if (y > ty1) ty1 = y;
  }
}
if (x1 < 0) {
  console.log(`no content in rows ${y0}..${y1} (bg ${bg.join(',')})`);
  process.exit(0);
}

// An anchor pins the left edge, so the pad it implies is what the right edge must use too --
// that is what keeps the two sides symmetric AND every frame on the tab aligned.
const cx = anchorRaw === undefined ? x0 - pad : Number(anchorRaw);
const padEff = x0 - cx;
const cw = x1 + padEff - cx;
const cy = ty0 - padEff;
const ch = ty1 + padEff - cy;

console.log(`bg ${bg.join(',')}`);
console.log(`content  x ${x0}..${x1}   y ${ty0}..${ty1}   (${x1 - x0 + 1}x${ty1 - ty0 + 1})`);
console.log(`pad ${padEff}${anchorRaw === undefined ? '' : ` (implied by --anchor ${cx})`}` +
  `   clearance left ${x0 - (cx + 4)}px, right ${cx + cw - 3 - 1 - x1}px`);
if (cx < 0 || cx + cw > W - 1) console.log(`WARNING: rect runs outside the image (0..${W - 1})`);
console.log(`-Callout ${cx},${cy},${cw},${ch}`);
