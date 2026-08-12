/**
 * import-audio.mjs - pull the Interchange Intro CDs into _source/audio/unitNN.
 *
 *   node _source/import-audio.mjs --src "<.../Interchange Audio/Interchange Intro>" [--units 1,2,3]
 *
 * CD 1 filenames carry unit, page and exercise and parse with one regex. CD 2
 * and CD 3 are page-keyed only (p36-1.mp3, and the split variant p37-4A.mp3),
 * so those need PAGE_TO_UNIT below. At least one CD 1 track merges two
 * exercises into a single file, so the mapping is one file -> many exercise
 * keys, never one file -> one exercise.
 *
 * Re-encodes to 48 kbps mono when ffmpeg is on PATH; otherwise copies the
 * source files and says so loudly. Also writes tracks.json per unit, which is
 * the list an author works from when writing that unit's worksheet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Parts run A, B and — once, on Unit 2 Ex 4 — C. Anchoring on [AB] silently
   folded "Pt C" into the title and produced p009-ex04-pronunciation-pt-c.mp3. */
const CD1 = /^(\d+) Unit (\d+) Pg (\d+) Ex (\d+) (.+?)(?: Pt ([A-D]))?\.mp3$/;
const MERGED = /Unit (\d+) Pg (\d+) Ex (\d+) ([^.]+?)(?: Pt ([A-D]))?$/;
const CD23 = /^p(\d+)-(\d+)([ABab])?\.mp3$/;

/* Each unit is six pages; the gaps are Progress checks, which ship with the
   unit before them. Confirmed against the book: unit n starts at the page in
   START[n] and PDF page = book page + 8. */
const RANGES = [
  [2, 7, 1], [8, 15, 2], [16, 21, 3], [22, 29, 4], [30, 35, 5], [36, 43, 6],
  [44, 49, 7], [50, 57, 8], [58, 63, 9], [64, 71, 10], [72, 77, 11], [78, 85, 12],
  [86, 91, 13], [92, 99, 14], [100, 105, 15], [106, 113, 16]
];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && next.indexOf('--') !== 0 ? next : true;
}

const src = arg('src', process.env.INTERCHANGE_AUDIO ||
  'G:/My Drive/Classroom/Interchange/Interchange Audio/Interchange Intro');
const only = arg('units', null);
const wanted = only ? String(only).split(',').map(Number) : RANGES.map((r) => r[2]);
const bitrate = String(arg('bitrate', '48'));

if (!fs.existsSync(src)) {
  console.error('import-audio: cannot find ' + src);
  process.exit(2);
}

const hasFfmpeg = !spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).error;
if (!hasFfmpeg) {
  console.warn('');
  console.warn('  !! ffmpeg is not on PATH — copying the CD files unchanged.');
  console.warn('  !! Each worksheet will be roughly 8x larger than it needs to be.');
  console.warn('  !! Install ffmpeg and re-run to get 48 kbps mono.');
  console.warn('');
}

const pad = (n) => String(n).padStart(2, '0');
const unitOfPage = (p) => {
  const row = RANGES.find((r) => p >= r[0] && p <= r[1]);
  return row ? row[2] : null;
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function keysFor(name) {
  const m = CD1.exec(name);
  if (m) {
    const keys = [{
      unit: Number(m[2]), page: Number(m[3]), ex: Number(m[4]),
      title: m[5].trim(), part: m[6] || null
    }];
    const tail = MERGED.exec(m[5].trim());
    if (tail) {
      keys[0].title = m[5].slice(0, tail.index).trim();
      keys.push({
        unit: Number(tail[1]), page: Number(tail[2]), ex: Number(tail[3]),
        title: tail[4].trim(), part: tail[5] || null
      });
    }
    return keys;
  }
  const p = CD23.exec(name);
  if (p) {
    const page = Number(p[1]);
    const unit = unitOfPage(page);
    if (!unit) return [];
    return [{
      unit, page, ex: null, seq: Number(p[2]),
      title: 'Track ' + p[2], part: p[3] ? p[3].toUpperCase() : null
    }];
  }
  return [];
}

const discs = fs.readdirSync(src, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => path.join(src, d.name));

const byUnit = new Map();
const unparsed = [];
let copied = 0;

for (const disc of discs) {
  for (const name of fs.readdirSync(disc).filter((n) => n.toLowerCase().endsWith('.mp3'))) {
    const keys = keysFor(name);
    if (!keys.length) { unparsed.push(path.basename(disc) + '/' + name); continue; }
    const hits = keys.filter((k) => wanted.indexOf(k.unit) !== -1);
    if (!hits.length) continue;

    const k = hits[0];
    const outName = 'p' + String(k.page).padStart(3, '0') +
      (k.ex === null ? '-t' + k.seq : '-ex' + pad(k.ex)) +
      '-' + slug(k.title) + (k.part ? '-' + k.part.toLowerCase() : '') + '.mp3';

    const outDir = path.join(HERE, 'audio', 'unit' + pad(k.unit));
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, outName);
    const srcPath = path.join(disc, name);

    if (hasFfmpeg) {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-i', srcPath, '-ac', '1', '-b:a', bitrate + 'k', '-map_metadata', '-1', outPath],
        { encoding: 'utf8' });
      if (r.status !== 0) {
        console.error('import-audio: ffmpeg failed on ' + name);
        process.exit(1);
      }
    } else {
      fs.copyFileSync(srcPath, outPath);
    }
    copied++;

    if (!byUnit.has(k.unit)) byUnit.set(k.unit, []);
    byUnit.get(k.unit).push({
      file: outName, source: name, page: k.page,
      exercises: hits.map((h) => h.ex), title: hits.map((h) => h.title).join(' + '),
      part: k.part, merged: keys.length > 1, bytes: fs.statSync(outPath).size
    });
    if (keys.length > 1) {
      console.log('  merged track: ' + name);
      console.log('      -> ' + keys.map((x) => 'U' + x.unit + ' p' + x.page + ' Ex' + x.ex).join(' + '));
    }
  }
}

let total = 0;
for (const [unit, tracks] of [...byUnit.entries()].sort((a, b) => a[0] - b[0])) {
  tracks.sort((a, b) => a.file.localeCompare(b.file));
  const dir = path.join(HERE, 'audio', 'unit' + pad(unit));
  fs.writeFileSync(path.join(dir, 'tracks.json'),
    JSON.stringify({ unit, encoded: hasFfmpeg ? bitrate + 'k mono' : 'source copy', tracks }, null, 2) + '\n');
  const kb = tracks.reduce((n, t) => n + t.bytes, 0) / 1024;
  total += kb;
  console.log('unit ' + pad(unit) + '  ' + String(tracks.length).padStart(2) + ' tracks  ' +
    Math.round(kb).toString().padStart(6) + ' kB');
}

if (unparsed.length) {
  console.warn('\n' + unparsed.length + ' file(s) matched no naming rule (Progress-check review tracks');
  console.warn('named "Unit 01–02 PC …" with an en dash belong to no single unit and are skipped):');
  for (const u of unparsed) console.warn('  ' + u);
}
console.log('\nimport-audio: ' + copied + ' track(s), ' + Math.round(total / 1024) + ' MB total');
