/**
 * extract.mjs - assemble the raw material for authoring a unit.
 *
 *   node _source/extract.mjs --unit 2 [--all]
 *
 * Writes _source/units/unitNN/source.md, which is the single document an
 * author works from. It gathers, per unit:
 *
 *   - the OCR text of each Student's Book page (the full-book PDF does have a
 *     text layer; the per-unit PDFs do not). It is noisy on picture-heavy
 *     pages, so it is a transcription AID and must be checked against the
 *     rendered page before anything is copied into a worksheet.
 *   - the teacher's edition notes for that unit: every answer key and every
 *     audio script. This text layer is clean, and it is the ONLY acceptable
 *     source for answers. Never deduce a key from the audio.
 *   - the unit's imported tracks, so exercises can be wired to real recordings.
 *
 * Nothing here writes a worksheet. It removes the archaeology so that writing
 * one is just writing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Confirmed against the book: PDF page = printed page + 8. */
const PAGE_OFFSET = 8;
const UNITS = [
  [1, 2, 7, "What's your name?"], [2, 8, 13, 'Where are my keys?'],
  [3, 16, 21, 'Where are you from?'], [4, 22, 27, 'Is this coat yours?'],
  [5, 30, 35, 'What time is it?'], [6, 36, 41, 'I ride my bike to school.'],
  [7, 44, 49, 'Does it have a view?'], [8, 50, 55, 'Where do you work?'],
  [9, 58, 63, 'I always eat breakfast.'], [10, 64, 69, 'What sports do you like?'],
  [11, 72, 77, 'I’m going to have a party.'], [12, 78, 83, 'How do you feel?'],
  [13, 86, 91, 'How do I get there?'], [14, 92, 97, 'I had a good time.'],
  [15, 100, 105, 'Where were you born?'], [16, 106, 111, 'Can I take a message?']
];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && next.indexOf('--') !== 0 ? next : true;
}

const src = arg('src', process.env.INTERCHANGE_DIR ||
  'G:/My Drive/Classroom/Interchange/Interchange Intro');
const book = path.join(src, 'Interchange Intro Full Book.pdf');
const teacherPdf = path.join(src, 'INT0-5th-edition-teachers-pdf-free.pdf');
const pad = (n) => String(n).padStart(2, '0');

if (!fs.existsSync(book)) {
  console.error('extract: cannot find ' + book);
  process.exit(2);
}
if (spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error) {
  console.error('extract: pdftotext not found on PATH (install poppler-utils).');
  process.exit(2);
}

/* The teacher's edition is one big text layer; slice it per unit once. */
let teacher = '';
if (fs.existsSync(teacherPdf)) {
  const cache = path.join(HERE, '.teacher-text.txt');
  if (fs.existsSync(cache)) teacher = fs.readFileSync(cache, 'utf8');
  else {
    const r = spawnSync('pdftotext', [teacherPdf, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    teacher = r.stdout || '';
    fs.writeFileSync(cache, teacher);
  }
}

/** The teacher's notes for one unit: from its cycle header to the next unit's. */
function teacherSlice(unit) {
  if (!teacher) return '(teacher\'s edition PDF not found — answers must come from it, do not guess)';
  const lines = teacher.split('\n');
  const startRe = new RegExp('^\\s*Cycle 1, Exercises', 'i');
  /* Unit boundaries are marked by the running footer "T-<page>" plus the unit
     title; the most reliable anchor is the title itself. */
  const title = UNITS.find((u) => u[0] === unit)[3];
  const next = UNITS.find((u) => u[0] === unit + 1);
  let from = lines.findIndex((l) => l.trim() === title);
  if (from === -1) from = 0;
  let to = next ? lines.findIndex((l, i) => i > from + 40 && l.trim() === next[3]) : -1;
  if (to === -1) to = Math.min(lines.length, from + 900);
  const slice = lines.slice(Math.max(0, from - 60), to).join('\n');
  void startRe;
  return slice;
}

function pageText(printedPage) {
  const p = printedPage + PAGE_OFFSET;
  const r = spawnSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', book, '-'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return (r.stdout || '').replace(/\n{3,}/g, '\n\n').trim();
}

const wanted = arg('all', false)
  ? UNITS.map((u) => u[0])
  : [Number(arg('unit', 0))].filter(Boolean);
if (!wanted.length) {
  console.error('extract: pass --unit N or --all');
  process.exit(2);
}

for (const unit of wanted) {
  const row = UNITS.find((u) => u[0] === unit);
  if (!row) { console.error('extract: no unit ' + unit); continue; }
  const [, first, last, title] = row;
  const dir = path.join(HERE, 'units', 'unit' + pad(unit));
  fs.mkdirSync(dir, { recursive: true });

  const audioDir = path.join(HERE, 'audio', 'unit' + pad(unit));
  let tracks = '(no audio imported — run node _source/import-audio.mjs)';
  if (fs.existsSync(path.join(audioDir, 'tracks.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(audioDir, 'tracks.json'), 'utf8'));
    tracks = t.tracks.map((x) =>
      '- `' + x.file + '`  — p.' + x.page +
      (x.exercises[0] === null ? '' : ' Ex ' + x.exercises.join('+')) +
      ' ' + x.title + (x.part ? ' (Pt ' + x.part + ')' : '') +
      (x.merged ? '  **merged file — covers two exercises**' : '')).join('\n');
  }

  const pages = [];
  for (let p = first; p <= last; p++) {
    pages.push('### Printed page ' + p + '  (PDF page ' + (p + PAGE_OFFSET) + ')\n\n```\n' +
      pageText(p) + '\n```');
  }

  const md = `# Unit ${unit} — ${title}

Student's Book pp. ${first}–${last}. PDF page = printed page + ${PAGE_OFFSET}.

> **Read this first.** The page text below is OCR of the scan. It is noisy on
> picture-heavy pages and must be checked against the rendered page before any
> of it is copied into a worksheet. The answer keys in the teacher's section
> are a clean text layer and are the only acceptable source for answers —
> never deduce a key from the audio.

## Audio imported for this unit

${tracks}

## Student's Book pages (OCR — verify before use)

${pages.join('\n\n')}

## Teacher's edition notes for this unit (answer keys and audio scripts)

\`\`\`
${teacherSlice(unit)}
\`\`\`
`;

  fs.writeFileSync(path.join(dir, 'source.md'), md);
  const kb = Math.round(Buffer.byteLength(md) / 1024);
  console.log('unit ' + pad(unit) + '  source.md  ' + String(kb).padStart(4) + ' kB  (pp. ' +
    first + '–' + last + ')');
}
