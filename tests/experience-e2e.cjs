// End-to-end checks of the experience layer in headless Chrome (touch-enabled phone and desktop).
// Run: node tests/experience-e2e.cjs [--pack local_alhadr_m4a]
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(path.join(__dirname, '..')), ROOT = path.dirname(DIR), PACK = arg('pack', 'local_alhadr_m4a');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.m4a': 'audio/mp4' };
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
const results = []; const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

(async () => {
  const srv = await serve(), base = `http://127.0.0.1:${srv.address().port}/${path.basename(DIR)}/`;
  const url = base + 'index.html?pack=' + PACK;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  const ready = async () => { await page.waitForFunction(() => typeof VERSES !== 'undefined' && VERSES.length && !readerLoading, null, { timeout: 60000 }); await page.waitForTimeout(600); };
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url); await ready();

  // 1. decluttered top
  const top = await page.evaluate(() => {
    const vis = el => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
    const h = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
    return { brand: vis(document.querySelector('#readerHeader .brand')), heading: vis(document.getElementById('readerHeading')),
      actionsInBar: !!document.querySelector('#readerModeBar .reader-actions'), themeInSettings: !!document.querySelector('#chromeMore #themeToggle'),
      fullBtn: vis(document.getElementById('xpImmersiveBtn')), chrome: h('#readerHeader') + h('#readerModeBar') };
  });
  check('top: brand and duplicate heading hidden', !top.brand && !top.heading, top);
  check('top: verse actions in the view row, theme in settings', top.actionsInBar && top.themeInSettings, top);
  check('top: two rows, at most ~100px', top.chrome <= 100, top);

  // 2. page arrows, keyboard and swipe (Read view, page by page)
  await page.evaluate(async () => { document.querySelector('#viewSwitch [data-view="read"]').click(); const pv = document.getElementById('pageViewSelect'); pv.value = 'page'; pv.dispatchEvent(new Event('change')); await loadSurah(2); });
  await ready(); await page.waitForTimeout(600);
  const p0 = await page.evaluate(() => ({ idx: currentPageIdx, arrows: getComputedStyle(document.querySelector('.page-float.next')).display }));
  check('page arrows shown in page view', p0.arrows !== 'none', p0);
  await page.click('.page-float.next'); await page.waitForTimeout(500);
  const p1 = await page.evaluate(() => currentPageIdx);
  check('next-page arrow turns the page', p1 === p0.idx + 1, { before: p0.idx, after: p1 });
  const box = await page.evaluate(() => { const r = mushafPagesEl.getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.min(r.top + 200, innerHeight / 2) }; });
  const swipe = async dx => {
    Object.assign(box, await page.evaluate(() => { const r = mushafPagesEl.getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.max(r.top + 40, Math.min(r.top + 200, innerHeight / 2)) }; }));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x - dx / 2, y: box.y }] });
    for (let k = 1; k <= 4; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x - dx / 2 + dx * k / 4, y: box.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(1000);
  };
  await swipe(160); const p2 = await page.evaluate(() => currentPageIdx);
  check('swipe right turns to the next page', p2 === p1 + 1, { before: p1, after: p2 });
  await swipe(-160); const p3 = await page.evaluate(() => currentPageIdx);
  check('swipe left goes back a page', p3 === p2 - 1, { before: p2, after: p3 });

  // 3. repeat an ayah twice, loop a range, sleep at the end of the surah (Al-Fatiha, short ayahs)
  await page.evaluate(async () => { await loadSurah(1); });
  await ready();
  const rep = await page.evaluate(async () => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    audio.muted = true;
    document.querySelector('#xpMenu [data-k="repeat"] button[data-v="2"]').click();
    const seen = []; let last = -1;
    const iv = setInterval(() => { if (currentVerseIdx !== last) { last = currentVerseIdx; seen.push(VERSES[last]?.ayah); } }, 50);
    let restarts = 0, prevT = 0;
    const iv2 = setInterval(() => { if (audio.currentTime + 0.5 < prevT) restarts++; prevT = audio.currentTime; }, 50);
    jumpToVerse(findVerseIdx(1, 2), true); for (let k = 0; k < 100 && audio.paused; k++) await sleep(100);
    audio.playbackRate = 2;
    const v2 = VERSES[findVerseIdx(1, 2)];
    for (let k = 0; k < 120 && !VERSES[currentVerseIdx] || (k < 120 && VERSES[currentVerseIdx].ayah < 3); k++) await sleep(100);  // until 1:3 starts (max 12 s)
    await sleep(300);
    clearInterval(iv); clearInterval(iv2); audio.pause();
    document.querySelector('#xpMenu [data-k="repeat"] button[data-v="0"]').click();
    return { restarts, seen };
  });
  check('repeat 2×: the ayah restarts exactly once, then moves on', rep.restarts === 1 && rep.seen.includes(3), rep);

  const loop = await page.evaluate(async () => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    jumpToVerse(findVerseIdx(1, 3), false); await sleep(400);
    document.getElementById('xpFrom').value = 3; document.getElementById('xpTo').value = 4;
    document.getElementById('xpLoopBtn').click();
    const seen = []; let last = -1;
    const iv = setInterval(() => { if (currentVerseIdx !== last) { last = currentVerseIdx; seen.push(VERSES[last]?.ayah); } }, 50);
    playBtn.click(); for (let k = 0; k < 100 && audio.paused; k++) await sleep(100);
    audio.playbackRate = 2;
    const d = (VERSES[findVerseIdx(1, 3)].duration_ms + VERSES[findVerseIdx(1, 4)].duration_ms) / 2;
    await sleep(d * 1.6 + 1500);
    clearInterval(iv); audio.pause(); document.getElementById('xpLoopBtn').click();
    return { seen };
  });
  const afterFour = loop.seen.slice(loop.seen.indexOf(4) + 1);
  check('loop 1:3–1:4 returns to 1:3 instead of 1:5', loop.seen.includes(4) && afterFour[0] === 3 && !loop.seen.includes(5), loop);

  const sleepEnd = await page.evaluate(async () => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    document.querySelector('#xpMenu [data-k="sleep"] button[data-v="surah"]').click();
    jumpToVerse(findVerseIdx(1, 7), true); for (let k = 0; k < 100 && audio.paused; k++) await sleep(100);
    audio.playbackRate = 2;
    await sleep(VERSES[findVerseIdx(1, 7)].duration_ms / 2 + 2500);
    return { paused: audio.paused, surah: currentSurah, toast: document.getElementById('xpToast')?.textContent || '' };
  });
  check('sleep "end of surah" stops after 1:7 and stays on Al-Fatiha', sleepEnd.paused && sleepEnd.surah === 1, sleepEnd);

  // 4. error help appears with actions
  const help = await page.evaluate(async () => {
    loadStatusEl.textContent = 'Audio failed to load for this juz'; loadStatusEl.classList.add('error');
    await new Promise(r => setTimeout(r, 200));
    const h = document.querySelector('.xp-help');
    const out = { shown: !h.hidden, buttons: [...h.querySelectorAll('button')].map(b => b.textContent) };
    loadStatusEl.classList.remove('error'); loadStatusEl.textContent = '';
    return out;
  });
  check('audio error offers "Try again" and another recitation', help.shown && help.buttons.length >= 2, help);

  // 5. untimed ayahs are marked; lock-screen metadata; full screen
  const marks = await page.evaluate(() => ({ tagged: document.querySelectorAll('[data-ayah][data-surah].mushaf-num-glyph, .ayah-pin[data-ayah]').length,
    untimedAll: [...document.querySelectorAll('.untimed')].length }));
  check('ayah markers carry their ayah', marks.tagged > 0, marks);
  const media = await page.evaluate(async () => { playBtn.click(); await new Promise(r => setTimeout(r, 1800)); audio.pause();
    return navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : null; });
  check('lock-screen metadata names the surah and ayah', /\d+:\d+/.test(media || ''), media);
  const imm = await page.evaluate(async () => { document.getElementById('xpImmersiveBtn').click(); await new Promise(r => setTimeout(r, 300));
    const out = { on: document.body.classList.contains('immersive'), header: getComputedStyle(document.getElementById('readerHeader')).display,
      bar: getComputedStyle(document.querySelector('.xp-immersive-bar')).display };
    document.querySelector('.xp-immersive-bar button:last-child').click(); await new Promise(r => setTimeout(r, 300));
    out.off = !document.body.classList.contains('immersive'); return out; });
  check('full-screen reading hides the bars and exits cleanly', imm.on && imm.header === 'none' && imm.bar !== 'none' && imm.off, imm);

  // 6. continue card after a reload with a saved position
  await page.evaluate(async () => { jumpToVerse(findVerseIdx(1, 5), false); await new Promise(r => setTimeout(r, 1200)); });
  await page.goto(url); await ready(); await page.waitForTimeout(800);
  const card = await page.evaluate(() => { const c = document.getElementById('xpContinue'); return { shown: c && !c.hidden, text: c ? c.textContent : '' }; });
  check('continue card offers the saved ayah', card.shown && /1:5/.test(card.text), card);

  // 7. installable: manifest, icons, service worker
  const pwa = await page.evaluate(async () => {
    const m = await fetch('manifest.webmanifest').then(r => r.ok ? r.json() : null).catch(() => null);
    const icons = await Promise.all(['icon-192.png', 'icon-512.png'].map(u => fetch(u).then(r => r.ok)));
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    return { name: m && m.name, icons, sw: !!reg };
  });
  check('installable: manifest, icons and service worker', pwa.name && pwa.icons.every(Boolean) && pwa.sw, pwa);

  await browser.close(); srv.close();
  check('no page errors', errors.length === 0, errors.slice(0, 3));
  for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  ' + JSON.stringify(r.detail)));
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
