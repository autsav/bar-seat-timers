// Usage: node run.js [baseUrl]   (no URL = serve the repo root on http://127.0.0.1:8765/)
// Chrome path: CHROME_PATH env, default /usr/bin/google-chrome.
const { chromium, devices } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'tests', 'screenshots');
let BASE = process.argv[2];
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? passes++ : fails++; };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.md': 'text/plain' };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((q, r) => {
      let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end('nf'); }
      r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(f).pipe(r);
    }).listen(8765, '127.0.0.1', () => res(srv));
  });
}

// Mock Wake Lock + controllable visibility, injected before the page script runs.
const INIT = () => {
  window.__wake = { requests: 0, releases: 0, active: null };
  const mk = () => {
    const t = new EventTarget(); t.released = false; t.type = 'screen';
    t.release = async () => { if (!t.released) { t.released = true; window.__wake.releases++; t.dispatchEvent(new Event('release')); } };
    return t;
  };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.requests++; const s = mk(); window.__wake.active = s; return s; } } });
  window.__vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__vis !== 'visible' });
  window.__setVis = v => {
    window.__vis = v;
    if (v === 'hidden' && window.__wake.active) window.__wake.active.release();  // browsers drop the lock when hidden
    document.dispatchEvent(new Event('visibilitychange'));
  };
};

async function featureTests(browser, name, opts) {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text()); });
  p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  const r = await p.goto(BASE);
  ok(r && r.status() === 200, `${name}: HTTP ${r && r.status()}`);
  const seat = i => p.locator('#seat-b' + i);
  const timer = async i => (await seat(i).locator('.timer').textContent()).trim();
  const ev = f => p.evaluate(f);
  const tick = ms => p.clock.fastForward(ms);

  // --- walk-in only: single limit, no booking UI
  ok(await timer(1) === '1:00:00', `${name}: free seat shows default 60-min limit 1:00:00`);
  ok(await ev(() => !document.querySelector('.type-pick, [data-type], #setBooking, #setDefaultType') && !/booking/i.test(document.body.innerText + document.getElementById('settingsPanel').innerHTML)),
     `${name}: no booking UI anywhere (picker, tag, settings)`);
  await seat(1).locator('.btn-primary').click();
  await seat(2).locator('.btn-primary').click();
  await tick(1000);
  ok(await ev(() => seats.b1.limitMs === 3600000 && seats.b2.limitMs === 3600000 && !('type' in seats.b1)), `${name}: seats lock the 60-min limit at start`);

  // --- R3: wake lock acquired once a seat runs
  await tick(500);
  ok(await ev(() => window.__wake.requests) >= 1, `${name}: wake lock requested when a seat starts (${await ev(() => window.__wake.requests)})`);

  await tick(31 * 60000);
  ok((await seat(1).getAttribute('class')).includes('yellow'), `${name}: amber at 31 min`);
  await tick(15 * 60000);
  ok((await seat(1).getAttribute('class')).includes('red'), `${name}: red at 46 min`);

  // --- settings must not retime running seats
  const b1Before = await ev(() => getDurationMs(seats.b1)), b2Before = await ev(() => getDurationMs(seats.b2));
  await p.locator('#menuBtn').click();
  await p.locator('#menuPanel').getByRole('button', { name: /Settings/ }).click();
  await p.fill('#setWalkin', '30');
  await p.getByRole('button', { name: 'Save Settings' }).click();
  await tick(500);
  ok(await ev(() => getDurationMs(seats.b1)) === b1Before && await ev(() => getDurationMs(seats.b2)) === b2Before,
     `${name}: changing limits did not retime running B1/B2`);
  ok(await timer(3) === '30:00', `${name}: free seat picks up new walk-in limit (${await timer(3)})`);
  await seat(3).locator('.btn-primary').click(); await tick(500);
  ok(await ev(() => seats.b3.limitMs) === 30 * 60000, `${name}: new session uses new limit`);
  await p.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  await ev(() => toggleSettings && document.getElementById('settingsPanel').style.display === 'block' && toggleSettings());

  // --- R3: catch-up after the page was hidden (phone asleep)
  await ev(() => window.__setVis('hidden'));
  await tick(500);
  ok(await ev(() => window.__wake.releases) >= 1, `${name}: wake lock released when hidden`);
  const reqBefore = await ev(() => window.__wake.requests);
  // Phone asleep: wall clock jumps 16 min but no JS timers run at all.
  const now0 = await ev(() => Date.now());
  await p.clock.setSystemTime(new Date(now0 + 16 * 60000));
  ok(await ev(() => !seats.b1.timeUpNotified), `${name}: no alert fired while asleep (timers frozen)`);
  await ev(() => window.__setVis('visible'));
  await tick(300);
  ok(await ev(() => window.__wake.requests) > reqBefore, `${name}: wake lock re-acquired on visibilitychange`);
  const snack = (await p.locator('#snackText').textContent()) || '';
  ok(await p.locator('#snackbar').isVisible() && /While away/.test(snack) && /B1: time is up/.test(snack) && /B3 is amber/.test(snack),
     `${name}: missed alerts summarised on return ("${snack.slice(0, 70)}…")`);
  ok(await ev(() => seats.b1.timeUpNotified && seats.b1.warnedRed && seats.b3.warnedAmber && !seats.b3.warnedRed), `${name}: catch-up fires only the highest crossed alert per seat`);
  await tick(9000);

  // --- R1: undo End
  const h0 = await ev(() => history.length);
  await seat(1).locator('.btn-reset').click(); await tick(200);
  ok(await ev(() => !seats.b1.running) && await ev(() => history.length) === h0 + 1, `${name}: End frees B1 and logs history`);
  ok(await p.locator('#snackbar').isVisible() && /Ended B1/.test(await p.locator('#snackText').textContent()), `${name}: undo snackbar shown`);
  await p.locator('#snackUndo').click(); await tick(300);
  ok(await ev(() => seats.b1.running && seats.b1.limitMs === 3600000) && await ev(() => history.length) === h0, `${name}: Undo restores B1 and removes history row`);
  // Shift+N
  if (name === 'desktop') {
    await p.locator('h1').click();
    await p.keyboard.press('Shift+Digit2'); await tick(200);
    ok(await ev(() => !seats.b2.running), `${name}: Shift+2 ends B2`);
    await p.locator('#snackUndo').click(); await tick(200);
    ok(await ev(() => seats.b2.running && seats.b2.limitMs === 3600000), `${name}: Undo after Shift+2 restores B2`);
  }
  // Reset All + undo
  await ev(() => resetAll()); await tick(200);
  ok(await ev(() => SEAT_IDS.every(id => !seats[id].running)), `${name}: Reset All clears seats`);
  await p.locator('#snackUndo').click(); await tick(200);
  ok(await ev(() => seats.b1.running && seats.b2.running && seats.b3.running), `${name}: Undo after Reset All restores 3 seats`);
  // expiry
  await seat(3).locator('.btn-reset').click(); await tick(8500);
  ok(!(await p.locator('#snackbar').isVisible()), `${name}: snackbar expires after 8 s`);
  ok(await ev(() => undoState === null), `${name}: undo no longer available after expiry`);

  // End is not adjacent to +15 (own row, gap >= 8px)
  const gap = await ev(() => { const e = document.querySelector('#seat-b1 .btn-extend').getBoundingClientRect(), r = document.querySelector('#seat-b1 .btn-reset').getBoundingClientRect(); return { dy: r.top - e.bottom }; });
  ok(gap.dy >= 8, `${name}: End sits on its own row below +15 (${Math.round(gap.dy)}px gap)`);

  // history + CSV contain type
  await p.locator('#menuBtn').click();
  await p.locator('#menuPanel').getByRole('button', { name: /History/ }).click();
  ok(/30 min/.test(await p.locator('#historyTable').textContent()) && !/Walk-in|Booking/.test(await p.locator('#historyTable').textContent()), `${name}: history shows limit (no type)`);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('#historyPanel').getByRole('button', { name: /Export CSV/ }).click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(/^Seat,LimitMin,Notes,/.test(csv) && /\nb3,30,/.test(csv) && !/walkin|booking/i.test(csv), `${name}: CSV has LimitMin, no type`);
  await p.locator('#historyPanel').getByRole('button', { name: 'Close' }).click();

  // notes hint
  ok(/no names or personal data/.test(await seat(4).locator('.notes-input').getAttribute('placeholder')), `${name}: notes privacy hint`);

  // wake lock toggle off releases
  await ev(() => { document.getElementById('setWakeLock').checked = false; window.alert = () => {}; saveSettings(); });
  await tick(500);
  ok(await ev(() => window.__wake.active.released), `${name}: turning the wake-lock toggle off releases it`);

  // screenshot of service state
  await ev(() => { document.getElementById('setWakeLock').checked = true; saveSettings(); });
  await seat(5).locator('.btn-primary').click();
  await seat(6).locator('.btn-primary').click(); await tick(1000);
  await seat(6).locator('.btn-reset').click(); await tick(300);
  if (name === 'pixel7') ok(await ev(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal overflow`);
  ok(errs.length === 0, `${name}: no console errors ${errs.join(' | ')}`);
  await ctx.close();
}

// Old saved data from the booking version: booking settings dropped, running booking seat keeps its 90-min lock.
async function migrationAndShot(browser, name, opts) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  const T0 = new Date('2026-10-20T19:00:00').getTime();
  await p.clock.install({ time: T0 });
  await p.addInitScript(t0 => {
    if (localStorage.getItem('barSeatTimers.v2')) return;
    const blank = { running: false, paused: false, startTime: null, pausedAt: null, pausedTotal: 0, extraMs: 0, extensions: 0, notes: '', selected: false };
    const seats = {}; ['b1','b2','b3','b4','b5','b6','b7','b8'].forEach(id => seats[id] = { ...blank, nextType: 'booking' });
    seats.b4 = { ...blank, running: true, startTime: t0 - 10 * 60000, type: 'booking', limitMs: 90 * 60000, greenMs: 45 * 60000, amberMs: 67.5 * 60000,
                 warnedAmber: false, warnedRed: false, timeUpNotified: false, sessionStart: new Date(t0 - 600000).toISOString() };
    localStorage.setItem('barSeatTimers.v2', JSON.stringify({ seats,
      history: [{ seat: 'b1', type: 'booking', limitMin: 90, notes: '', durationMin: 88, extensions: 0, start: new Date(t0 - 9e6).toISOString(), end: new Date(t0 - 3.7e6).toISOString(), autoEnd: false }],
      settings: { walkinMin: 60, bookingMin: 90, defaultType: 'booking', greenPct: 50, amberPct: 75, wakeLock: true } }));
  }, T0);
  await p.goto(BASE);
  await p.clock.fastForward(500);
  const st = await p.evaluate(() => ({ s: settings, b4: seats.b4, b1: seats.b1, h: history[0], t4: document.querySelector('#seat-b4 .timer').textContent, t1: document.querySelector('#seat-b1 .timer').textContent }));
  ok(!('bookingMin' in st.s) && !('defaultType' in st.s) && st.s.walkinMin === 60, `${name}: migration drops booking settings`);
  ok(st.b4.running && st.b4.limitMs === 90 * 60000 && !('type' in st.b4) && /^1:20:0\d$|^1:19:5\d$/.test(st.t4), `${name}: running booking seat keeps locked 90-min limit (${st.t4})`);
  ok(!('nextType' in st.b1) && st.t1 === '1:00:00', `${name}: free seats use the 60-min limit after migration`);
  ok(!('type' in st.h) && st.h.limitMin === 90, `${name}: old history keeps its limit, type dropped`);
  await p.locator('#seat-b4 .btn-reset').click();
  await p.locator('#seat-b4 .btn-primary').click();
  await p.clock.fastForward(500);
  ok(await p.evaluate(() => seats.b4.limitMs === 3600000), `${name}: after it ends, B4 restarts on the 60-min limit`);
  await p.evaluate(() => { localStorage.clear(); });
  await ctx.close();

  // Fresh device, default settings: screenshot of a typical service
  const c2 = await browser.newContext({ ...opts, serviceWorkers: 'block' });
  const q = await c2.newPage(); q.on('pageerror', e => errs.push(e.message));
  await q.addInitScript(INIT);
  await q.clock.install({ time: T0 });
  await q.goto(BASE);
  const start = i => q.locator(`#seat-b${i} .btn-primary`).click();
  await start(1); await q.clock.fastForward(20 * 60000);
  await start(2); await start(5); await q.clock.fastForward(15 * 60000);
  await start(3); await q.clock.fastForward(12 * 60000);
  await start(6); await q.clock.fastForward(14 * 60000);
  await q.locator('#seat-b5 .btn-extend').click();
  await q.locator('#seat-b3 .btn-primary').click();   // pause B3
  await q.clock.fastForward(1000);
  fs.mkdirSync(SHOTS, { recursive: true });
  await q.screenshot({ path: path.join(SHOTS, `${TAG}-${name}-default60.png`), fullPage: true });
  ok(await q.evaluate(() => settings.walkinMin === 60 && seats.b1.limitMs === 3600000), `${name}: screenshot uses default 60-min settings`);
  ok(errs.length === 0, `${name}: no page errors (migration/screenshot) ${errs.join(' | ')}`);
  await c2.close();
}

function pngSize(buf) { return buf.slice(1, 4).toString() === 'PNG' ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null; }

async function pwaTests(browser, name, opts) {
  const ctx = await browser.newContext({ ...opts });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE);
  // manifest
  const href = await p.evaluate(() => document.querySelector('link[rel=manifest]')?.href);
  ok(!!href, `${name}: <link rel=manifest> present`);
  const mres = await p.request.get(href);
  ok(mres.status() === 200, `${name}: manifest HTTP ${mres.status()}`);
  const m = await mres.json();
  ok(m.name && m.short_name && m.start_url && ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display), `${name}: manifest has name/short_name/start_url/display=${m.display}`);
  for (const want of [192, 512]) {
    const ic = m.icons.find(i => i.sizes === `${want}x${want}` && (i.purpose || 'any').includes('any'));
    const ir = ic && await p.request.get(new URL(ic.src, href).href);
    const sz = ir && pngSize(Buffer.from(await ir.body()));
    ok(sz && sz[0] === want && sz[1] === want, `${name}: ${want}px PNG icon fetches with correct size`);
  }
  ok(m.icons.some(i => (i.purpose || '').includes('maskable')), `${name}: maskable icon listed`);
  // service worker
  await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
  await p.reload();
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  ok(true, `${name}: service worker active and controlling the page`);
  const cache = await p.evaluate(async () => { const k = await caches.keys(); const c = await caches.open(k.find(x => x.startsWith('bst-'))); return { keys: k, n: (await c.keys()).length }; });
  ok(cache.keys.some(k => /^bst-v/.test(k)) && cache.n >= 6, `${name}: versioned cache ${cache.keys.join(',')} holds ${cache.n} entries`);
  // offline reload
  await ctx.setOffline(true);
  await p.reload();
  const n = await p.locator('.seat').count();
  ok(n === 8, `${name}: offline reload still renders 8 seats`);
  await p.locator('#seat-b7 .btn-primary').click();
  ok(await p.evaluate(() => seats.b7.running), `${name}: timers work offline`);
  await ctx.setOffline(false);
  ok(errs.length === 0, `${name}: no page errors (PWA) ${errs.join(' | ')}`);
  await ctx.close();
}

// Chrome's own installability verdict needs a non-incognito profile.
async function installabilityCheck() {
  const dir = fs.mkdtempSync('/tmp/bst-prof-');
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: CHROME, args: ['--no-sandbox'], viewport: { width: 1366, height: 900 } });
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.goto(BASE);
  await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
  await p.reload();
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  const cdp = await ctx.newCDPSession(p);
  const ie = await cdp.send('Page.getInstallabilityErrors');
  const ids = (ie.installabilityErrors || []).map(e => e.errorId);
  ok(ids.length === 0, `desktop: Chrome installability errors: ${ids.join(',') || 'none (installable)'}`);
  const man = await cdp.send('Page.getAppManifest');
  ok((man.errors || []).length === 0, `desktop: Chrome manifest parse errors: ${(man.errors || []).map(e => e.message).join(',') || 'none'}`);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

let TAG;
(async () => {
  let srv = null;
  if (!BASE) { srv = await serve(); BASE = 'http://127.0.0.1:8765/'; }
  TAG = /github\.io/.test(BASE) ? 'live' : 'local';
  console.log(`Testing ${BASE}`);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  for (const [name, opts] of [['desktop', { viewport: { width: 1366, height: 900 } }], ['pixel7', devices['Pixel 7']]]) {
    await featureTests(browser, name, opts);
    await migrationAndShot(browser, name, opts);
    await pwaTests(browser, name, opts);
  }
  await browser.close();
  await installabilityCheck();
  if (srv) srv.close();
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
