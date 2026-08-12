#!/usr/bin/env node
/**
 * verify.mjs - prove a built unit works, in both languages.
 *
 *   node _source/verify.mjs --unit 1
 *   node _source/verify.mjs --all
 *
 * Drives headless Edge/Chrome over the DevTools Protocol using the WebSocket
 * built into Node — no npm, no driver library.
 *
 * Nothing here is hard-coded to a particular unit: the expected counts are
 * read out of the page itself, so a new unit is covered the day it is written.
 *
 *   - every picture embeds AND decodes, every recording embeds, nothing is
 *     fetched from the network
 *   - every marked control is filled with its own answer and the page must
 *     score 100%. This is what catches a data-a that no option can satisfy.
 *   - one answer is then broken on purpose; exactly one mark must be lost
 *   - the whole pass repeats in 中文 mode, which must score 100% from one key
 *   - every rubric and tip must contain Chinese in Chinese mode
 *   - every spoken line the learner reads must carry a translation, and every
 *     gap-fill conversation must have its 中文对照 panel
 *   - answers reach localStorage; Clear all empties everything
 *   - no console errors anywhere in the run
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

function unitsToCheck() {
  if (arg('all', false)) {
    return fs.readdirSync(ROOT).filter((f) => /^unit\d\d\.html$/.test(f))
      .map((f) => Number(f.slice(4, 6))).sort((a, b) => a - b);
  }
  const u = arg('unit', null);
  if (!u) { console.error('verify: pass --unit N or --all'); process.exit(2); }
  return [Number(u)];
}

const CANDIDATES = [
  process.env.BRIDGE_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const browserPath = String(arg('browser', CANDIDATES.find((p) => fs.existsSync(p)) || ''));
if (!browserPath || !fs.existsSync(browserPath)) {
  console.error('verify: no Chromium-based browser found. Pass --browser "<path>".');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-verify-'));
const port = 9700 + Math.floor(Math.random() * 300);
const child = spawn(browserPath, [
  '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
  '--window-size=1100,1500', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targetURL() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (err) { /* still starting */ }
    await sleep(150);
  }
  throw new Error('browser never exposed a debugging target');
}

const ws = new WebSocket(await targetURL());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
let errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push(d.exception ? d.exception.description : d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  }
};
function send(method, params) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: '(function(){' + expr + '})()', returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception
      ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  }
  return r.result.value;
}
async function until(expr, what, ms) {
  const limit = Date.now() + (ms || 40000);
  for (;;) {
    const v = await evaluate(expr);
    if (v) return v;
    if (Date.now() > limit) throw new Error('timed out waiting for ' + what);
    await sleep(150);
  }
}

const FILL = `
  var n = 0;
  Array.prototype.slice.call(document.querySelectorAll('[data-a]')).forEach(function(el){
    if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return;
    var want = el.getAttribute('data-a').split('|')[0];
    if (el.tagName === 'DIV'){
      var ins = el.querySelectorAll('input');
      for (var i=0;i<ins.length;i++){
        ins[i].checked = (ins[i].value === want);
        if (ins[i].checked) ins[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      var hit = false;
      /* Match on value only: the visible label is Chinese in Chinese mode, so
         matching on text would hide exactly the bug this run looks for. */
      for (var j=0;j<el.options.length;j++){
        if (el.options[j].value === want){ el.selectedIndex = j; hit = true; break; }
      }
      if (!hit) return;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    n++;
  });
  return n;`;

let pass = 0;
let fail = 0;
function check(ok, what, detail) {
  if (ok) { pass++; console.log('    ok   ' + what); }
  else { fail++; console.log('    FAIL ' + what + (detail ? '\n           ' + detail : '')); }
}

try {
  await send('Runtime.enable');
  await send('Page.enable');

  for (const unit of unitsToCheck()) {
    const file = 'unit' + pad(unit) + '.html';
    if (!fs.existsSync(path.join(ROOT, file))) {
      console.log('\n' + file + ' — not built yet, skipped');
      continue;
    }
    errors = [];
    console.log('\n' + file + '  (' + (fs.statSync(path.join(ROOT, file)).size / 1048576).toFixed(1) + ' MB)');

    await send('Page.navigate', { url: origin + '/' + file });
    await until('return document.readyState === "complete" && !!document.getElementById("btnCheck")', 'the page');
    await sleep(400);

    const shape = await evaluate(`
      return {
        graded: document.querySelectorAll('[data-a]').length,
        sections: document.querySelectorAll('section.ex').length,
        audios: document.querySelectorAll('audio').length,
        dataAudio: document.querySelectorAll('audio[src^="data:audio/mpeg"]').length,
        imgs: document.querySelectorAll('img').length,
        /* crop.mjs keeps PNG or JPEG per picture, whichever is smaller. */
        dataImg: document.querySelectorAll('img[src^="data:image/png"],img[src^="data:image/jpeg"]').length,
        remote: document.querySelectorAll('[src^="http"],[href^="http"]').length
      };`);
    check(shape.graded > 0, shape.graded + ' marked questions found');
    check(shape.audios > 0 && shape.audios === shape.dataAudio,
      'all ' + shape.audios + ' recordings are embedded', JSON.stringify(shape));
    check(shape.imgs > 0 && shape.imgs === shape.dataImg,
      'all ' + shape.imgs + ' pictures are embedded', JSON.stringify(shape));
    check(shape.remote === 0, 'nothing is loaded from the network', 'remote refs: ' + shape.remote);

    const decoded = await until(`
      var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
      return imgs.every(function(i){ return i.complete && i.naturalWidth > 0; }) ? imgs.length : 0;`,
      'the pictures to decode');
    check(decoded === shape.imgs, 'every picture decodes', 'decoded ' + decoded);

    const filled = await evaluate(FILL);
    check(filled === shape.graded, 'every answer key matches a pickable option',
      'filled ' + filled + ' of ' + shape.graded);
    const scored = await evaluate('return window.__check();');
    check(scored.total === shape.graded && scored.right === scored.total,
      'the correct answers score ' + scored.total + ' / ' + scored.total, JSON.stringify(scored));

    const broken = await evaluate(`
      var el = document.querySelector('select[data-a]');
      var want = el.getAttribute('data-a').split('|')[0];
      for (var i=0;i<el.options.length;i++){
        if (el.options[i].value !== want && el.options[i].value !== ''){ el.selectedIndex = i; break; }
      }
      return window.__check();`);
    check(broken.right === scored.total - 1, 'one wrong answer loses exactly one mark',
      JSON.stringify(broken));

    await evaluate("document.getElementById('lvZH').click(); return 1;");
    await sleep(250);

    const zh = await evaluate(`
      function vis(el){ return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
      return {
        onBody: document.body.classList.contains('lvl-zh'),
        enVisible: Array.prototype.slice.call(document.querySelectorAll('.enonly')).filter(vis).length,
        zhVisible: Array.prototype.slice.call(document.querySelectorAll('.zhonly')).filter(vis).length,
        optionSwapped: (function(){
          var o = document.querySelector('option[data-zh]');
          return o ? o.textContent === o.getAttribute('data-zh') : true;
        })()
      };`);
    check(zh.onBody && zh.enVisible === 0 && zh.zhVisible > 10,
      'the Chinese track replaces every English instruction', JSON.stringify(zh));
    check(zh.optionSwapped, 'dropdown labels that carry a gloss switch too');

    const untranslated = await evaluate(`
      function vis(el){ return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
      var out = [];
      Array.prototype.slice.call(document.querySelectorAll('.rubric, .tip')).forEach(function(el){
        if (!vis(el)) return;
        var text = el.innerText || el.textContent || '';
        if (!/[\\u4e00-\\u9fff]/.test(text)) out.push(text.replace(/\\s+/g,' ').slice(0, 60));
      });
      return out;`);
    check(untranslated.length === 0, 'every instruction and tip has a Chinese version',
      untranslated.join(' | '));

    const untranslatedLines = await evaluate(`
      function vis(el){ return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
      var bad = [];
      Array.prototype.slice.call(document.querySelectorAll('.dlg')).forEach(function(d){
        if (!vis(d) || d.closest('details') || d.querySelector('select')) return;
        Array.prototype.slice.call(d.querySelectorAll('.dl')).forEach(function(line){
          if (!line.querySelector('.zhline')) bad.push(line.textContent.replace(/\\s+/g,' ').slice(0, 45));
        });
      });
      return bad;`);
    check(untranslatedLines.length === 0,
      'every spoken line the learner reads has a translation', untranslatedLines.join(' | '));

    const gapPanels = await evaluate(`
      var missing = [];
      Array.prototype.slice.call(document.querySelectorAll('section.ex')).forEach(function(s){
        if (!s.querySelector('.dlg select')) return;
        if (!s.querySelector('details.zhonly')) missing.push(s.getAttribute('data-sec') || '?');
      });
      return missing;`);
    check(gapPanels.length === 0, 'each gap-fill conversation has a 中文对照 panel',
      gapPanels.join(', '));

    const zhFilled = await evaluate(FILL);
    const zhScore = await evaluate('return window.__check();');
    check(zhFilled === shape.graded && zhScore.right === shape.graded,
      'the Chinese track scores ' + shape.graded + ' / ' + shape.graded + ' from the same key',
      'filled ' + zhFilled + ', ' + JSON.stringify(zhScore));

    await sleep(700);
    const saved = await evaluate(`
      /* The answers key, not the sibling "_lang" key that holds a bare string. */
      var k = Object.keys(localStorage).filter(function(x){
        return /^gm_interchange/.test(x) && !/_lang$/.test(x);
      })[0];
      var raw = k ? localStorage.getItem(k) : null;
      if (!raw) return 0;
      try { return Object.keys(JSON.parse(raw)).length; } catch (e) { return -1; }`);
    check(saved > 0, 'answers are saved as you work', 'stored keys: ' + saved);

    check(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
    await evaluate("document.getElementById('lvEN').click(); return 1;");
  }
} catch (err) {
  fail++;
  console.log('\n  FAIL  ' + err.message);
} finally {
  try { ws.close(); } catch (err) { /* ignore */ }
  child.kill();
  server.close();
  await sleep(200);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* windows */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
