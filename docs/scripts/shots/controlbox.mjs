// Find the INNER rect of the control (text input, textarea) containing a probe point.
//
//   node scripts/shots/controlbox.mjs <capture.png> <x> <y> [inset]
//
// Prints the control's inner rect and a redaction rect inset from it, for Save-ClientShot -Redact.
//
// Why this exists: redaction rects were sized by eye in round 1, and three of them overhung the
// input's bottom border by 4-8px -- the pixelation then painted over the field's own frame, which
// reads as a smudge sitting on the control rather than inside it. The control's fill is a single
// flat colour, so walking out from a probe point until the fill ends gives the exact inner box.
//
// Probe somewhere inside the control but clear of its TEXT -- a few px right of the left border is
// reliable. A probe that lands on a glyph reports a one-pixel-tall box, which the output makes
// obvious rather than silently returning something plausible.
import sharp from 'sharp';

const [file, xs, ys, insets] = process.argv.slice(2);
if (!file || xs === undefined || ys === undefined) {
  console.error('usage: controlbox.mjs <capture.png> <x> <y> [inset]');
  process.exit(2);
}
const px = Number(xs), py = Number(ys), inset = Number(insets ?? 2);

const img = sharp(file);
const { width: W, height: H } = await img.metadata();
const raw = await img.ensureAlpha().raw().toBuffer();
const at = (x, y) => {
  const i = (y * W + x) * 4;
  return [raw[i], raw[i + 1], raw[i + 2]];
};
const fill = at(px, py);
// Exact match, not a tolerance: the control's fill is flat, while its border and any glyph
// antialiasing are not. A tolerance would leak across a low-contrast border in the dark theme.
const same = (x, y) => {
  const c = at(x, y);
  return c[0] === fill[0] && c[1] === fill[1] && c[2] === fill[2];
};

let left = px, right = px, top = py, bottom = py;
while (left > 0 && same(left - 1, py)) left--;
while (right < W - 1 && same(right + 1, py)) right++;
while (top > 0 && same(px, top - 1)) top--;
while (bottom < H - 1 && same(px, bottom + 1)) bottom++;

const w = right - left + 1, h = bottom - top + 1;
console.log(`fill ${fill.join(',')}`);
console.log(`control inner  x ${left}..${right}   y ${top}..${bottom}   (${w}x${h})`);
if (h < 10 || w < 10) {
  console.log('WARNING: box is tiny — the probe probably landed on text or a border, not the fill');
}
console.log(`-Redact @(${left + inset},${top + inset},${w - inset * 2},${h - inset * 2})   (inset ${inset})`);
