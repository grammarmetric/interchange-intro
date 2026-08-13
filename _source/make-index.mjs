/**
 * make-index.mjs - write the contents page.
 *
 *   node _source/make-index.mjs
 *
 * Lists all sixteen units, links the ones that are built, and greys out the
 * ones that are not yet written. Re-run it after building a new unit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const UNITS = [
  [1, 'What\'s your name?', '你叫什么名字？', '2–7'],
  [2, 'Where are my keys?', '我的钥匙在哪儿？', '8–13'],
  [3, 'Where are you from?', '你是哪里人？', '16–21'],
  [4, 'Is this coat yours?', '这件外套是你的吗？', '22–27'],
  [5, 'What time is it?', '现在几点？', '30–35'],
  [6, 'I ride my bike to school.', '我骑车上学。', '36–41'],
  [7, 'Does it have a view?', '有景观吗？', '44–49'],
  [8, 'Where do you work?', '你在哪儿上班？', '50–55'],
  [9, 'I always eat breakfast.', '我总是吃早饭。', '58–63'],
  [10, 'What sports do you like?', '你喜欢什么运动？', '64–69'],
  [11, 'I’m going to have a party.', '我要办个聚会。', '72–77'],
  [12, 'How do you feel?', '你感觉怎么样？', '78–83'],
  [13, 'How do I get there?', '我怎么去那儿？', '86–91'],
  [14, 'I had a good time.', '我玩得很开心。', '92–97'],
  [15, 'Where were you born?', '你在哪儿出生的？', '100–105'],
  [16, 'Can I take a message?', '需要我帮你传话吗？', '106–111']
];

const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const rows = UNITS.map(([n, en, zh, pages]) => {
  const file = 'unit' + pad(n) + '.html';
  const built = fs.existsSync(path.join(ROOT, file));
  const size = built ? (fs.statSync(path.join(ROOT, file)).size / 1048576).toFixed(1) + ' MB' : '';
  const qs = built
    ? ((fs.readFileSync(path.join(ROOT, file), 'utf8').match(/data-a="/g) || []).length + ' questions')
    : '';
  const inner =
    '<span class="n">' + n + '</span>' +
    '<span class="body"><span class="t">' + esc(en) + '</span>' +
    '<span class="z" lang="zh-CN">' + esc(zh) + '</span></span>' +
    '<span class="meta">pp. ' + pages + (qs ? ' &middot; ' + qs : '') +
    (size ? ' &middot; ' + size : '') + '</span>';
  return built
    ? '  <a class="u" href="./' + file + '">' + inner + '</a>'
    : '  <span class="u todo">' + inner + '<span class="soon" lang="zh-CN">还没做</span></span>';
}).join('\n');

const built = UNITS.filter(([n]) => fs.existsSync(path.join(ROOT, 'unit' + pad(n) + '.html'))).length;

// The bridge-course syllabus, if it has been written. Sits above the unit list.
const syllabus = fs.existsSync(path.join(ROOT, 'syllabus.html'))
  ? '<a class="syl" href="./syllabus.html"><span class="sn">1–5</span>' +
    '<span class="body"><span class="t">Bridge course syllabus</span>' +
    '<span class="z" lang="zh-CN">衔接课程教学大纲 — 第 1–5 单元</span></span>' +
    '<span class="meta">10 days &middot; 2 hours a day</span></a>\n'
  : '';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
<title>Interchange Intro — Interactive worksheets</title>
<style>
:root{--orange:#e8871e;--ink:#1e2430;--ink-2:#4a5464;--ink-3:#7b8598;--blue:#2f6fb0;
  --line:#e2e6ec;--bg:#f4f6f9;--card:#fff;--shadow:0 1px 2px rgba(20,30,50,.06),0 4px 16px rgba(20,30,50,.06)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 "Segoe UI",-apple-system,
  BlinkMacSystemFont,Roboto,Helvetica,Arial,"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif}
header{background:linear-gradient(135deg,#3a2c1c,#1e2430);color:#fff;padding:26px 20px 22px}
.w{max-width:820px;margin:0 auto}
.kicker{font-size:.72em;letter-spacing:.16em;text-transform:uppercase;color:#f3b05a;font-weight:700}
h1{margin:.15em 0 .1em;font-size:1.7em}
.sub{color:#c2c8d2;font-size:.9em;margin:0}
main{max-width:820px;margin:0 auto;padding:22px 20px 70px}
.list{display:grid;gap:10px}
.u{display:flex;align-items:center;gap:14px;padding:13px 16px;background:var(--card);
  border:1px solid var(--line);border-radius:11px;box-shadow:var(--shadow);
  text-decoration:none;color:inherit}
a.u:hover{border-color:var(--orange)}
.n{flex:0 0 auto;width:36px;height:36px;border-radius:9px;background:var(--orange);color:#2b1600;
  font-weight:800;display:flex;align-items:center;justify-content:center}
.body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.t{font-weight:700}
.z{color:var(--ink-3);font-size:.86em}
.meta{flex:0 0 auto;color:var(--ink-3);font-size:.8em;text-align:right;white-space:nowrap}
.todo{opacity:.55}
.todo .n{background:var(--line);color:var(--ink-3)}
.soon{margin-left:10px;font-size:.75em;border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--ink-3)}
.note{margin:18px 0 0;color:var(--ink-3);font-size:.85em}
.syl{display:flex;align-items:center;gap:14px;padding:13px 16px;margin:0 0 18px;background:var(--card);
  border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:11px;
  box-shadow:var(--shadow);text-decoration:none;color:inherit}
.syl:hover{border-color:var(--blue)}
.sn{flex:0 0 auto;width:36px;height:36px;border-radius:9px;background:var(--blue);color:#fff;
  font-weight:800;font-size:.78em;display:flex;align-items:center;justify-content:center}
@media (max-width:560px){.meta{display:none}}
</style>
</head>
<body>
<header><div class="w">
  <div class="kicker">Interchange Intro &middot; Fifth Edition</div>
  <h1>Interactive worksheets</h1>
  <p class="sub">${built} of 16 units &middot; English | 中文 &middot; works offline</p>
</div></header>
<main>
${syllabus}<div class="list">
${rows}
</div>
<p class="note" lang="zh-CN">每份练习都是一个独立文件，可以离线打开。点右上角的「中文」切换说明语言。</p>
</main>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'index.html'), html);
console.log('make-index: wrote index.html — ' + built + ' of 16 units built');
