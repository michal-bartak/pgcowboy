// Re-encode the captured PNGs smaller, losslessly.
//
//   node scripts/shots/optimize.mjs [--dry]
//
// System.Drawing writes a lazily-deflated PNG, so the assets land ~15-20% larger than the same
// pixels need. This re-encodes them with libvips at full effort. It cannot be folded into
// capture.ps1 -- System.Drawing exposes no PNG compression setting at all.
//
// Every file is verified PIXEL-IDENTICAL before it is replaced. Palette quantisation would halve
// the size again, but it does alter pixels (measured max delta 18-33), and banding in the dark
// theme's flat fills is not worth it for a docs image -- if that ever changes, here is where it
// would go, behind the same identity check made non-fatal.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = join(DOCS, 'src/assets');
const DRY = process.argv.includes('--dry');

// Drive the list from the manifest, not from a directory scan. Scanning also picked up a stray
// hand-made file sitting in the assets folder and rewrote it -- harmless here, but this script
// should only ever touch files the docs actually reference.
const manifest = JSON.parse(readFileSync(join(DOCS, 'scripts/shots/shots.json'), 'utf8'));
const files = [];
for (const fig of manifest.figures) {
  for (const theme of ['light', 'dark']) {
    const f = join(ASSETS, fig.dir, `${fig.name}-${theme}.png`);
    if (existsSync(f)) files.push(f);
  }
}

let before = 0, after = 0, changed = 0, failed = 0;
for (const file of files) {
  const origSize = statSync(file).size;
  before += origSize;
  const origPixels = await sharp(file).ensureAlpha().raw().toBuffer();

  const buf = await sharp(file).png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer();
  // Compare through ensureAlpha on BOTH sides: a raw() compare against an encoder that dropped a
  // fully-opaque alpha channel misaligns the buffers and reports millions of bogus differences.
  const newPixels = await sharp(buf).ensureAlpha().raw().toBuffer();

  const rel = file.slice(ASSETS.length + 1).replace(/\\/g, '/');
  if (Buffer.compare(origPixels, newPixels) !== 0) {
    console.log(`  SKIP  ${rel} — re-encode is not pixel-identical, left untouched`);
    failed++;
    after += origSize;
    continue;
  }
  if (buf.length >= origSize) {
    after += origSize;
    continue;
  }
  if (!DRY) writeFileSync(file, buf);
  after += buf.length;
  changed++;
  const pct = (100 - (buf.length / origSize) * 100).toFixed(0);
  console.log(`  ok    ${rel}  ${(origSize / 1024).toFixed(0)} → ${(buf.length / 1024).toFixed(0)} kB  (-${pct}%)`);
}

const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`\n${changed}/${files.length} re-encoded${DRY ? ' (dry run, nothing written)' : ''}` +
  `   ${mb(before)} → ${mb(after)} MB  (-${(100 - (after / before) * 100).toFixed(1)}%)`);
if (failed) {
  console.log(`${failed} file(s) skipped as not pixel-identical`);
  process.exit(1);
}
