/**
 * crop.mjs - cut a unit's pictures out of the book scan.
 *
 *   node _source/crop.mjs --unit 2 [--src "<folder holding the unit PDFs>"]
 *   node _source/crop.mjs --all
 *
 * Reads  _source/units/unitNN/crops.json
 * Writes _source/units/unitNN/crops/*.png
 *
 * Needs pdftoppm (poppler). Everything after the render is pure Node via
 * pngcrop.mjs — this machine has no ImageMagick.
 *
 * Two guards, both from crops.json:
 *   avoid  - a crop overlapping a pirate watermark is an error, not a warning
 *   patch  - a watermark sitting on artwork the exercise needs is painted out
 *            with the median colour of the ring around it, before cropping
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPNG, cropImage, scaleImage, writePNG } from './pngcrop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && next.indexOf('--') !== 0 ? next : true;
}

const src = arg('src', process.env.INTERCHANGE_DIR ||
  'G:/My Drive/Classroom/Interchange/Interchange Intro');
const pad = (n) => String(n).padStart(2, '0');

function unitsToCut() {
  if (arg('all', false)) {
    return fs.readdirSync(path.join(HERE, 'units'))
      .filter((d) => /^unit\d\d$/.test(d))
      .filter((d) => fs.existsSync(path.join(HERE, 'units', d, 'crops.json')))
      .map((d) => Number(d.slice(4))).sort((a, b) => a - b);
  }
  const u = arg('unit', null);
  if (!u) { console.error('crop: pass --unit N or --all'); process.exit(2); }
  return [Number(u)];
}

if (spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' }).error) {
  console.error('crop: pdftoppm not found on PATH (install poppler-utils).');
  process.exit(2);
}
const hasFfmpeg = !spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).error;
if (!hasFfmpeg) {
  console.warn('  note  ffmpeg not found — keeping PNG only. Photographs will be');
  console.warn('        several times larger than they need to be.');
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function ringMedian(img, r) {
  const c = img.channels;
  const px = [];
  const take = (x, y) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * c;
    px.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
  };
  for (let x = r.x - 2; x < r.x + r.w + 2; x++) { take(x, r.y - 2); take(x, r.y + r.h + 1); }
  for (let y = r.y - 2; y < r.y + r.h + 2; y++) { take(r.x - 2, y); take(r.x + r.w + 1, y); }
  if (!px.length) return [255, 255, 255];
  const mid = (i) => {
    const v = px.map((p) => p[i]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return [mid(0), mid(1), mid(2)];
}

function paint(img, r, colour) {
  const c = img.channels;
  for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.w); x++) {
      const o = (y * img.width + x) * c;
      img.data[o] = colour[0]; img.data[o + 1] = colour[1]; img.data[o + 2] = colour[2];
    }
  }
}

let failures = 0;

for (const unit of unitsToCut()) {
  const dir = path.join(HERE, 'units', 'unit' + pad(unit));
  const specFile = path.join(dir, 'crops.json');
  if (!fs.existsSync(specFile)) {
    console.error('crop: unit ' + unit + ' has no crops.json yet');
    failures++;
    continue;
  }
  const SPEC = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const pdf = path.join(src, SPEC.pdf);
  if (!fs.existsSync(pdf)) {
    console.error('crop: cannot find ' + pdf);
    failures++;
    continue;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-crop-'));
  const render = spawnSync('pdftoppm',
    ['-png', '-r', String(SPEC.render.dpi), pdf, path.join(work, 'p')], { encoding: 'utf8' });
  if (render.status !== 0) {
    console.error('crop: pdftoppm failed on ' + SPEC.pdf);
    failures++;
    fs.rmSync(work, { recursive: true, force: true });
    continue;
  }

  const outDir = path.join(dir, 'crops');
  fs.mkdirSync(outDir, { recursive: true });

  const pages = new Map();
  const page = (n) => {
    if (pages.has(n)) return pages.get(n);
    const file = fs.readdirSync(work).find((f) => new RegExp('^p-0*' + n + '\\.png$').test(f));
    if (!file) throw new Error('no rendered page ' + n);
    const img = readPNG(path.join(work, file));
    if (img.width !== SPEC.render.width || img.height !== SPEC.render.height) {
      throw new Error('page ' + n + ' rendered ' + img.width + 'x' + img.height +
        ' but crops.json was measured against ' + SPEC.render.width + 'x' + SPEC.render.height);
    }
    for (const p of (SPEC.patch || []).filter((q) => q.page === n)) {
      paint(img, p, ringMedian(img, p));
      console.log('  patched  page ' + n + '  ' + p.note);
    }
    pages.set(n, img);
    return img;
  };

  /**
   * Book scans are photographs, and PNG is a bad way to store a photograph.
   * With ffmpeg available, write a JPEG too and keep whichever file is
   * smaller — line art and text panels stay PNG, photos become JPEG.
   */
  function maybeJpeg(pngPath) {
    if (!hasFfmpeg) return fs.statSync(pngPath).size;
    const jpgPath = pngPath.replace(/\.png$/, '.jpg');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', pngPath, '-q:v', '3', jpgPath], { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(jpgPath)) return fs.statSync(pngPath).size;
    const pngSize = fs.statSync(pngPath).size;
    const jpgSize = fs.statSync(jpgPath).size;
    if (jpgSize < pngSize) {
      fs.rmSync(pngPath);
      return jpgSize;
    }
    fs.rmSync(jpgPath);
    return pngSize;
  }

  let bytes = 0;
  let cut = 0;
  for (const c of SPEC.crops) {
    const guards = (SPEC.avoid || []).filter((a) => a.page === 0 || a.page === c.page);
    const clash = guards.find((g) => overlaps(c, g));
    if (clash) {
      console.error('  FAIL  ' + c.id + ' overlaps a watermark -> ' + clash.note);
      failures++;
      continue;
    }
    let img;
    try { img = page(c.page); } catch (err) {
      console.error('  FAIL  ' + c.id + ': ' + err.message);
      failures++;
      continue;
    }
    const pngPath = path.join(outDir, c.id + '.png');
    const jpgPath = pngPath.replace(/\.png$/, '.jpg');
    if (fs.existsSync(jpgPath)) fs.rmSync(jpgPath);   /* stale pick from a previous run */
    writePNG(pngPath, scaleImage(cropImage(img, c.x, c.y, c.w, c.h), SPEC.maxWidth || 900));
    bytes += maybeJpeg(pngPath);
    cut++;
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log('unit ' + pad(unit) + '  ' + cut + ' image(s), ' + Math.round(bytes / 1024) + ' kB');
}

process.exit(failures ? 1 : 0);
