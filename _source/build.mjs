/**
 * build.mjs - expand a unit's source into its shipping file.
 *
 *   node _source/build.mjs --unit 1
 *   node _source/build.mjs --all
 *
 * Reads   _source/units/unitNN/worksheet.html
 * Assets  _source/units/unitNN/crops/*.png  and  _source/audio/unitNN/*.mp3
 * Writes  unitNN.html   (one self-contained file, no network at runtime)
 *
 * Two macros:
 *   {{IMG:crop-id|alt text}}       -> <img src="data:image/png;base64,…">
 *   {{AUDIO:file.mp3|Track 1}}     -> a player block with the CD recording
 *
 * A macro naming an asset that is not on disk fails the build. Silence would
 * mean shipping a worksheet with a hole in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && next.indexOf('--') !== 0 ? next : true;
}

const pad = (n) => String(n).padStart(2, '0');

function unitsToBuild() {
  if (arg('all', false)) {
    return fs.readdirSync(path.join(HERE, 'units'))
      .filter((d) => /^unit\d\d$/.test(d))
      .filter((d) => fs.existsSync(path.join(HERE, 'units', d, 'worksheet.html')))
      .map((d) => Number(d.slice(4)))
      .sort((a, b) => a - b);
  }
  const u = arg('unit', null);
  if (!u) {
    console.error('build: pass --unit N or --all');
    process.exit(2);
  }
  return [Number(u)];
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
let anyFailure = false;

for (const unit of unitsToBuild()) {
  const dir = path.join(HERE, 'units', 'unit' + pad(unit));
  const srcFile = path.join(dir, 'worksheet.html');
  if (!fs.existsSync(srcFile)) {
    console.error('build: unit ' + unit + ' has no worksheet.html yet');
    anyFailure = true;
    continue;
  }

  const CROPS = path.join(dir, 'crops');
  const AUDIO = path.join(HERE, 'audio', 'unit' + pad(unit));
  let src = fs.readFileSync(srcFile, 'utf8');

  /**
   * A unit source is either a complete document (Units 1-2, written before the
   * template existed) or just its exercises, in which case unit.json supplies
   * the title and goals and template.html supplies the shared chrome. Keeping
   * both shapes means the early units never had to be re-typed.
   */
  if (src.indexOf('<!DOCTYPE') === -1) {
    const metaFile = path.join(dir, 'unit.json');
    if (!fs.existsSync(metaFile)) {
      console.error('build: unit ' + unit + ' is a fragment but has no unit.json');
      anyFailure = true;
      continue;
    }
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const goals = (meta.goals || []).map((g) =>
      '<span class="goal enonly">' + g.en + '</span>' +
      '<span class="goal zhonly" lang="zh-CN">' + g.zh + '</span>').join('\n      ');
    src = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8')
      .split('{{NUM}}').join(String(meta.number))
      .split('{{PAD}}').join(pad(meta.number))
      .split('{{TITLE_EN}}').join(meta.titleEn)
      .split('{{TITLE_ZH}}').join(meta.titleZh)
      .split('{{PAGES}}').join(meta.pages)
      .split('{{GPTAG}}').join(meta.grammarPlus ? ' &middot; Grammar plus p. ' + meta.grammarPlus : '')
      .split('{{GOALS}}').join(goals)
      .split('{{CONTENT}}').join(src);
  }

  const missing = [];
  const used = { img: new Set(), audio: new Set() };
  let imgBytes = 0;
  let audioBytes = 0;

  src = src.replace(/\{\{IMG:([^|}]+)\|([^}]*)\}\}/g, (m, id, alt) => {
    /* crop.mjs keeps whichever of PNG/JPEG came out smaller for this picture. */
    const png = path.join(CROPS, id.trim() + '.png');
    const jpg = path.join(CROPS, id.trim() + '.jpg');
    const file = fs.existsSync(png) ? png : (fs.existsSync(jpg) ? jpg : null);
    if (!file) {
      missing.push('image ' + id.trim());
      return m;
    }
    const buf = fs.readFileSync(file);
    imgBytes += buf.length;
    used.img.add(id.trim());
    const mime = file === png ? 'image/png' : 'image/jpeg';
    return '<img src="data:' + mime + ';base64,' + buf.toString('base64') +
      '" alt="' + esc(alt.trim()) + '">';
  });

  src = src.replace(/\{\{AUDIO:([^|}]+)\|([^}]*)\}\}/g, (m, name, label) => {
    const file = path.join(AUDIO, name.trim());
    if (!fs.existsSync(file)) {
      missing.push('audio ' + name.trim());
      return m;
    }
    const buf = fs.readFileSync(file);
    audioBytes += buf.length;
    used.audio.add(name.trim());
    return '<div class="audio">' +
      '<audio controls preload="none" src="data:audio/mpeg;base64,' + buf.toString('base64') + '"></audio>' +
      '<span class="tracktag">' + esc(label.trim()) + '</span></div>';
  });

  for (const l of src.match(/\{\{[A-Z]+:[^}]*\}\}/g) || []) missing.push('unresolved macro ' + l);

  if (missing.length) {
    console.error('build: unit ' + unit + ' cannot finish — ' + missing.length + ' problem(s):');
    for (const m of missing.slice(0, 12)) console.error('    ' + m);
    console.error('  run  node _source/crop.mjs --unit ' + unit + '  and check _source/audio/unit' + pad(unit));
    anyFailure = true;
    continue;
  }

  const out = path.join(ROOT, 'unit' + pad(unit) + '.html');
  fs.writeFileSync(out, src);

  if (fs.existsSync(CROPS)) {
    for (const f of fs.readdirSync(CROPS).filter((n) => /\.(png|jpg)$/.test(n))) {
      const id = f.replace(/\.(png|jpg)$/, '');
      if (!used.img.has(id)) console.warn('  warn  crop ' + id + ' is unused by unit ' + unit);
    }
  }
  if (fs.existsSync(AUDIO)) {
    for (const f of fs.readdirSync(AUDIO).filter((n) => n.endsWith('.mp3'))) {
      if (!used.audio.has(f)) console.warn('  warn  track ' + f + ' is unused by unit ' + unit);
    }
  }

  const questions = (src.match(/data-a="/g) || []).length;
  const zh = (src.match(/class="[^"]*zh(only|line)/g) || []).length;
  console.log('unit ' + pad(unit) + '  ' + path.basename(out) +
    '  ' + mb(fs.statSync(out).size).padStart(8) +
    '  ' + String(questions).padStart(3) + ' questions' +
    '  ' + String(used.img.size).padStart(2) + ' images' +
    '  ' + String(used.audio.size).padStart(2) + ' tracks' +
    '  ' + String(zh).padStart(3) + ' zh strings');
}

process.exit(anyFailure ? 1 : 0);
