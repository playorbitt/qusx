// End-to-end check of reading-progress saving in headless Chrome (one browser profile, real reloads).
//  1. play an ayah, pause, reload            -> resumes on that ayah, at the saved second
//  2. a second pack saves its own position   -> the first pack's position is untouched
//  3. scroll while paused, reload            -> resumes near the ayah that was on screen
//  4. seek and leave immediately (pagehide)  -> the new ayah is still saved
// Run: node tests/progress-e2e.cjs [--packA local_alhadr_m4a] [--packB local_para]
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(path.join(__dirname, '..')), ROOT = path.dirname(DIR);
const PACK_A = arg('packA', 'local_alhadr_m4a'), PACK_B = arg('packB', 'local_para');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const serve = () => new Promise(res => {
  const srv = http.createServer((req, out) => {
    const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { out.writeHead(404); return out.end(); }
    const size = fs.statSync(f).size, type = TYPES[path.extname(f)] || 'application/octet-stream', m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { const s = m[1] ? +m[1] : size - +m[2], e = m[1] && m[2] ? +m[2] : size - 1;
      out.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 }); fs.createReadStream(f, { start: s, end: e }).pipe(out); }
    else { out.writeHead(200, { 'Content-Type': type, 'Content-Length': size }); fs.createReadStream(f).pipe(out); }
  }).listen(0, '127.0.0.1', () => res(srv));
});
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

(async () => {
  const srv = await serve(), base = `http://127.0.0.1:${srv.address().port}/${path.basename(DIR)}/index.html`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext(), page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const open = async pack => {
    await page.goto(base + '?pack=' + pack);
    await page.waitForFunction(() => typeof VERSES !== 'undefined' && VERSES.length && !readerLoading, null, { timeout: 30000 });
    // the restored position is applied by a seek that completes once the audio metadata arrives
    await page.waitForFunction(() => !pendingAudioSeek, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
  };
  const where = () => page.evaluate(() => ({ surah: VERSES[currentVerseIdx]?.surah, ayah: VERSES[currentVerseIdx]?.ayah, t: +audio.currentTime.toFixed(2) }));
  const playAt = (surah, ayah, ms) => page.evaluate(async ({ surah, ayah, ms }) => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    if (currentSurah !== surah) { await loadSurah(surah); for (let i = 0; i < 100 && readerLoading; i++) await sleep(100); }
    audio.muted = true; jumpToVerse(findVerseIdx(surah, ayah), true);
    for (let i = 0; i < 60 && audio.paused; i++) await sleep(100);
    await sleep(ms); audio.pause(); await sleep(200);
    return +audio.currentTime.toFixed(2);
  }, { surah, ayah, ms });

  // 1. play, pause, reload
  await page.goto(base + '?pack=' + PACK_A); await page.evaluate(() => localStorage.clear());
  await open(PACK_A);
  const savedT = await playAt(2, 120, 1500);
  await open(PACK_A);
  let w = await where();
  check('reload resumes the played ayah', w.surah === 2 && w.ayah === 120, w);
  check('reload resumes at the saved second (±0.5 s)', Math.abs(w.t - savedT) <= 0.5, { saved: savedT, got: w.t });

  // 2. another pack keeps its own slot
  await open(PACK_B);
  await playAt(12, 60, 1200);
  await open(PACK_B);
  w = await where(); check('second pack resumes its own ayah', w.surah === 12 && w.ayah === 60, w);
  await open(PACK_A);
  w = await where(); check('first pack position untouched by second pack', w.surah === 2 && w.ayah === 120, w);

  // 3. scroll while paused, reload
  const scrolled = await page.evaluate(async () => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    const pv = document.getElementById('pageViewSelect'); pv.value = 'scroll'; pv.dispatchEvent(new Event('change'));
    await sleep(800);
    const target = [...document.querySelectorAll('[data-ayah][data-surah="2"]')].find(e => +e.dataset.ayah === 200);
    target.scrollIntoView({ block: 'start' }); window.scrollBy(0, -(document.getElementById('readerModeBar').getBoundingClientRect().bottom + 10));
    await sleep(1800); return readerReadingIdx() >= 0 ? VERSES[readerReadingIdx()].ayah : null;
  });
  await open(PACK_A);
  w = await where(); check('scroll position resumes near the visible ayah (±3)', w.surah === 2 && Math.abs(w.ayah - scrolled) <= 3, { visible: scrolled, got: w });

  // 4. seek then leave at once: pagehide must save without waiting for the 800 ms debounce
  await page.evaluate(() => { jumpToVerse(findVerseIdx(2, 250), false); });
  await page.waitForTimeout(150);
  await page.goto('about:blank');
  await open(PACK_A);
  w = await where(); check('position saved on immediate leave (pagehide)', w.surah === 2 && w.ayah === 250, w);

  // 5. corrupt storage does not break the reader
  await page.evaluate(() => localStorage.setItem('qusx-progress-v2', '{not json'));
  await open(PACK_A);
  w = await where(); check('corrupt saved data falls back safely', !!w.surah, w);

  await browser.close(); srv.close();
  check('no page errors', errors.length === 0, errors.slice(0, 3));
  for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  ' + JSON.stringify(r.detail)));
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
