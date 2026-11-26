// Checks that the Para pack never plays its in-audio ads: for every track skip range in
// local_para/manifest.json, playback started 3 s before the ad must jump past it.
// Run: node tests/ad-skip-e2e.cjs [--pack local_para] [--rate 2]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(path.join(__dirname, '..'));
const ROOT = path.dirname(DIR);
const PACK = arg('pack', 'local_para'), RATE = Number(arg('rate', 2));
const CHROME = arg('chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p)));
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

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
      } else { out.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size }); fs.createReadStream(file).pipe(out); }
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/${path.basename(DIR)}/index.html?pack=${PACK}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => typeof LOCAL_MANIFEST !== 'undefined' && LOCAL_MANIFEST?.tracks && typeof loadSurah === 'function', null, { timeout: 30000 });
  const results = await page.evaluate(async (RATE) => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    const out = [];
    const all = [];
    for (const s of Object.values(LOCAL_MANIFEST.surahs)) for (const a of s.ayahs) all.push(a);
    for (const t of LOCAL_MANIFEST.tracks.filter(t => t.skip)) {
      for (const [a, b] of t.skip) {
        // open the surah of the last ayah that starts before the ad, so the reader really has this track loaded
        const key = readerTrackKey(t.audio);
        const before = all.filter(x => readerTrackKey(x.audio) === key && x.source_offset_ms / 1000 < a).sort((x, y) => y.source_offset_ms - x.source_offset_ms)[0];
        await loadSurah(before.surah);
        for (let i = 0; i < 100 && !(VERSES.length && VERSES[0].surah === before.surah); i++) await sleep(100);
        const vi = VERSES.findIndex(v => v.ayah === before.ayah && v.audio);
        if (vi < 0) { out.push({ juz: t.juz, a, b, error: 'no verse' }); continue; }
        if (typeof playVerse === 'function') await playVerse(vi); else { audio.src = VERSES[vi].audio; }
        for (let i = 0; i < 100 && !(audio.readyState >= 1); i++) await sleep(100);
        audio.playbackRate = RATE;
        audio.currentTime = a - 3; await audio.play().catch(() => {});
        const seen = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 6000 / RATE + 2500) { seen.push(audio.currentTime); await sleep(20); }
        audio.pause();
        const inside = seen.filter(x => x > a + 0.4 && x < b - 0.1);
        out.push({ juz: t.juz, a, b, track: readerTrackKey(audio.currentSrc), passed: seen.some(x => x >= b), inside: inside.length, maxInside: inside.length ? Math.max(...inside) : null });
      }
    }
    return out;
  }, RATE);
  await browser.close(); srv.close();
  let ok = results.length > 0;
  for (const r of results) {
    const good = !r.error && r.passed && r.inside === 0;
    ok = ok && good;
    console.log(`${good ? 'PASS' : 'FAIL'} para-${String(r.juz).padStart(2, '0')} skip ${r.a}-${r.b}s`, JSON.stringify(r));
  }
  if (errors.length) { ok = false; console.log('page errors:', errors); }
  console.log(ok ? 'ALL PASS' : 'FAILED'); process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
