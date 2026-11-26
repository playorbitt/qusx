// Load every surah of a pack in the real reader (headless Chrome) and classify every ayah:
//   ok          word-by-word highlighting will work
//   no-row      the pack has no timing row for this ayah (not recited / not aligned)
//   text        the row's text does not map onto the canonical QUSX words
//   zero-word   a word has a zero or negative length interval
//   coverage    some canonical words have no timestamp
//   span        offsets/durations invalid or beyond the recording
// Also checks: overlapping ayah spans inside one recording, and words running past their ayah.
// Usage: node tests/audit-all-ayahs.cjs [--pack local_alhadr] [--out report.json]
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(path.join(__dirname, '..')), ROOT = path.dirname(DIR);
const PACK = arg('pack', ''), OUT = arg('out', '');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const serve = () => new Promise(res => {
  const srv = http.createServer((req, out) => {
    const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { out.writeHead(404); return out.end(); }
    out.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(out);
  }).listen(0, '127.0.0.1', () => res(srv));
});
(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/${path.basename(DIR)}/index.html${PACK ? '?pack=' + PACK : ''}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.route(/\.(m4a|mp3|ogg|opus)(\?|$)/, r => r.abort()); // text and timing only; no audio needed
  await page.goto(url);
  await page.waitForFunction(() => typeof VERSES !== 'undefined' && typeof loadSurah === 'function' && LOCAL_MANIFEST, null, { timeout: 60000 });
  const report = await page.evaluate(async () => {
    const sleep = t => new Promise(r => setTimeout(r, t));
    const rowsBy = new Map();
    for (const s of Object.values(LOCAL_MANIFEST.surahs)) for (const a of s.ayahs) rowsBy.set(a.surah + ':' + a.ayah, a);
    const out = { label: LOCAL_MANIFEST.label, ayahs: 0, ok: 0, causes: {}, examples: {}, overlaps: [], wordPastAyah: [] };
    const add = (cause, key, detail) => { out.causes[cause] = (out.causes[cause] || 0) + 1; (out.examples[cause] ||= []).length < 400 && out.examples[cause].push(detail ? key + ' ' + detail : key); };
    for (const sn of LOCAL_MANIFEST.surahNumbers) {
      try { await loadSurah(sn); } catch (e) { add('load-error', String(sn), e.message); continue; }
      for (let i = 0; i < 300 && readerLoading; i++) await sleep(50);
      for (const v of VERSES) {
        if (v.surah !== sn) continue;
        out.ayahs++;
        const key = v.surah + ':' + v.ayah, row = rowsBy.get(key);
        if (v.audio && v.alignmentVerified) { out.ok++; continue; }
        if (!row) { add('no-row', key); continue; }
        const ts = Array.isArray(row.word_timestamps) ? row.word_timestamps : [];
        const basmala = v.ayah === 1 && v.surah !== 1 && v.surah !== 9; // first ayahs may carry a leading basmala
        if (!readerWordMapping(v.qusxWords, row.text_uthmani || row.text, basmala)) { add('text', key); continue; }
        if (!readerValidSpan(row.source_offset_ms, row.duration_ms)) { add('span', key); continue; }
        const z = ts.filter(([, s, e]) => !(+e > +s)).map(x => x[0]);
        if (z.length) { add('zero-word', key, 'word ' + z.join(',')); continue; }
        if (ts.some(([, s, e]) => +s < 0 || +e > +row.duration_ms + 100)) { add('span', key, 'word beyond ayah'); continue; }
        add('coverage', key, ts.length + '/' + v.qusxWords.length + ' words');
      }
    }
    // recording-level checks straight from the manifest
    const byAudio = new Map();
    for (const r of rowsBy.values()) (byAudio.get(r.audio) || byAudio.set(r.audio, []).get(r.audio)).push(r);
    for (const rows of byAudio.values()) {
      rows.sort((a, b) => a.source_offset_ms - b.source_offset_ms);
      for (let i = 1; i < rows.length; i++) {
        const p = rows[i - 1], c = rows[i], over = p.source_offset_ms + p.duration_ms - c.source_offset_ms;
        if (over > 300 && out.overlaps.length < 200) out.overlaps.push(`${p.surah}:${p.ayah}→${c.surah}:${c.ayah} ${Math.round(over)}ms`);
      }
    }
    return out;
  });
  await browser.close(); srv.close();
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  const short = { ...report, examples: Object.fromEntries(Object.entries(report.examples).map(([k, v]) => [k, v.slice(0, 12)])), overlaps: report.overlaps.slice(0, 10) };
  console.log(JSON.stringify(short, null, 1));
})().catch(e => { console.error(e); process.exit(2); });
