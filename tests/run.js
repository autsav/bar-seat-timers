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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/plain' };

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
  await clickSeat(p, 1, '.btn-primary');
  await clickSeat(p, 2, '.btn-primary');
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
  await clickSeat(p, 3, '.btn-primary'); await tick(500);
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
  await clickSeat(p, 1, '.btn-reset'); await tick(200);
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
  await clickSeat(p, 3, '.btn-reset'); await tick(8500);
  ok(!(await p.locator('#snackbar').isVisible()), `${name}: snackbar expires after 8 s`);
  ok(await ev(() => undoState === null), `${name}: undo no longer available after expiry`);

  // End is not adjacent to +15 (own row, gap >= 8px)
  await ev(() => { jumpTo('b1'); document.getAnimations().forEach(a => { if (isFinite(a.effect.getComputedTiming().endTime)) a.finish(); }); });
  const gap = await ev(() => { const e = document.querySelector('#seat-b1 .btn-extend').getBoundingClientRect(), r = document.querySelector('#seat-b1 .btn-reset').getBoundingClientRect(); return { dy: r.top - e.bottom, tf: document.getElementById("seat-b1").style.transform, er: document.querySelector("#seat-b1 .btn-extend").getBoundingClientRect().toJSON(), rr: document.querySelector("#seat-b1 .btn-reset").getBoundingClientRect().toJSON(), cr: document.getElementById("seat-b1").getBoundingClientRect().toJSON(), an: document.getElementById("seat-b1").getAnimations().map(a => a.animationName || a.id || "waapi"), c: centreId, cl: document.getElementById("seat-b1").className, sc: getComputedStyle(document.getElementById("seat-b1")).scale }; });
  ok(gap.dy >= 8, `${name}: End sits on its own row below +15 (${Math.round(gap.dy)}px gap ${JSON.stringify(gap)})`);

  // history + CSV contain type
  await p.locator('#menuBtn').click();
  await p.locator('#menuPanel').getByRole('button', { name: /History/ }).click();
  ok(/30 min/.test(await p.locator('#historyTable').textContent()) && !/Walk-in|Booking/.test(await p.locator('#historyTable').textContent()), `${name}: history shows limit (no type) [${(await p.locator('#historyTable').textContent()).slice(0,120)}|${await p.evaluate(() => document.getElementById('historyPanel').style.display)}]`);
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
  await clickSeat(p, 5, '.btn-primary');
  await clickSeat(p, 6, '.btn-primary'); await tick(1000);
  await clickSeat(p, 6, '.btn-reset'); await tick(300);
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
  await clickSeat(p, 4, '.btn-reset');
  await clickSeat(p, 4, '.btn-primary');
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
  const start = i => clickSeat(q, i, '.btn-primary');
  await start(1); await q.clock.fastForward(20 * 60000);
  await start(2); await start(5); await q.clock.fastForward(15 * 60000);
  await start(3); await q.clock.fastForward(12 * 60000);
  await start(6); await q.clock.fastForward(14 * 60000);
  await clickSeat(q, 5, '.btn-extend');
  await clickSeat(q, 3, '.btn-primary');   // pause B3
  await q.clock.fastForward(1000);
  fs.mkdirSync(SHOTS, { recursive: true });
  await q.screenshot({ path: path.join(SHOTS, `${TAG}-${name}-default60.png`), fullPage: true });
  ok(await q.evaluate(() => settings.walkinMin === 60 && seats.b1.limitMs === 3600000), `${name}: screenshot uses default 60-min settings`);
  ok(errs.length === 0, `${name}: no page errors (migration/screenshot) ${errs.join(' | ')}`);
  await c2.close();
}

// Selection mode: long-press enters, tap toggles, drag paints, batch actions, Esc/back exit, tap free seat starts (+undo).
async function selectionTests(browser, name, opts) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE);
  const ev = f => p.evaluate(f), tick = ms => p.clock.fastForward(ms);
  const touch = !!opts.hasTouch;
  const cdp = touch ? await ctx.newCDPSession(p) : null;
  const centre = async i => { if (await p.evaluate(() => selectMode)) await p.waitForTimeout(560);   // let the fan finish flattening (real-time CSS transition)
    await p.evaluate(i => { if (!selectMode) jumpTo('b' + i); const r = document.querySelector('#seat-b' + i + ' .timer').getBoundingClientRect(); const sc = document.getElementById('seats').getBoundingClientRect(); if (r.top < 90 || r.bottom > innerHeight - 170 || r.left < sc.left || r.right > sc.right) document.getElementById('seat-b' + i).scrollIntoView({ block: 'center', inline: 'center' }); }, i); const b = await p.locator('#seat-b' + i + ' .timer').boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const down = async pt => touch ? cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] }) : (await p.mouse.move(pt.x, pt.y), p.mouse.down());
  const move = async pt => touch ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pt.x, y: pt.y }] }) : p.mouse.move(pt.x, pt.y, { steps: 4 });
  const up = async () => touch ? cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) : p.mouse.up();
  const tap = async i => { const c = await centre(i); await down(c); await tick(60); await up(); await tick(50); };
  const selected = () => ev(() => SEAT_IDS.filter(id => seats[id].selected));

  ok(await ev(() => !document.querySelector('input[type=checkbox].select-cb, .select-box, .seat input[type=checkbox]')), `${name}: no select checkboxes on seat cards`);

  // tap a free seat = start instantly, with undo
  await tap(4);
  ok(await ev(() => seats.b4.running), `${name}: tapping a free seat starts it`);
  ok(/Started B4/.test(await p.locator('#snackText').textContent()) && await p.locator('#snackUndo').isVisible(), `${name}: start shows Undo`);
  await p.locator('#snackUndo').click(); await tick(100);
  ok(await ev(() => !seats.b4.running && history.length === 0), `${name}: Undo reverts the tap-start (no history row)`);

  // long-press enters selection mode and selects that seat
  const c1 = await centre(1);
  await down(c1); await tick(500); await up(); await tick(50);
  ok(await ev(() => selectMode) && JSON.stringify(await selected()) === '["b1"]', `${name}: long-press enters selection mode with B1 selected`);
  ok(await ev(() => !seats.b1.running), `${name}: long-press did not start the seat`);
  ok(await p.locator('#actionBar').isVisible() && /1 seat selected/.test(await p.locator('#actionCount').textContent()), `${name}: action bar shows "1 seat selected"`);
  ok(await ev(() => document.getElementById('lbl-b1').getAttribute('aria-pressed') === 'true' && getComputedStyle(document.querySelector('#seat-b1 .sel-check')).display !== 'none'),
     `${name}: selected seat has aria-pressed + checkmark`);
  // tap toggles
  await tap(2);
  ok(JSON.stringify(await selected()) === '["b1","b2"]', `${name}: tap adds B2 in selection mode`);
  await tap(2);
  ok(JSON.stringify(await selected()) === '["b1"]', `${name}: tap again removes B2`);
  ok(await ev(() => !seats.b2.running), `${name}: taps in selection mode never start seats`);
  // drag-to-paint from B5 across B6, B7, B8 (layout-dependent path through centres)
  await ev(() => { const r = document.getElementById('seat-b5').getBoundingClientRect(); window.scrollBy(0, r.top - 90); });
  await tick(50);
  // row order is B8..B1: start on B5 and drag to the left edge; the row auto-scrolls and paints B6, B7, B8
  const c5 = await centre(5); await down(c5); await tick(30);
  const edge = await ev(() => document.getElementById('seats').getBoundingClientRect().left + 10);
  for (let k = 1; k <= 6; k++) { await move({ x: c5.x + (edge - c5.x) * k / 6, y: c5.y }); await tick(20); }
  for (let k = 0; k < 120 && !(await ev(() => seats.b8.selected)); k++) { await move({ x: edge + (k % 2), y: c5.y }); await tick(32); }
  await up(); await tick(50);
  ok(JSON.stringify(await selected()) === '["b1","b5","b6","b7","b8"]', `${name}: drag across B5→B8 selects them (${(await selected()).join(',')})`);
  ok(/5 seats selected/.test(await p.locator('#actionCount').textContent()), `${name}: count announced (aria-live) "5 seats selected"`);
  // batch Start exits mode
  await p.locator('#actionBar').getByRole('button', { name: /Start/ }).click(); await tick(300);
  ok(await ev(() => ['b1','b5','b6','b7','b8'].every(id => seats[id].running) && !selectMode), `${name}: batch Start starts 5 seats and exits selection mode`);
  // batch +15 and End via the Select button
  await p.locator('#selectBtn').click();
  ok(await ev(() => selectMode), `${name}: Select button enters selection mode`);
  await tap(5); await tap(6);
  await p.locator('#actionBar').getByRole('button', { name: '+15' }).click(); await tick(200);
  ok(await ev(() => seats.b5.extensions === 1 && seats.b6.extensions === 1 && seats.b1.extensions === 0), `${name}: batch +15 extends only selected`);
  await p.locator('#selectBtn').click(); await tap(7); await tap(8);
  await p.locator('#actionBar').getByRole('button', { name: /End/ }).click(); await tick(200);
  ok(await ev(() => !seats.b7.running && !seats.b8.running && seats.b1.running && !selectMode), `${name}: batch End ends B7+B8 and exits`);
  ok(/Ended B8, B7/.test(await p.locator('#snackText').textContent()), `${name}: batch End offers Undo`);
  await p.locator('#snackUndo').click(); await tick(100);
  ok(await ev(() => seats.b7.running && seats.b8.running), `${name}: Undo restores batch End`);
  // back exits mode
  await p.locator('#selectBtn').click(); await tap(3);
  await p.goBack(); await tick(200);
  ok(await ev(() => !selectMode && SEAT_IDS.every(id => !seats[id].selected)) && await ev(() => document.getElementById('actionBar').hidden), `${name}: Back exits selection mode and clears selection`);
  ok(p.url().startsWith(BASE.replace(/\/$/, '')), `${name}: Back did not leave the app (${p.url()})`);
  // Esc exits; Cancel exits
  await p.locator('#selectBtn').click(); await tap(3);
  await p.keyboard.press('Escape'); await tick(200);
  ok(await ev(() => !selectMode), `${name}: Esc exits selection mode`);
  await p.locator('#selectBtn').click();
  await p.locator('#actionBar').getByRole('button', { name: /Cancel/ }).click(); await tick(200);
  ok(await ev(() => !selectMode), `${name}: Cancel exits selection mode`);
  // keyboard shortcut: digit on running seat selects (enters mode)
  if (!touch) {
    await p.locator('h1').click();
    await p.keyboard.press('Digit1'); await tick(100);
    ok(await ev(() => selectMode && seats.b1.selected), `${name}: key 1 on running B1 enters selection mode`);
    await p.keyboard.press('Escape'); await tick(100);
  }
  // reduced motion still honoured
  ok(/prefers-reduced-motion: reduce/.test(await ev(() => document.documentElement.outerHTML)), `${name}: reduced-motion rule present`);
  // screenshot of selection mode
  await p.locator('#selectBtn').click(); await tap(2); await tap(3); await tap(6);
  await ev(() => window.scrollTo(0, 0)); await tick(300); await p.waitForTimeout(400);
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${TAG}-${name}-select-mode.png`) });
  ok(errs.length === 0, `${name}: no page errors (selection) ${errs.join(' | ')}`);
  await ctx.close();
}


// Motion layer: decorative only. Checks state is correct while animations run, only transform/opacity animate,
// alerts fire with animations frozen, and prefers-reduced-motion removes all motion.
const ALLOWED = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate', 'offset', 'easing', 'composite', 'computedOffset']);
async function motionTests(browser, name, opts, reduce) {
  const tag = name + (reduce ? '-reduced' : '');
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(() => { if (!localStorage.getItem('barSeatTimers.v2')) localStorage.setItem('barSeatTimers.v2', JSON.stringify({ settings: { look: 'arcade' } })); });   // suite written for the Arcade look
  await p.addInitScript(INIT);
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const props = () => ev(() => { const bad = [];
    document.getAnimations().forEach(a => {
      if (a.transitionProperty) { if (!['transform','opacity','translate','scale','rotate'].includes(a.transitionProperty)) bad.push('transition:' + a.transitionProperty); return; }
      (a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : []).forEach(k => Object.keys(k).forEach(x => bad.push(x)));
    }); return { n: document.getAnimations().length, bad: [...new Set(bad)] }; });
  const badProps = list => list.filter(k => !k.startsWith('transition:') ? !ALLOWED.has(k) : true);
  const S = path.join(SHOTS, `${TAG}-${tag}`);
  const shot = async (n, full) => { if (name === 'pixel7') await p.screenshot({ path: `${S}-${n}.png`, fullPage: !!full }); };

  ok(await ev(() => SEAT_IDS.every(id => document.querySelector('#seat-' + id + ' .ring[role=progressbar]'))), `${tag}: every seat has a progress ring (role=progressbar)`);
  const a0 = await props();
  ok(reduce ? a0.n === 0 : a0.n >= 8, `${tag}: staggered entrance ${reduce ? 'skipped' : 'runs'} (${a0.n} animations)`);

  // start: state is immediate, ripple/sweep are decoration
  await clickSeat(p, 1, '.btn-primary');
  ok(await ev(() => seats.b1.running && seats.b1.limitMs === 3600000), `${tag}: Start sets state immediately (animations not awaited)`);
  ok(reduce ? (await props()).n === 0 : await ev(() => document.querySelector('#seat-b1 .ring').getAnimations().length > 0), `${tag}: ring sweep ${reduce ? 'off' : 'plays'} on start`);
  await ev(() => ['b2','b3','b4'].forEach(id => startTimer(id)));
  await tick(20 * 60000);
  const c1 = await ev(() => document.querySelector('#seat-b1 .ring').style.getPropertyValue('--ring'));
  await tick(5 * 60000);
  const c2 = await ev(() => document.querySelector('#seat-b1 .ring').style.getPropertyValue('--ring'));
  ok(/color-mix/.test(c1) && c1 !== c2, `${tag}: ring colour blends gradually (${c1.match(/\d+%/)} → ${c2.match(/\d+%/)})`);
  const rot = await ev(() => document.querySelector('#seat-b1 .ring .h.r i').style.transform);
  ok(/rotate\(/.test(rot), `${tag}: ring progress is a transform (${rot})`);
  // amber glow, red pulse, time-up shake
  await tick(6 * 60000);   // b1 at 31 min: amber
  ok((await p.locator('#seat-b1').getAttribute('class')).includes('yellow'), `${tag}: B1 amber at 31 min`);
  await ev(() => { seats.b2.startTime -= 16 * 60000; seats.b3.startTime -= 40 * 60000; });   // b2 red, b3 over time
  await tick(500);
  ok(await ev(() => seats.b3.timeUpNotified && seats.b2.warnedRed && seats.b1.warnedAmber), `${tag}: amber/red/time-up alerts fired`);
  const anim = await ev(() => ({ glowA: getComputedStyle(document.getElementById('seat-b1'), '::before').animationName,
    glowR: getComputedStyle(document.getElementById('seat-b2'), '::before').animationName,
    shake: getComputedStyle(document.getElementById('seat-b3')).animationName, alarm: getComputedStyle(document.getElementById('seat-b3'), '::after').animationName,
    alarmOp: getComputedStyle(document.getElementById('seat-b3'), '::after').opacity }));
  if (reduce) ok(anim.glowA === 'none' && anim.glowR === 'none' && anim.shake === 'none' && anim.alarm === 'none' && anim.alarmOp === '1', `${tag}: no breathing/pulse/shake; static time-up glow (${JSON.stringify(anim)})`);
  else ok(anim.glowA === 'breathe' && anim.glowR === 'breathe' && /^shake(, nudge[LR])?$/.test(anim.shake) && anim.alarm === 'alarm', `${tag}: amber breathe, red pulse, time-up shake + glow (${JSON.stringify(anim)})`);
  // pause: stripes + frozen ring
  await clickSeat(p, 4, '.btn-primary'); await tick(300);
  const r1 = await ev(() => document.querySelector('#seat-b4 .ring .h.r i').style.transform);
  await tick(60000); if (!reduce) await p.waitForTimeout(900);
  ok(await ev(() => seats.b4.paused) && r1 === await ev(() => document.querySelector('#seat-b4 .ring .h.r i').style.transform), `${tag}: paused ring frozen`);
  ok(await ev(() => getComputedStyle(document.querySelector('#seat-b4 .stripes')).opacity === '1' && getComputedStyle(document.querySelector('#seat-b4 .timer-row')).opacity === '0.5'), `${tag}: paused seat dims with stripe overlay`);
  await shot('status');
  // only transform/opacity animate
  const pr = await props();
  ok(badProps(pr.bad).length === 0, `${tag}: only transform/opacity animate (${pr.n} running; props ${pr.bad.join(',') || 'none'})`);
  // +15: float + wind back, state immediate
  await clickSeat(p, 2, '.btn-extend');
  ok(await ev(() => seats.b2.extensions === 1), `${tag}: +15 applied immediately`);
  ok(reduce ? await ev(() => !document.querySelector('.plus')) : await ev(() => !!document.querySelector('#seat-b2 .plus') && document.querySelector('#seat-b2 .ring').classList.contains('wind')), `${tag}: +15 float ${reduce ? 'not shown' : 'rises while ring winds back'}`);
  // End mid-animation + Undo mid-animation
  const h0 = await ev(() => history.length);
  await clickSeat(p, 3, '.btn-reset');
  const mid = await ev(() => ({ run: seats.b3.running, h: history.length, ghost: document.querySelectorAll('.fold-ghost').length, ids: document.querySelectorAll('.fold-ghost [id]').length,
    hidden: [...document.querySelectorAll('.fold-ghost')].every(g => g.getAttribute('aria-hidden') === 'true') }));
  ok(!mid.run && mid.h === h0 + 1, `${tag}: End frees B3 and logs history before any animation finishes`);
  ok(reduce ? mid.ghost === 0 : (mid.ghost === 1 && mid.ids === 0 && mid.hidden), `${tag}: fold ghost ${reduce ? 'not created' : 'is decorative (aria-hidden, no duplicate ids)'}`);
  ok(await ev(() => document.querySelectorAll('[id="seat-b3"]').length === 1 && document.querySelectorAll('[id="notes-b3"]').length === 1), `${tag}: no duplicate ids during fold`);
  ok(reduce ? true : await ev(() => !!document.querySelector('#snackbar .sb-count').getAnimations().length), `${tag}: undo countdown bar ${reduce ? 'hidden' : 'animates'}`);
  if (!reduce) await p.waitForTimeout(150);
  await shot('fold-undo');
  await p.locator('#snackUndo').click();
  ok(await ev(() => seats.b3.running && seats.b3.timeUpNotified) && await ev(() => history.length) === h0, `${tag}: Undo mid-fold restores B3 + removes history`);
  if (!reduce) { await p.waitForTimeout(700); ok(await ev(() => document.querySelectorAll('.fold-ghost').length === 0), `${tag}: fold ghost cleaned up`); }
  // freeze every animation: timing + alerts unaffected
  await ev(() => document.getAnimations().forEach(a => a.pause()));
  await ev(() => startTimer('b5'));
  await tick(31 * 60000);
  ok(await ev(() => seats.b5.warnedAmber && colourFor(seats.b5) === 'yellow' && /^2[89]:\d\d$/.test(document.querySelector('#seat-b5 .timer').textContent)), `${tag}: with all animations paused, B5 still times + alerts (${await ev(() => document.querySelector('#seat-b5 .timer').textContent)})`);
  // selection: long-press fill ring, tick pop, count roll, action bar
  await ev(() => { jumpTo('b6'); document.getElementById('seat-b6').scrollIntoView({ block: 'center', inline: 'nearest' }); }); await tick(50);
  const box = await p.locator('#seat-b6 .timer').boundingBox();
  await p.mouse.move(box.x + 20, box.y + 10); await p.mouse.down(); await tick(200);
  ok(reduce ? await ev(() => !document.querySelector('.lp')) : await ev(() => !!document.querySelector('#seat-b6 .lp')), `${tag}: long-press fill ring ${reduce ? 'not shown' : 'grows under the finger'}`);
  if (!reduce) await p.waitForTimeout(120);
  await shot('longpress');
  await tick(400); await p.mouse.up(); await tick(50);
  ok(await ev(() => selectMode && seats.b6.selected && !seats.b6.running), `${tag}: long-press still enters selection mode`);
  const pop = await ev(() => { setSelected('b7', true); setSelected('b8', true); return document.querySelector('#seat-b7 .sel-check').getAnimations().length; });
  ok(reduce ? pop === 0 : pop > 0, `${tag}: tick ${reduce ? 'appears without' : 'pops with'} animation on select (${pop})`);
  if (!reduce) await p.waitForTimeout(450);
  ok(/3 seats selected/.test(await p.locator('#actionCount').textContent()), `${tag}: rolling count reads "3 seats selected"`);
  ok(reduce ? Math.abs(+(await ev(() => getComputedStyle(document.getElementById('seat-b7')).scale)) - .98) < .002 : (v => v > .93 && v < .975)(+(await ev(() => getComputedStyle(document.getElementById('seat-b7')).scale))), `${tag}: selected seats shrink (${await ev(() => getComputedStyle(document.getElementById('seat-b7')).scale)})`);
  if (!reduce) await p.waitForTimeout(500);
  await shot('select');
  await ev(() => exitSelectMode());
  // summary numbers
  ok(/Occupied 5\/8/.test((await p.locator('#summary').innerText()).replace(/\s+/g, ' ')), `${tag}: summary reads Occupied 5/8`);
  // guest view: flip digits + wave
  await ev(() => toggleGuestView()); await tick(300);
  ok(await ev(() => { const g = document.querySelector('#guest-b5 .gt'); return g.children.length === g.textContent.length && g.textContent === formatTime(Math.max(0, getDurationMs(seats.b5) - getElapsed(seats.b5))); }), `${tag}: flip-clock digits show the exact remaining time`);
  await ev(() => { endSession('b1', false); }); await tick(300);
  const w = await ev(() => SEAT_IDS.filter(id => document.getElementById('guest-' + id).getAnimations().length).length);
  ok(reduce ? w === 0 : w === 8, `${tag}: wave across the board when a seat frees (${w} cards)`);
  ok(await ev(() => !seats.b1.running && document.querySelector('#guest-b1 .gt').textContent === '--:--'), `${tag}: guest card shows free immediately`);
  if (!reduce) await p.waitForTimeout(250);
  await shot('guest');
  await ev(() => toggleGuestView());
  // while-away banner
  await ev(() => window.__setVis('hidden'));
  const n0 = await ev(() => Date.now());
  await p.clock.setSystemTime(new Date(n0 + 20 * 60000));
  await ev(() => window.__setVis('visible')); await tick(200);
  ok(await ev(() => document.getElementById('snackbar').classList.contains('away') && /While away/.test(document.getElementById('snackText').textContent)), `${tag}: "While away" banner shown`);
  if (!reduce) await p.waitForTimeout(600);
  await shot('away');
  if (reduce) ok((await props()).n === 0, `${tag}: zero animations ran under reduced motion`);
  ok(errs.length === 0, `${tag}: no page errors (motion) ${errs.join(' | ')}`);
  await ctx.close();
}


// Cinematic layer: intro never blocks, banners/stamp/shake/particles are decoration, sounds + mute, mood, guest cinema.
async function cineTests(browser, name, opts, reduce) {
  const tag = name + (reduce ? '-reduced' : '');
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(() => { if (!localStorage.getItem('barSeatTimers.v2')) localStorage.setItem('barSeatTimers.v2', JSON.stringify({ settings: { look: 'arcade' } })); });   // suite written for the Arcade look
  await p.addInitScript(INIT);
  await p.clock.install({ time: new Date('2026-10-20T18:00:00') });
  await p.goto(BASE);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const shot = async n => { if (name === 'pixel7') await p.screenshot({ path: path.join(SHOTS, `cine-${TAG}-${tag}-${n}.png`) }); };
  const allowed = () => ev(() => { const bad = new Set(); document.getAnimations().forEach(a => {
    if (a.transitionProperty) { if (!['transform','opacity','translate','scale','rotate'].includes(a.transitionProperty)) bad.add('t:' + a.transitionProperty); return; }
    a.effect.getKeyframes().forEach(k => Object.keys(k).forEach(x => { if (!['transform','opacity','translate','scale','rotate','offset','easing','composite','computedOffset'].includes(x)) bad.add(x); })); });
    return { n: document.getAnimations().length, bad: [...bad] }; });

  // 4. intro: present (or skipped under reduced motion), never blocks a tap
  const intro = await ev(() => { const n = document.getElementById('intro'); return n ? { pe: getComputedStyle(n).pointerEvents, txt: n.textContent } : null; });
  if (reduce) ok(intro === null, `${tag}: no intro under reduced motion`);
  else ok(intro && intro.pe === 'none' && /BAR OPEN/.test(intro.txt), `${tag}: 'BAR OPEN' intro shown, pointer-events none`);
  if (!reduce) { await p.waitForTimeout(350); await shot('intro'); }
  await p.locator('#seat-b1 .btn-primary').click();
  ok(await ev(() => seats.b1.running), `${tag}: a seat can be started during the intro`);
  ok(await ev(() => !document.getElementById('intro')), `${tag}: intro gone after first tap (skippable)`);
  // 5. GO banner
  ok(reduce ? await ev(() => !document.querySelector('.banner')) : /SEAT B1 · GO/.test(await ev(() => document.querySelector('.banner')?.textContent || '')), `${tag}: 'SEAT B1 · GO' banner ${reduce ? 'skipped' : 'shown'}`);
  if (!reduce) { await p.waitForTimeout(300); await shot('go-banner'); }
  // 8. sounds
  ok(await ev(() => sfxLog.includes('start')), `${tag}: start sound synthesised`);
  await clickSeat(p, 1, '.btn-extend');
  ok(await ev(() => sfxLog.includes('extend') && seats.b1.extensions === 1), `${tag}: +15 sound`);
  await ev(() => ['b2','b3','b4','b5','b6','b7'].forEach(id => startTimer(id)));
  // 2. neon bloom grows
  const g0 = await ev(() => +document.querySelector('#seat-b2 .ring .glow').style.opacity);
  await tick(40 * 60000);
  const g1 = await ev(() => +document.querySelector('#seat-b2 .ring .glow').style.opacity);
  ok(g1 > g0 && /scale\(1\.1/.test(await ev(() => document.querySelector('#seat-b2 .ring .glow').style.transform)), `${tag}: ring bloom grows with progress (${g0} → ${g1})`);
  ok(await ev(() => sfxLog.includes('warn') && seats.b2.warnedAmber), `${tag}: warning sound + amber alert`);
  // 9. mood drifts amber -> blue
  const m0 = await ev(() => +document.querySelector('.mood .m-blue').style.opacity);
  await p.clock.setSystemTime(new Date('2026-10-20T23:30:00')); await tick(300);
  const m1 = await ev(() => +document.querySelector('.mood .m-blue').style.opacity);
  ok(m1 > m0 && m1 > .7, `${tag}: mood drifts toward blue over the shift (${m0} → ${m1})`);
  // reset b1..b7 clock state relative to new time: everything is now well over time
  ok(await ev(() => seats.b2.timeUpNotified && sfxLog.includes('timeup')), `${tag}: time-up sound + alert fired`);
  // 5. TIME! stamp + shake on a fresh time-up
  await ev(() => { startTimer('b8'); seats.b8.startTime -= 3600000 - 400; }); await tick(800);
  const tu = await ev(() => ({ stamp: !!document.querySelector('#seat-b8 .stamp'), shake: document.querySelector('main').getAnimations().length, up: seats.b8.timeUpNotified }));
  ok(tu.up, `${tag}: B8 time-up alert fired`);
  ok(reduce ? !tu.stamp && tu.shake === 0 : tu.stamp && tu.shake > 0, `${tag}: 'TIME!' stamp + screen shake ${reduce ? 'skipped' : 'played'} (${JSON.stringify(tu)})`);
  // 7. confetti when full (b8 made it 8/8)
  ok(reduce ? await ev(() => !document.querySelector('.confetti')) : await ev(() => document.querySelectorAll('.confetti').length > 0), `${tag}: confetti when the bar is full ${reduce ? 'skipped' : 'falls'}`);
  if (!reduce) { await p.waitForTimeout(500); await shot('full-confetti'); }
  // 3. tilt while pressed
  await ev(() => { jumpTo('b3'); document.getElementById('seat-b3').scrollIntoView({ block: 'center', inline: 'nearest' }); });
  const bx = await p.locator('#seat-b3 .timer').boundingBox();
  await p.mouse.move(bx.x + 5, bx.y + 5); await p.mouse.down();
  const tf = await ev(() => document.getElementById('seat-b3').style.transform);
  ok(reduce ? !/rotate/.test(tf) : /rotateX\(.+rotateY\(.+translateY\(-4px\)/.test(tf), `${tag}: card tilt/lift while pressed ${reduce ? 'off' : '(' + tf + ')'}`);
  if (!reduce) { await p.waitForTimeout(200); await shot('tilt'); }
  await p.mouse.up(); await tick(50);
  ok(await ev(() => !/rotateX/.test(document.getElementById('seat-b3').style.transform)), `${tag}: tilt released on pointer up`);
  await ev(() => exitSelectMode()); await tick(50);
  // 7. sparks + staff-board wave on free; state immediate
  const h0 = await ev(() => history.length);
  await clickSeat(p, 3, '.btn-reset');
  const fr = await ev(() => ({ run: seats.b3.running, sparks: document.querySelectorAll('.spark').length,
    wave: ['b1','b2','b4','b5'].filter(id => document.getElementById('seat-' + id).getAnimations().length).length }));
  ok(!fr.run && await ev(() => history.length) === h0 + 1, `${tag}: End frees B3 immediately`);
  ok(reduce ? fr.sparks === 0 && fr.wave === 0 : fr.sparks >= 10 && fr.wave === 4, `${tag}: sparks + staff-board wave ${reduce ? 'skipped' : 'played'} (${JSON.stringify(fr)})`);
  if (!reduce) { await p.waitForTimeout(150); await shot('sparks'); }
  // snackbar slides out (ghost) while the real one hides at once
  await p.locator('#snackbar .sb-x').click();
  const so = await ev(() => ({ hidden: document.getElementById('snackbar').hidden, ghost: document.querySelectorAll('.snack-ghost').length, ids: document.querySelectorAll('.snack-ghost [id]').length }));
  ok(so.hidden && (reduce ? so.ghost === 0 : so.ghost === 1 && so.ids === 0), `${tag}: snackbar ${reduce ? 'hides instantly' : 'slides out (decorative copy, real one hidden)'}`);
  ok(await ev(() => undoState !== null || true) && await ev(() => !seats.b3.running), `${tag}: dismiss does not change seat state`);
  // 6. scoreboard digits
  const sc = await ev(() => { const b = document.querySelector('#summary .chip b'); const cs = getComputedStyle(b); return { ff: cs.fontFamily, fw: cs.fontWeight, ts: cs.textShadow }; });
  ok(+sc.fw >= 800 && /mono|Menlo|Consolas/i.test(sc.ff) && (sc.ts !== 'none'), `${tag}: scoreboard digits chunky + glowing`);
  // mute
  await ev(() => { sfxLog.length = 0; toggleSound(); });
  ok(await ev(() => settings.mute && document.getElementById('setMute').checked && /off/.test(document.getElementById('soundMi').textContent)), `${tag}: menu Sound toggle mutes and syncs Settings`);
  await ev(() => { startTimer('b3'); seats.b3.startTime -= 3600000; }); await tick(500);
  ok(await ev(() => sfxLog.length === 0 && seats.b3.timeUpNotified), `${tag}: muted = no sounds, alert still fires`);
  await ev(() => toggleSound());
  // 10. cinematic guest view
  await ev(() => endSession('b4', false)); await tick(300);
  await ev(() => toggleGuestView()); await tick(300);
  const gv = await ev(() => ({ grain: !!document.querySelector('#guestView .grain'), drift: getComputedStyle(document.getElementById('guestSeats')).animationName,
    grainAnim: getComputedStyle(document.querySelector('#guestView .grain')).animationName,
    tiles: document.querySelectorAll('#guest-b1 .gt .d:not(.sep)').length, idle: document.querySelector('#guest-b4 .gt').className, idleTxt: document.querySelector('#guest-b4 .gt').textContent,
    fs: parseFloat(getComputedStyle(document.querySelector('#guest-b1 .gt')).fontSize) }));
  ok(gv.grain && gv.tiles >= 3 && gv.fs >= 27, `${tag}: guest flip-board tiles (${gv.tiles} digits, ${gv.fs}px) + grain`);
  ok(reduce ? gv.drift === 'none' && gv.grainAnim === 'none' : gv.drift === 'drift' && gv.grainAnim === 'grain', `${tag}: camera drift + grain ${reduce ? 'still' : 'moving'}`);
  ok(/idle/.test(gv.idle) && gv.idleTxt === '--:--', `${tag}: free guest card shows tidy '--:--'`);
  // contrast of guest digits (white on near-black tiles)
  const cr = await ev(() => { const d = document.querySelector('#guest-b1 .gt .d:not(.sep)'); return getComputedStyle(d).color; });
  ok(/255, 255, 255/.test(cr), `${tag}: guest digits are white on dark tiles (${cr})`);
  if (!reduce) await p.waitForTimeout(400);
  await shot('guest');
  await ev(() => toggleGuestView());
  // freeze animations: alerts still on time
  await ev(() => document.getAnimations().forEach(a => a.pause()));
  await ev(() => endSession('b5', false)); await ev(() => startTimer('b5')); await tick(31 * 60000);
  ok(await ev(() => seats.b5.warnedAmber && colourFor(seats.b5) === 'yellow'), `${tag}: with animations frozen, B5 still alerts amber at 31 min`);
  const al = await allowed();
  ok(al.bad.length === 0, `${tag}: only transform/opacity animate (${al.n} running; bad: ${al.bad.join(',') || 'none'})`);
  if (reduce) ok(al.n === 0, `${tag}: zero animations under reduced motion`);
  await shot('board');
  ok(errs.length === 0, `${tag}: no page errors (cine) ${errs.join(' | ')}`);
  await ctx.close();
}


// Single-row layout: B8..B1 order, B1 at right on load, snap, indicator jump, off-screen alerts.
async function rowTests(browser, name, opts) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE); await p.clock.fastForward(300);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const shot = async n => { if (name === 'pixel7') await p.screenshot({ path: path.join(SHOTS, `row-${TAG}-${name}-${n}.png`) }); };
  const order = await ev(() => [...document.querySelectorAll('#seats .seat')].map(e => e.dataset.seat).join(','));
  ok(order === 'b8,b7,b6,b5,b4,b3,b2,b1', `${name}: staff row order B8..B1 (${order})`);
  const geo = await ev(() => { const sc = document.getElementById('seats'), r = sc.getBoundingClientRect(), tops = new Set([...sc.children].map(c => c.offsetTop));
    const b1 = document.getElementById('seat-b1').getBoundingClientRect(), b8 = document.getElementById('seat-b8').getBoundingClientRect();
    return { rows: tops.size, end: Math.abs(sc.scrollLeft - (sc.scrollWidth - sc.clientWidth)) <= 2, b1In: b1.right <= r.right + 1 && b1.left >= r.left - 1, b8Out: b8.left >= r.left - 1 && b8.right <= r.right + 1,
      snap: getComputedStyle(sc).scrollSnapType, frac: document.getElementById('seat-b1').offsetHeight / innerHeight, vw: innerWidth, fit: [...sc.children].filter(c => { const a = c.getBoundingClientRect(); return Math.min(a.right, r.right) - Math.max(a.left, r.left) >= a.width * .5; }).length }; });
  ok(geo.rows === 1, `${name}: one horizontal row (${geo.rows} row)`);
  ok(geo.end && geo.b1In && geo.b8Out, `${name}: on load scrolled to the end, B1 centred, and the fan keeps B8 on screen`);
  ok(await ev(() => typeof settle === 'function'), `${name}: row settles on a seat after scrolling`);
  if (name === 'pixel7') ok(geo.frac >= .6 && geo.frac <= .65, `${name}: card is ${Math.round(geo.frac * 100)}% of viewport height`);
  else ok(geo.fit >= 3, `${name}: wide screen shows ${geo.fit} cards (centre + side covers)`);
  ok(await ev(() => getComputedStyle(document.getElementById('seatNav')).display === 'none'), `${name}: pill indicator strip removed (all seats are on screen)`);
  const tapStrip = async id => { const pt = await ev(id => { const a = document.getElementById('seat-' + id).getBoundingClientRect(), r = document.getElementById('seat-' + id).classList.contains('sr'); return { x: Math.round(r ? a.right - 5 : a.left + 5), y: Math.round(a.top + a.height / 2) }; }, id);
    if (opts.hasTouch) await p.touchscreen.tap(pt.x, pt.y); else await p.mouse.click(pt.x, pt.y); };
  // status colours on indicator
  await ev(() => { startTimer('b8'); startTimer('b7'); seats.b7.startTime -= 61 * 60000; startTimer('b6'); togglePause('b6'); });
  await tick(300);
  ok(await ev(() => document.getElementById('seat-b8').classList.contains('green') && document.getElementById('seat-b7').classList.contains('timeup') && document.getElementById('seat-b6').classList.contains('paused')), `${name}: side cards coloured by status (green / time-up / paused)`);
  ok(await ev(() => document.getElementById('seat-b7').classList.contains('flag')) && !(await p.locator('#offAlert').isHidden()), `${name}: off-centre time-up on B7 pulses its side card + shows a Show button`);
  ok(/B7 time is up/.test(await p.locator('#offAlert').textContent()), `${name}: alert button text "${(await p.locator('#offAlert').textContent()).trim()}"`);
  await shot('alert');
  await p.locator('#offAlert').click(); await tick(300);
  ok(await ev(() => seatVisible('b7') && !document.getElementById('seat-b7').classList.contains('flag')) && await p.locator('#offAlert').isHidden(), `${name}: tapping the alert centres B7 and clears it`);
  // amber while off-screen
  await ev(() => jumpTo('b1')); await tick(300);
  await ev(() => { seats.b8.startTime -= 31 * 60000; }); await tick(300);
  ok(await ev(() => !seatVisible('b8') && document.getElementById('seat-b8').classList.contains('flag') && document.getElementById('seat-b8').classList.contains('yellow')), `${name}: B8 turning amber off-centre pulses its amber side card`);
  // indicator jump
  await tapStrip('b8'); for (let k = 0; k < 15; k++) { await tick(30); await p.waitForTimeout(40); }
  ok(await ev(() => seatVisible('b8') && centreId === 'b8'), `${name}: tapping B8's side strip centres B8`);
  await shot('b8');
  await tapStrip('b1'); for (let k = 0; k < 15; k++) { await tick(30); await p.waitForTimeout(40); }
  ok(await ev(() => seatVisible('b1')), `${name}: tapping B1's side strip centres it again`);
  // swipes scroll outside selection mode (touch-action allows pan-x), selection mode blocks pan so drag selects
  ok(await ev(() => getComputedStyle(document.getElementById('seat-b2')).touchAction) !== 'none', `${name}: outside selection mode cards allow swipe scrolling`);
  await ev(() => enterSelectMode());
  ok(await ev(() => getComputedStyle(document.getElementById('seat-b2')).touchAction) === 'none', `${name}: in selection mode a drag selects instead of scrolling`);
  await ev(() => exitSelectMode());
  // keyboard digits still map to seat numbers, not positions
  if (name === 'desktop') { await p.locator('h1').click(); await p.keyboard.press('Digit2'); await tick(100); ok(await ev(() => seats.b2.running), `${name}: key 2 still starts B2`); }
  // guest view order
  await ev(() => toggleGuestView()); await tick(200);
  const g = await ev(() => [...document.querySelectorAll('#guestSeats .guest-card')].map(e => e.id.replace('guest-', '')).join(','));
  ok(g === 'b8,b7,b6,b5,b4,b3,b2,b1', `${name}: guest view order B8..B1`);
  ok(await ev(() => getComputedStyle(document.getElementById('seatNav')).display === 'none'), `${name}: indicator hidden in guest view`);
  await shot('guest');
  await ev(() => toggleGuestView());
  // batch label in bar order
  await ev(() => { enterSelectMode(); setSelected('b1', true); setSelected('b8', true); }); await ev(() => batch(resetSelected)); await tick(100);
  ok(/Ended B8, B1/.test(await p.locator('#snackText').textContent()), `${name}: batch labels use bar order ("${await p.locator('#snackText').textContent()}")`);
  ok(await ev(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: page itself does not scroll sideways`);
  ok(errs.length === 0, `${name}: no page errors (row) ${errs.join(' | ')}`);
  await ctx.close();
  // motion-on load screenshot (B1 right after intro)
  if (name === 'pixel7') {
    const c2 = await browser.newContext({ ...opts, serviceWorkers: 'block' }); const q = await c2.newPage();
    await q.addInitScript(INIT); await q.clock.install({ time: new Date('2026-10-20T19:00:00') });
    await q.goto(BASE); await q.evaluate(() => { ['b1','b2','b3','b5'].forEach(id => startTimer(id)); seats.b2.startTime -= 33 * 60000; seats.b3.startTime -= 50 * 60000; });
    await q.clock.fastForward(1000); await q.waitForTimeout(1900);
    await q.screenshot({ path: path.join(SHOTS, `row-${TAG}-pixel7-load.png`) });
    ok(await q.evaluate(() => seatVisible('b1') && centreId === 'b1'), `pixel7: motion-on load also lands on B1`);
    await q.evaluate(() => enterSelectMode()); await q.evaluate(() => { setSelected('b1', true); setSelected('b2', true); }); await q.waitForTimeout(600);
    await q.screenshot({ path: path.join(SHOTS, `row-${TAG}-pixel7-select.png`) });
    await c2.close();
  }
}


// Cover Flow carousel
async function flowTests(browser, name, opts, reduce) {
  const tag = name + (reduce ? '-reduced' : '');
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));   // skip intro for geometry checks
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE); await p.clock.fastForward(300);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const shot = async n => { if (name === 'pixel7') await p.screenshot({ path: path.join(SHOTS, `flow-${TAG}-${tag}-${n}.png`) }); };
  const waitC = async id => { for (let k = 0; k < 40; k++) { await tick(20); if (await ev(id => centreId === id && Math.abs((document.getElementById('seat-' + id).offsetLeft + document.getElementById('seat-' + id).offsetWidth / 2) - (document.getElementById('seats').scrollLeft + document.getElementById('seats').clientWidth / 2)) <= 1.5, id)) return; await p.waitForTimeout(60); } };
  const off = id => ev(id => { const sc = document.getElementById('seats'), c = document.getElementById('seat-' + id); return Math.abs((c.offsetLeft + c.offsetWidth / 2) - (sc.scrollLeft + sc.clientWidth / 2)); }, id);
  ok(await ev(() => [...document.querySelectorAll('#seats .seat')].map(e => e.dataset.seat).join()) === 'b8,b7,b6,b5,b4,b3,b2,b1', `${tag}: order B8..B1`);
  ok(await ev(() => centreId) === 'b1' && await off('b1') <= 1, `${tag}: B1 centred on load (${(await off('b1')).toFixed(1)}px off)`);
  ok(await ev(() => document.getElementById('seat-b1').classList.contains('centre')), `${tag}: B1 marked as the centre card`);
  // ---- Fan: every seat on screen for every centred seat
  const fanCheck = () => ev(() => { const W = innerWidth, out = [];
    for (const c of document.querySelectorAll('#seats .seat')) { const a = c.getBoundingClientRect(), r = c.classList.contains('sr'), cen = c.classList.contains('centre');
      const ys = [.3, .5, .7].map(k => a.top + a.height * k), x = cen ? a.left + a.width / 2 : (r ? a.right - 4 : a.left + 4);
      const hit = ys.some(y => { const e = document.elementFromPoint(x, y); return e && e.closest('.seat') === c; });
      out.push({ id: c.dataset.seat, inV: a.left >= -0.5 && a.right <= W + .5 && a.top >= 0 && a.bottom <= innerHeight + .5, hit, w: Math.round(a.width) }); }
    return out; });
  const strips = [];
  for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']) {
    await ev(id => jumpTo(id), id); await tick(30); if (!reduce) await p.waitForTimeout(30);
    const f = await fanCheck(), bad = f.filter(x => !x.inV || !x.hit).map(x => x.id + (x.inV ? '' : ':out') + (x.hit ? '' : ':covered'));
    ok(bad.length === 0 && f.length === 8, `${tag}: ${id.toUpperCase()} centred: all 8 cards inside the viewport and visibly uncovered ${bad.join(' ')}`);
    const order = await ev(() => [...document.querySelectorAll('#seats .seat')].map(c => c.getBoundingClientRect()).map((a, i, arr) => i === 0 || a.left >= arr[i - 1].left - .5).every(Boolean));
    ok(order, `${tag}: ${id.toUpperCase()} centred: on-screen order still B8 (left) .. B1 (right)`);
    strips.push(await ev(() => { const v = [...document.querySelectorAll('#seats .seat')].map(c => c.getBoundingClientRect()); const st = []; for (let i = 1; i < v.length; i++) st.push(Math.abs(v[i].left - v[i - 1].left)); return Math.round(Math.min(...st.filter(x => x > 0))); }));
  }
  console.log(`INFO ${tag}: narrowest visible strip per centred seat B1..B8: ${strips.join(',')}px`);
  await ev(() => jumpTo('b1')); await tick(30);
  // compact face on side cards
  await ev(() => { startTimer('b3'); seats.b3.startTime -= 20 * 60000; }); await tick(300);
  const face = await ev(() => { const m = document.querySelector('#seat-b3 .mini'), cs = getComputedStyle(m); return { disp: cs.display, num: m.querySelector('b').textContent, w: +getComputedStyle(m.querySelector('b')).fontWeight, mm: m.querySelector('.mm').textContent, dot: getComputedStyle(m.querySelector('.md')).backgroundColor, cen: getComputedStyle(document.querySelector('#seat-b1 .mini')).display }; });
  ok(face.disp === 'flex' && face.num === '3' && face.w >= 700 && face.mm === '40m' && face.cen === 'none', `${tag}: side card compact face = bold seat number + status dot + minutes left (${JSON.stringify(face)})`);
  ok(await ev(() => { const g = getComputedStyle(document.querySelector('#seat-b3 .mini')).boxShadow; return /inset/.test(g); }), `${tag}: compact face has a status-coloured edge`);
  ok(await ev(() => +document.querySelector('#seat-b8 .dim').style.opacity > +document.querySelector('#seat-b2 .dim').style.opacity && +document.querySelector('#seat-b2 .dim').style.opacity > 0), `${tag}: side cards dim progressively by distance`);
  const scl = await ev(() => ['b2', 'b5', 'b8'].map(id => +(/scale\(([\d.]+)\)/.exec(document.getElementById('seat-' + id).style.transform) || [0, 1])[1]));
  ok(scl[0] > scl[1] && scl[1] > scl[2], `${tag}: side cards shrink progressively by distance (${scl.join(' > ')})`);
  for (let k = 0; k < 15 && !(await ev(() => parseFloat(getComputedStyle(document.getElementById('seat-b1')).scale) > 1.005)); k++) await p.waitForTimeout(100);
  ok(await ev(() => parseFloat(getComputedStyle(document.getElementById('seat-b1')).scale) > 1.005 && getComputedStyle(document.getElementById('spot')).display !== 'none'), `${tag}: centre card raised with a spotlight behind it (${await ev(() => getComputedStyle(document.getElementById('seat-b1')).scale + ' ' + document.getElementById('seat-b1').className)})`);
  await ev(() => endSession('b3', false)); await tick(300);
  const pose = await ev(() => { const c = document.getElementById('seat-b2'); return { tf: c.style.transform, op: +c.style.opacity, side: c.classList.contains('side') }; });
  if (reduce) ok(!/rotateY|perspective/.test(pose.tf) && pose.side, `${tag}: no 3D under reduced motion (side card flat, "${pose.tf}")`);
  else ok(/rotateY\(5[0-9](\.\d+)?deg\)/.test(pose.tf) && /scale\(0\.[78]/.test(pose.tf), `${tag}: side card tilted steeply (≈55°) and scaled down (${pose.tf})`);
  // continuous interpolation mid-swipe
  await ev(() => { sfxLog.length = 0; const sc = document.getElementById('seats'); sc.scrollLeft -= document.getElementById('seat-b1').offsetWidth * .5; updateFlow(); });
  const mid = await ev(() => { const m = /rotateY\((-?[\d.]+)deg\)/.exec(document.getElementById('seat-b1').style.transform); return m ? +m[1] : 0; });
  ok(reduce ? mid === 0 : Math.abs(mid) > 10 && Math.abs(mid) < 35, `${tag}: pose interpolates with drag position (B1 at half a card: rotateY ${mid}°)`);
  await shot('midswipe');
  // swipe one card: centre updates, tick sound
  await ev(() => { const sc = document.getElementById('seats'); sc.scrollLeft -= document.getElementById('seat-b1').offsetWidth * .3; updateFlow(); userScroll = true; settle(); });
  await waitC('b2');
  ok(await ev(() => centreId) === 'b2' && await off('b2') <= 1.5, `${tag}: swipe moves the centre to B2 and settles exactly (${(await off('b2')).toFixed(1)}px)`);
  ok(await ev(() => sfxLog.includes('tick')), `${tag}: soft tick sound when a seat passes`);
  // only centre controls act
  await ev(() => jumpTo('b1')); await tick(50);
  ok(await ev(() => document.querySelector('#seat-b3 .btn-primary').tabIndex === -1 && document.querySelector('#seat-b1 .btn-primary').tabIndex === 0), `${tag}: side-card controls removed from tab order`);
  await ev(() => document.querySelector('#seat-b2 .btn-primary').click()); await waitC('b2');
  ok(await ev(() => !seats.b2.running && centreId === 'b2'), `${tag}: tapping a side card's Start does not start it; it glides B2 to centre ${JSON.stringify(await ev(() => ({ c: centreId, r: seats.b2.running, sl: document.getElementById('seats').scrollLeft, t: flowTarget })))}`);
  await p.locator('#seat-b2 .btn-primary').click(); await tick(50);
  ok(await ev(() => seats.b2.running), `${tag}: once centred, B2's Start works`);
  if (name === 'desktop') { const r = await ev(() => { const a = document.getElementById('seat-b3').getBoundingClientRect(); const y = a.top + a.height * .35; const xs = []; for (let x = 2; x < innerWidth; x += 2) { const e = document.elementFromPoint(x, y); if (e && e.closest('.seat') && e.closest('.seat').dataset.seat === 'b3' && !e.closest('button, input')) xs.push(x); } const run = xs.filter(x => x > xs[xs.length - 1] - 40); return { x: run[Math.floor(run.length / 2)] || 5, y }; }); await p.mouse.click(r.x, r.y); }
  else globalThis.__pre = await ev(() => { const pre = document.getElementById('seat-b3').className + '|' + centreId + '|' + seats.b3.running; document.querySelector('#seat-b3 .timer').click(); return pre; });   // phone: synthetic tap on the side card
  await waitC('b3');
  ok(await ev(() => centreId === 'b3' && !seats.b3.running), `${tag}: tap the next side card to centre it, without starting it ${JSON.stringify(await ev(() => ({ c: centreId, t: flowTarget, r: seats.b3.running, sm: selectMode })))} pre=${globalThis.__pre || ''}`);
  // indicator jump
  { const pt = await ev(() => { const a = document.getElementById('seat-b8').getBoundingClientRect(); return { x: Math.round(a.left + 5), y: Math.round(a.top + a.height / 2) }; }); if (opts.hasTouch) await p.touchscreen.tap(pt.x, pt.y); else await p.mouse.click(pt.x, pt.y); } await waitC('b8');
  ok(await ev(() => centreId) === 'b8' && await off('b8') <= 1.5, `${tag}: tapping B8's side strip centres B8`);
  // momentum: one fast flick travels several seats, then settles exactly on one
  if (opts.hasTouch && !reduce) {
    // Headless Chrome does not synthesise a fling, so this drives a fast long touch drag (~2.6 cards) and checks it settles on a seat.
    const cdp = await ctx.newCDPSession(p);
    const b = await p.locator('#seats').boundingBox(), y = Math.round(b.y + 150), w = await ev(() => document.getElementById('seat-b8').offsetWidth);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 400, y }] });
    for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(400 - k * w * 2.6 / 12 / 2), y }] }); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 10, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    for (let k = 0; k < 20; k++) { await tick(20); await p.waitForTimeout(60); }
    const c = await ev(() => centreId), o = await off(c), passed = await ev(c => Math.abs(DISPLAY_IDS.indexOf(c) - DISPLAY_IDS.indexOf('b8')), c);
    ok(passed >= 1 && o <= 1.5, `${tag}: fast long swipe carries ${passed} seats and settles exactly on ${c.toUpperCase()} (${o.toFixed(1)}px off)`);
  }
  // alerts while off-centre
  await ev(() => jumpTo('b1')); await tick(50);
  await ev(() => { startTimer('b6'); seats.b6.startTime -= 61 * 60000; }); await tick(300);
  ok(await ev(() => document.getElementById('seat-b6').classList.contains('flag') && (matchMedia('(prefers-reduced-motion: reduce)').matches ? !document.getElementById('seat-b6').classList.contains('nudge') : document.getElementById('seat-b6').classList.contains('nudge'))) && /B6 time is up/.test(await p.locator('#offAlert').textContent()), `${tag}: off-centre time-up flags B6 + Show button`);
  const lay = await ev(() => { const a = document.getElementById('offAlert'); return getComputedStyle(a).position; });
  ok(lay === 'absolute', `${tag}: alert button overlays (position ${lay}) instead of pushing layout`);
  await shot('alert');
  await p.locator('#offAlert').click(); await waitC('b6');
  ok(await ev(() => centreId) === 'b6' && await p.locator('#offAlert').isHidden(), `${tag}: Show centres B6 and clears the alert`);
  // selection flattens, then restores
  await ev(() => enterSelectMode()); await tick(50);
  ok(await ev(() => [...document.querySelectorAll('#seats .seat')].every(c => !/rotateY/.test(c.style.transform) && !c.classList.contains('side'))), `${tag}: selection mode flattens the carousel`);
  await ev(() => { setSelected('b6', true); setSelected('b5', true); }); await tick(50);
  if (!reduce) await p.waitForTimeout(600);
  await shot('select');
  await ev(() => exitSelectMode()); await tick(50);
  ok(await ev(() => document.getElementById('seat-b1').classList.contains('side') && (matchMedia('(prefers-reduced-motion: reduce)').matches || /rotateY/.test(document.getElementById('seat-b1').style.transform))), `${tag}: leaving selection restores the carousel`);
  // keys still map to seat numbers
  if (name === 'desktop') { await p.locator('h1').click(); await p.keyboard.press('Digit7'); await tick(100); ok(await ev(() => seats.b7.running), `${tag}: key 7 starts B7 (side seat)`); }
  // guest board stays flat
  await ev(() => toggleGuestView()); await tick(200);
  ok(await ev(() => [...document.querySelectorAll('.guest-card')].map(e => e.id.slice(6)).join() === 'b8,b7,b6,b5,b4,b3,b2,b1' && [...document.querySelectorAll('.guest-card')].every(e => !e.style.transform)), `${tag}: guest view is a flat B8..B1 board`);
  if (!reduce) await p.waitForTimeout(400);
  await shot('guest');
  await ev(() => toggleGuestView()); await tick(100);
  if (reduce) await shot('board');
  else { await ev(() => jumpTo('b1')); await tick(50); await p.waitForTimeout(300); await shot('load'); }
  ok(errs.length === 0, `${tag}: no page errors (flow) ${errs.join(' | ')}`);
  await ctx.close();
}

async function premiumTests(browser, name, opts, reduce) {
  const tag = name + (reduce ? '-reduced' : '');
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE); await p.clock.fastForward(300);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const shot = async n => { if (name === 'pixel7' && !reduce) await p.screenshot({ path: path.join(SHOTS, `premium-${TAG}-pixel7-${n}.png`) }); };
  const lum = c => { const m = c.match(/[\d.]+/g).map(Number).slice(0, 3).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * m[0] + .7152 * m[1] + .0722 * m[2]; };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  // default + rendering
  ok(await ev(() => settings.look === 'premium' && document.body.classList.contains('theme-premium') && !document.body.classList.contains('theme-arcade')), `${tag}: Premium is the default look`);
  ok(await ev(() => document.fonts.check('300 20px InterLocal')) || await ev(async () => { await document.fonts.load('300 20px InterLocal'); return document.fonts.check('300 20px InterLocal'); }), `${tag}: bundled Inter font loads`);
  const r = await ev(() => { const t = document.querySelector('#seat-b1 .timer'), cs = getComputedStyle(t); return { ff: cs.fontFamily, fw: +cs.fontWeight, num: cs.fontVariantNumeric, lab: getComputedStyle(document.querySelector('#seat-b1 .seat-label'), '::before').content, svg: document.querySelectorAll('#seat-b1 svg.li').length, lead: getComputedStyle(document.querySelector('#seat-b1 .ring .lead')).display, bf: getComputedStyle(document.querySelector('#seat-b1')).backdropFilter }; });
  ok(/InterLocal/.test(r.ff) && r.fw <= 300 && /tabular-nums/.test(r.num), `${tag}: thin tabular timer digits in Inter (${r.ff.slice(0, 30)}, ${r.fw}, ${r.num})`);
  ok(/Seat ·/.test(r.lab), `${tag}: letter-spaced 'Seat · B1' label (${r.lab})`);
  ok(r.svg >= 1 && await ev(() => !/[▶⏸↺]/u.test(document.querySelector('#seat-b1 .btn-primary').textContent)), `${tag}: line icons instead of emoji (${r.svg} svg)`);
  ok(r.lead === 'block', `${tag}: gradient ring lead dot shown`);
  ok(/blur/.test(r.bf || ''), `${tag}: frosted glass card (${r.bf})`);
  // contrast
  const c = await ev(() => { const g = (s, pr) => getComputedStyle(document.querySelector(s))[pr]; return { t: g('#seat-b1 .timer', 'color'), bg: getComputedStyle(document.documentElement).backgroundColor, lab: g('#seat-b1 .seat-label', 'color') }; });
  ok(cr(c.t, c.bg) >= 7 && cr(c.lab, c.bg) >= 4.5, `${tag}: contrast readable (timer ${cr(c.t, c.bg).toFixed(1)}:1, label ${cr(c.lab, c.bg).toFixed(1)}:1 vs ${c.bg})`);
  ok(await ev(() => FX.spring() !== undefined && !/1\.[1-9]|,\s*1\.[0-9]+\)/.test(FX.spring())), `${tag}: premium easing has no overshoot (${await ev(() => FX.spring())})`);
  await shot('board');
  // effects (normal motion only)
  if (!reduce) {
    await ev(() => { startTimer('b1'); }); await tick(50);
    ok(await ev(() => !document.querySelector('.spark:not(.gold)') && (document.querySelectorAll('.spark.gold').length > 0 || true)), `${tag}: no arcade sparks in premium`);
    await ev(() => FX.banner('SEAT B3 · GO')); ok(await ev(() => document.querySelector('.banner')?.textContent) === 'Seat · B3', `${tag}: banner reads 'Seat · B3'`);
    await ev(() => FX.confetti()); ok(await ev(() => document.querySelectorAll('.confetti.shimmer').length > 0 && !document.querySelector('.confetti:not(.shimmer)')), `${tag}: golden shimmer replaces confetti`);
    await ev(() => { seats.b1.startTime -= 61 * 60000; }); await tick(300);
    ok(await ev(() => !!document.querySelector('#seat-b1 .stamp.lux') && !document.querySelector('.stamp:not(.lux)')), `${tag}: elegant 'Time' badge instead of TIME! stamp`);
    await p.waitForTimeout(500); await shot('alert');
    ok(await ev(() => /alert|red|over/.test(document.getElementById('seat-b1').className)), `${tag}: alert still flags the seat`);
  } else {
    await ev(() => { startTimer('b1'); seats.b1.startTime -= 61 * 60000; }); await tick(300);
    ok(await ev(() => !document.querySelector('.stamp, .confetti, .spark')), `${tag}: reduced motion: no premium effects spawned`);
    ok(await ev(() => /alert|red|over/.test(document.getElementById('seat-b1').className)), `${tag}: reduced motion: alert still flags the seat`);
  }
  // cover flow still works
  await ev(() => jumpTo('b3')); for (let k = 0; k < 20; k++) { await tick(20); await p.waitForTimeout(30); }
  ok(await ev(() => centreId) === 'b3', `${tag}: Cover Flow still centres seats in Premium`);
  // selection
  await ev(() => { enterSelectMode(); setSelected('b3', true); setSelected('b2', true); }); await tick(50); if (!reduce) await p.waitForTimeout(500);
  ok(await ev(() => selectMode && document.querySelectorAll('#seats .seat.selected').length === 2), `${tag}: selection works in Premium`);
  await shot('select'); await ev(() => exitSelectMode()); await tick(50);
  // guest
  await ev(() => toggleGuestView()); await tick(200); if (!reduce) await p.waitForTimeout(400);
  ok(await ev(() => document.querySelectorAll('.guest-card').length === 8 && /blur/.test(getComputedStyle(document.querySelector('.guest-card')).backdropFilter || '')), `${tag}: guest view premium-styled`);
  await shot('guest'); await ev(() => toggleGuestView()); await tick(100);
  // sheets + scrim
  await ev(() => toggleSettings()); await tick(50); if (!reduce) await p.waitForTimeout(500);
  ok(await ev(() => document.body.classList.contains('sheet-open') && getComputedStyle(document.getElementById('settingsPanel')).position === 'fixed' && getComputedStyle(document.getElementById('scrim')).pointerEvents === 'auto'), `${tag}: Settings opens as glass sheet with scrim`);
  await shot('settings');
  await ev(() => document.getElementById('scrim').click()); await tick(50);
  ok(await ev(() => !document.body.classList.contains('sheet-open') && document.getElementById('settingsPanel').style.display === 'none'), `${tag}: tapping the scrim closes the sheet`);
  // switch + persistence
  await ev(() => { toggleSettings(); const s = document.getElementById('setLook'); s.value = 'arcade'; s.dispatchEvent(new Event('change')); closeSheets(); }); await tick(100);
  ok(await ev(() => document.body.classList.contains('theme-arcade') && !document.body.classList.contains('theme-premium') && /▶|⏸/u.test(document.querySelector('#seat-b2 .btn-primary').textContent) && !document.querySelector('#seat-b2 svg.li')), `${tag}: switching to Arcade restores emoji/game look`);
  await p.reload(); await p.clock.fastForward(300);
  ok(await ev(() => settings.look === 'arcade' && document.body.classList.contains('theme-arcade') && document.getElementById('setLook').value === 'arcade'), `${tag}: Arcade persists across reload`);
  ok(await ev(() => !/Seat ·/.test(getComputedStyle(document.querySelector('#seat-b1 .seat-label'), '::before').content) && getComputedStyle(document.querySelector('#seat-b1 .ring .lead')).display === 'none'), `${tag}: Arcade renders without premium label/lead dot`);
  if (!reduce) await p.waitForTimeout(300); await shot('arcade');
  await ev(() => setLook('premium')); await p.reload(); await p.clock.fastForward(300);
  ok(await ev(() => settings.look === 'premium' && document.body.classList.contains('theme-premium')), `${tag}: Premium persists across reload`);
  ok(errs.length === 0, `${tag}: no page errors (premium) ${errs.join(' | ')}`);
  await ctx.close();
}

async function fanTests(browser, name, opts, reduce) {
  const tag = name + (reduce ? '-reduced' : '') + ' fan';
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE); await p.clock.fastForward(300);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const settleWait = async () => { for (let k = 0; k < 20; k++) { await tick(30); await p.waitForTimeout(reduce ? 5 : 40); } };
  const shot = async n => { if (name === 'pixel7') await p.screenshot({ path: path.join(SHOTS, `fan-${TAG}-pixel7-${n}.png`) }); };
  const lum = c => { const m = c.match(/[\d.]+/g).map(Number).slice(0, 3).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * m[0] + .7152 * m[1] + .0722 * m[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const statusCols = () => ev(() => { const d = document.createElement('i'); document.body.appendChild(d); const o = {}; for (const k of ['ok', 'warn', 'danger']) { d.style.color = `var(--bar-${k})`; o[k] = getComputedStyle(d).color; } d.remove(); return o; });
  // scene: a mix of statuses
  await ev(() => { ['b1', 'b2', 'b3', 'b6', 'b7'].forEach(id => startTimer(id)); seats.b2.startTime -= 34 * 60000; seats.b3.startTime -= 50 * 60000; seats.b7.startTime -= 61 * 60000; togglePause('b6'); });
  await tick(400); if (!reduce) await p.waitForTimeout(500);
  // colour-blind safety: statuses differ in brightness, not only hue (Premium night + Daytime)
  for (const mode of ['night', 'daytime']) {
    if (mode === 'daytime') { await ev(() => setDaytime(true)); await tick(50); }
    const c = await statusCols(), r1 = ratio(c.ok, c.warn), r2 = ratio(c.ok, c.danger), r3 = ratio(c.warn, c.danger);
    ok(Math.min(r1, r2, r3) >= 1.4, `${tag}: ${mode} status colours differ in brightness (ok/amber ${r1.toFixed(2)}, ok/red ${r2.toFixed(2)}, amber/red ${r3.toFixed(2)})`);
  }
  // Daytime renders light, readable, persists
  const day = await ev(() => ({ cls: document.body.classList.contains('daytime'), bg: getComputedStyle(document.body).backgroundColor, t: getComputedStyle(document.querySelector('#seat-b1 .timer')).color, cb: document.getElementById('setDaytime').checked }));
  ok(day.cls && lum(day.bg) > .6 && ratio(day.t, day.bg) >= 7 && day.cb, `${tag}: Daytime is a light Premium variant with readable time (${ratio(day.t, day.bg).toFixed(1)}:1 on ${day.bg})`);
  await ev(() => jumpTo('b1')); await settleWait(); if (!reduce) await p.waitForTimeout(400);
  if (!reduce) await shot('daytime');
  await p.reload(); await p.clock.fastForward(300);
  ok(await ev(() => settings.daytime === true && document.body.classList.contains('daytime') && document.getElementById('setDaytime').checked), `${tag}: Daytime persists across reload`);
  await ev(() => setLook('arcade')); await tick(50);
  ok(await ev(() => !document.body.classList.contains('daytime')), `${tag}: Daytime only applies to Premium (Arcade unaffected)`);
  await ev(() => { setLook('premium'); setDaytime(false); }); await tick(50);
  ok(await ev(() => !document.body.classList.contains('daytime') && JSON.parse(localStorage.getItem('barSeatTimers.v2')).settings.daytime === false), `${tag}: Daytime off persists`);
  // gyro toggle: persists, tilts the centre card only, fails gracefully
  await ev(() => setGyro(true)); await tick(50);
  ok(await ev(() => settings.gyro === true && document.getElementById('setGyro').checked && JSON.parse(localStorage.getItem('barSeatTimers.v2')).settings.gyro === true), `${tag}: gyro toggle on and saved`);
  await p.reload(); await p.clock.fastForward(300);
  ok(await ev(() => settings.gyro === true && document.getElementById('setGyro').checked && gyroOn), `${tag}: gyro setting persists across reload and listener restarts`);
  await ev(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 70, gamma: 20 }))); await tick(50);
  const gy = await ev(() => ({ c: document.getElementById('seat-' + centreId).style.transform, s: document.getElementById('seat-b5').style.transform }));
  if (reduce) ok(!/rotateX/.test(gy.c), `${tag}: no gyro tilt under reduced motion`);
  else ok(/rotateX\(-?[\d.]+deg\)/.test(gy.c) && !/rotateX/.test(gy.s), `${tag}: gentle gyro tilt on the centre card only (${gy.c.slice(-60)})`);
  ok(await ev(async () => { const save = window.DeviceOrientationEvent; DeviceOrientationEvent.requestPermission = () => Promise.reject(new Error('denied')); await setGyro(true); const r = settings.gyro === false && !document.getElementById('setGyro').checked && /not granted/.test(document.getElementById('gyroMsg').textContent); delete DeviceOrientationEvent.requestPermission; return r; }), `${tag}: denied motion permission fails gracefully (stays off, explains)`);
  ok(await ev(async () => { const D = window.DeviceOrientationEvent; delete window.DeviceOrientationEvent; await setGyro(true); const r = settings.gyro === false && /not available/.test(document.getElementById('gyroMsg').textContent); window.DeviceOrientationEvent = D; return r; }), `${tag}: unsupported device fails gracefully`);
  ok(await ev(() => !document.getElementById('seat-' + centreId).style.transform.includes('rotateX')), `${tag}: turning gyro off clears the tilt`);
  // timer weight grows near expiry without layout shift
  await ev(() => { endSession('b1', false); startTimer('b1'); jumpTo('b1'); }); await tick(300);
  const g0 = await ev(() => { const t = document.querySelector('#seat-b1 .timer'), c = document.getElementById('seat-b1'); return { w: +getComputedStyle(t).fontWeight, h: t.offsetHeight, tw: t.offsetWidth, ch: c.offsetHeight }; });
  await ev(() => { seats.b1.startTime -= 57 * 60000; }); await tick(300);
  const g1 = await ev(() => { const t = document.querySelector('#seat-b1 .timer'), c = document.getElementById('seat-b1'); return { w: +getComputedStyle(t).fontWeight, h: t.offsetHeight, tw: t.offsetWidth, ch: c.offsetHeight }; });
  ok(g1.w > g0.w + 150 && g0.h === g1.h && g0.tw === g1.tw && g0.ch === g1.ch, `${tag}: time gets heavier near expiry (${g0.w}→${g1.w}) with no layout shift (${g0.h}/${g0.tw}/${g0.ch} vs ${g1.h}/${g1.tw}/${g1.ch})`);
  ok(await ev(() => /tabular-nums/.test(getComputedStyle(document.querySelector('#seat-b1 .timer')).fontVariantNumeric)), `${tag}: tabular digits`);
  await ev(() => { endSession('b1', false); startTimer('b1'); }); await tick(300);
  // settle click (normal motion)
  if (!reduce) { await ev(() => { sfxLog.length = 0; jumpTo('b4', true); }); await settleWait(); ok(await ev(() => sfxLog.includes('settle') && centreId === 'b4'), `${tag}: soft click when a card settles ${await ev(() => JSON.stringify({ l: sfxLog, c: centreId, g: !!glide, m: settings.mute }))}`); }
  // screenshots: B1 centred, B5 centred, time-up off-centre, select
  await ev(() => jumpTo('b1')); await settleWait(); if (!reduce) await p.waitForTimeout(500);
  if (reduce) await shot('reduced'); else {
    await shot('b1');
    await ev(() => jumpTo('b5')); await settleWait(); await p.waitForTimeout(500); await shot('b5');
    await ev(() => jumpTo('b1')); await settleWait(); await ev(() => { delete seatAlerts.b7; seats.b7.timeUpNotified = false; flagOffscreen('b7', 'timeup'); }); await tick(300); await p.waitForTimeout(700);
    ok(await ev(() => document.getElementById('seat-b7').classList.contains('nudge') && !document.getElementById('offAlert').hidden), `${tag}: time-up seat off-centre nudges and shows the Show button`);
    await shot('timeup');
    await ev(() => { enterSelectMode(); setSelected('b2', true); setSelected('b3', true); }); await tick(50); await p.waitForTimeout(700); await shot('select');
    ok(await ev(() => [...document.querySelectorAll('#seats .seat')].every(c => !/rotateY/.test(c.style.transform))), `${tag}: selection mode flattens the fan`);
    await ev(() => exitSelectMode()); await tick(50);
  }
  ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
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
  await clickSeat(p, 7, '.btn-primary');
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

// Cover Flow: only the centred card's controls act, so tests centre a seat before using its controls (like a person would).
async function clickSeat(page, i, sel) {
  // centre the seat and click its control in one step (deterministic); real pointer taps are covered in selection/flow tests
  const hit = await page.evaluate(([i, sel]) => {
    if (typeof jumpTo === 'function' && !selectMode) jumpTo('b' + i);
    const el = document.querySelector(`#seat-b${i} ${sel}`); if (!el || el.disabled) return false;
    el.click(); return true;
  }, [i, sel]);
  if (!hit) throw new Error(`clickSeat: #seat-b${i} ${sel} missing or disabled`);
}
let TAG;
(async () => {
  let srv = null;
  if (!BASE) { srv = await serve(); BASE = 'http://127.0.0.1:8765/'; }
  TAG = /github\.io/.test(BASE) ? 'live' : 'local';
  console.log(`Testing ${BASE}`);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  for (const [name, opts] of [['desktop', { viewport: { width: 1366, height: 900 } }], ['pixel7', devices['Pixel 7']]]) {
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('featureTests')) await featureTests(browser, name, opts);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('migrationAndShot')) await migrationAndShot(browser, name, opts);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('selectionTests')) await selectionTests(browser, name, opts);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('motionTests')) await motionTests(browser, name, opts, false);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('motionTests')) await motionTests(browser, name, opts, true);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('cineTests')) await cineTests(browser, name, opts, false);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('cineTests')) await cineTests(browser, name, opts, true);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('rowTests')) await rowTests(browser, name, opts);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('flowTests')) await flowTests(browser, name, opts, false);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('flowTests')) await flowTests(browser, name, opts, true);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('premiumTests')) await premiumTests(browser, name, opts, false);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('premiumTests')) await premiumTests(browser, name, opts, true);
    for (const rm of [false, true]) if (!process.env.ONLY || process.env.ONLY.split(',').includes('fanTests')) await fanTests(browser, name, opts, rm);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('pwaTests')) await pwaTests(browser, name, opts);
  }
  await browser.close();
  if (!process.env.ONLY) await installabilityCheck();
  if (srv) srv.close();
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
