// Perf probe: Pixel 7 emulation, 4x CPU throttle. node perf.js [url] [--json]
// Measures rAF frame intervals + DevTools Performance metrics (layout/style/script/paint counts & durations) during:
// swipe (touch drag + settle), tap-to-front (chip tap or side tap glide), idle with seats running.
const { chromium, devices } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
function serve() { return new Promise(r => { const s = http.createServer((q, res) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); }); }).listen(8777, () => r(s)); }); }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : 0; };
async function run(url, opts = {}) {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', reducedMotion: 'no-preference' });
  const p = await ctx.newPage();
  await p.addInitScript(() => { sessionStorage.setItem('bst.intro', '1');
    window.__frames = null; window.__rec = () => { const f = []; let last = performance.now(), on = true; const loop = t => { f.push(t - last); last = t; if (on) requestAnimationFrame(loop); }; requestAnimationFrame(t => { last = t; requestAnimationFrame(loop); }); return () => { on = false; return f; }; }; });
  if (process.env.PERF_NOLITE) await p.addInitScript(() => { window.__noLite = 1; });
  await p.goto(url); if (opts.css) await p.addStyleTag({ content: opts.css }); await p.waitForTimeout(1500);
  await p.evaluate(() => { ['b2', 'b3', 'b5', 'b6', 'b7'].forEach(id => startTimer(id)); seats.b3.startTime -= 34 * 60000; seats.b2.startTime -= 50 * 60000; seats.b7.startTime -= 61 * 60000; });
  await p.waitForTimeout(1500);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const out = {};
  const scenario = async (name, fn) => {
    const m0 = await metrics();
    await p.evaluate(() => { window.__stop = window.__rec(); });
    await fn();
    const f = (await p.evaluate(() => window.__stop())).slice(1);
    const m1 = await metrics(), d = k => +(m1[k] - m0[k]).toFixed(3);
    out[name] = { frames: f.length, p50: +pct(f, 50).toFixed(1), p95: +pct(f, 95).toFixed(1), max: +Math.max(...f).toFixed(1), over33: f.filter(x => x > 33.4).length, avgFps: +(1000 / (f.reduce((a, x) => a + x, 0) / f.length)).toFixed(1),
      layouts: d('LayoutCount'), styleRecalcs: d('RecalcStyleCount'), layoutMs: +(d('LayoutDuration') * 1000).toFixed(1), styleMs: +(d('RecalcStyleDuration') * 1000).toFixed(1), scriptMs: +(d('ScriptDuration') * 1000).toFixed(1), taskMs: +(d('TaskDuration') * 1000).toFixed(1) };
  };
  const box = await p.locator('#seats').boundingBox(), y = Math.round(box.y + box.height * .45);
  await scenario('swipe', async () => {
    for (let rep = 0; rep < 2; rep++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y }] });
      for (let k = 1; k <= 24; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120 + k * 8 * (rep ? -1 : 1), y }] }); await p.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await p.waitForTimeout(900);
    }
  });
  await scenario('tapToFront', async () => {
    for (const id of ['b6', 'b2', 'b8', 'b1']) { await p.evaluate(id => { const n = document.getElementById('nav-' + id); if (n && n.offsetParent) n.click(); else jumpTo(id, true); }, id); await p.waitForTimeout(800); }
  });
  await scenario('idle', async () => { await p.waitForTimeout(3000); });
  out.liteEngaged = await p.evaluate(() => document.body.classList.contains('lite'));
  await b.close();
  return out;
}
(async () => {
  let url = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null, srv = null;
  if (!url) { srv = await serve(); url = 'http://127.0.0.1:8777/'; }
  const r = await run(url, { css: process.env.PERF_CSS || '' });
  console.log(JSON.stringify(r, null, 1));
  if (srv) srv.close();
})().catch(e => { console.error(e); process.exit(1); });
