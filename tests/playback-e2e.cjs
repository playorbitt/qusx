// End-to-end playback check of the real reader in headless Chrome.
// Plays a stretch of a surah continuously and checks, every 100 ms, that:
//   1. playback never stops or jumps backwards on its own,
//   2. the highlighted word (data-surah/data-ayah/data-word) is the word whose timing contains the clock,
//   3. aligned speech is actually highlighted most of the time.
// Run: node tests/playback-e2e.cjs [--dir .] [--pack local_alhadr] [--surah 2] [--from 1] [--seconds 40] [--rate 2]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(arg('dir', path.join(__dirname, '..')));
const ROOT = path.dirname(DIR); // serve the parent so sibling audio (../Para …) also resolves
const PACK = arg('pack', '');
const SURAH = Number(arg('surah', 2)), FROM = Number(arg('from', 1));
const SECONDS = Number(arg('seconds', 40)), RATE = Number(arg('rate', 2));
const CHROME = arg('chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p)));

const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, out) => {
      const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { out.writeHead(404); return out.end(); }
      const size = fs.statSync(file).size, type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? +m[2] : size - 1;
        out.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(out);
      } else {
        out.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
        fs.createReadStream(file).pipe(out);
      }
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/${path.basename(DIR)}/index.html${PACK ? '?pack=' + PACK : ''}`;
  // --resolve "host=ip" pins a hostname (for a local DNS server that cannot see a new archive.org storage host)
  const resolve = arg('resolve', '');
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (resolve) args.push('--host-resolver-rules=' + resolve.split(',').map(p => 'MAP ' + p.replace('=', ' ')).join(','));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => typeof VERSES !== 'undefined' && typeof loadSurah === 'function', null, { timeout: 30000 });
  const result = await page.evaluate(async ({ SURAH, FROM, SECONDS, RATE }) => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    localStorage.clear();
    if (typeof isLocalReciter === 'function' && !isLocalReciter() && typeof RECITERS !== 'undefined') RECITER_CONFIG = RECITERS[0][0];
    await loadSurah(SURAH);
    for (let i = 0; i < 100 && !(VERSES.length && VERSES[0].surah === SURAH); i++) await sleep(100);
    const start = VERSES.findIndex(v => v.ayah === FROM && v.audio);
    if (start < 0) return { setupError: `no aligned audio for ${SURAH}:${FROM}` };
    audio.muted = true;
    jumpToVerse(start, true);
    for (let i = 0; i < 100 && (audio.paused || audio.currentTime * 1000 < VERSES[start].source_offset_ms - 50); i++) await sleep(100);
    if (audio.paused) return { setupError: 'playback did not start: ' + (document.querySelector('#loadStatus')?.textContent || '') };
    audio.playbackRate = RATE;
    const expectedAt = ms => {
      const file = audio.currentSrc;
      for (const v of VERSES) {
        if (!v.audio || !v.alignmentVerified || new URL(v.audio, document.baseURI).href !== file) continue;
        const rel = ms - v.source_offset_ms;
        if (rel < 0 || rel >= v.duration_ms) continue;
        let w = null;
        for (const [id, s, e] of v.words) if (rel >= s && rel < e) w = id;
        return { surah: v.surah, ayah: v.ayah, word: w };
      }
      return null;
    };
    const samples = [], problems = [];
    let lastT = -1, lastFile = audio.currentSrc, pausedSince = null;
    const end = performance.now() + SECONDS * 1000;
    while (performance.now() < end) {
      await sleep(100);
      if (audio.playbackRate !== RATE && !audio.paused) audio.playbackRate = RATE;
      const ms = audio.currentTime * 1000, el = document.querySelector('.active-word');
      const got = el ? { surah: +el.dataset.surah, ayah: +el.dataset.ayah, word: +el.dataset.word } : null;
      const exp = expectedAt(ms);
      const s = { t: +(ms / 1000).toFixed(2), got, exp, paused: audio.paused };
      samples.push(s);
      // a short pause while the next juz file loads is normal; staying stopped is the bug
      if (audio.paused) { pausedSince ??= performance.now(); } else pausedSince = null;
      if (pausedSince != null && performance.now() - pausedSince > 2000) { problems.push({ kind: 'stopped', ...s, status: document.querySelector('#loadStatus')?.textContent }); break; }
      if (audio.currentSrc === lastFile && ms + 400 < lastT) problems.push({ kind: 'jumped-back', from: lastT / 1000, ...s });
      // allow one 100 ms sample of slack at a word boundary (highlight clock vs media clock)
      if (got && exp && exp.word != null && (got.surah !== exp.surah || got.ayah !== exp.ayah || got.word !== exp.word)) {
        const near = exp.word != null && got.ayah === exp.ayah && Math.abs(got.word - exp.word) === 1;
        if (!near) problems.push({ kind: 'wrong-word', ...s });
      }
      if (!audio.paused) { lastT = ms; lastFile = audio.currentSrc; }
    }
    audio.pause();
    const voiced = samples.filter(s => s.exp && s.exp.word != null);
    const lit = voiced.filter(s => s.got && s.got.ayah === s.exp.ayah && Math.abs(s.got.word - s.exp.word) <= 1);
    return { audioFile: decodeURIComponent(audio.currentSrc.split('/').pop()), samples: samples.length, voiced: voiced.length, highlighted: lit.length,
             span: samples.length ? [samples[0].t, samples[samples.length - 1].t] : null,
             ayahs: [...new Set(samples.map(s => s.exp && s.exp.ayah).filter(Boolean))], problems: problems.slice(0, 15), problemCount: problems.length };
  }, { SURAH, FROM, SECONDS, RATE });
  await browser.close(); srv.close();
  const coverage = result.voiced ? result.highlighted / result.voiced : 0;
  const fail = result.setupError || result.problemCount > 0 || coverage < 0.9 || errors.length;
  console.log(JSON.stringify({ url, ...result, coverage: +coverage.toFixed(3), pageErrors: errors.slice(0, 5) }, null, 1));
  console.log(fail ? 'FAIL' : 'PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
