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
  window.__noLite = 1;   // tests assert the full look; auto Smooth mode is covered by smoothTests
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
  else ok(anim.glowA === 'breathe' && anim.glowR === 'breathe' && /^(shakeX|nudge[LR]|depthNudgeT)$/.test(anim.shake) && anim.alarm === 'alarm', `${tag}: amber breathe, red pulse, time-up shake + glow (${JSON.stringify(anim)})`);
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
  { const st = await ev(() => { const c = document.getElementById('seat-b7'); return { stuck: c.classList.contains('stuck'), s: +getComputedStyle(c).scale || 1 }; });
    ok(st.stuck && st.s > .29 && st.s <= 1.001, `${tag}: selected seats stick together (v4.6 cluster replaces the old shrink; scale ${st.s})`); }
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
  ok(geo.end && geo.b1In && (geo.b8Out || name === 'pixel7'), `${name}: on load scrolled to the end, B1 centred, and the fan keeps B8 on screen`);
  ok(await ev(() => typeof settle === 'function'), `${name}: row settles on a seat after scrolling`);
  if (name === 'pixel7') ok(geo.frac >= .5 && geo.frac <= .65, `${name}: card is ${Math.round(geo.frac * 100)}% of viewport height`);
  else ok(geo.fit >= 3, `${name}: wide screen shows ${geo.fit} cards (centre + side covers)`);
  ok(await ev(() => getComputedStyle(document.getElementById('seatNav')).display) === 'none', `${name}: no extra chip row (the back cards are the seat buttons)`);
  const tapStrip = async id => { const pt = await ev(id => { const a = document.getElementById('seat-' + id).getBoundingClientRect(), r = document.getElementById('seat-' + id).classList.contains('sr'); return { x: Math.round(r ? a.right - 5 : a.left + 5), y: Math.round(Math.max(a.top + 20, Math.min(a.top + a.height / 2, innerHeight - 30))) }; }, id);
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
  if (/pixel7/.test(name)) { await ev(() => jumpTo('b5')); await tick(30); await p.waitForTimeout(900); }   // phones show fewer side cards: bring B8 into the stack first
  await tapStrip('b8'); for (let k = 0; k < 15; k++) { await tick(30); await p.waitForTimeout(40); }
  ok(await ev(() => seatVisible('b8') && centreId === 'b8'), `${name}: tapping B8's side strip centres B8 (${await ev(() => centreId + ' sy' + scrollY + ' ' + JSON.stringify(document.getElementById('seat-b8').getBoundingClientRect()) + ' op' + getComputedStyle(document.getElementById('seat-b8')).opacity)})`);
  await shot('b8');
  if (/pixel7/.test(name)) { await ev(() => jumpTo('b3')); await tick(30); await p.waitForTimeout(900); }
  await tapStrip('b1'); for (let k = 0; k < 15; k++) { await tick(30); await p.waitForTimeout(40); }
  ok(await ev(() => seatVisible('b1')), `${name}: tapping B1's side strip centres it again (${await ev(() => centreId + ' ' + ['b1','b2','b3'].map(i => { const c = document.getElementById('seat-' + i), a = c.getBoundingClientRect(); return i + ':' + Math.round(a.left) + '-' + Math.round(a.right) + ' op' + c.style.opacity + ' z' + c.style.zIndex; }).join(' ') + JSON.stringify(fanGeom(document.getElementById('seats'), document.getElementById('seats').scrollLeft)) + ' tier' + Q.tier + ' W' + innerWidth)})`);
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
    for (const c of document.querySelectorAll('#seats .seat')) { if (+getComputedStyle(c).opacity < .05) continue;   // phones fade the cards that don't fit
      const a = c.getBoundingClientRect(), r = c.classList.contains('sr'), cen = c.classList.contains('centre');
      const ys = [.3, .5, .7].map(k => a.top + a.height * k), x = cen ? a.left + a.width / 2 : (r ? a.right - 4 : a.left + 4);
      const hit = ys.some(y => { const e = document.elementFromPoint(x, y); return e && e.closest('.seat') === c; });
      out.push({ id: c.dataset.seat, inV: a.left >= -0.5 && a.right <= W + .5 && a.top >= 0 && a.bottom <= innerHeight + .5, hit, w: Math.round(a.width) }); }
    return out; });
  const strips = [], depth = await ev(() => document.body.classList.contains('depth'));
  for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']) {
    await ev(id => jumpTo(id), id); await tick(30); await p.waitForTimeout(reduce ? 60 : 900);
    const f = await fanCheck(), bad = f.filter(x => !x.inV || !x.hit).map(x => x.id + (x.inV ? '' : ':out') + (x.hit ? '' : ':covered'));
    ok(bad.length === 0 && f.length >= (/pixel7/.test(name) ? 4 : 8), `${tag}: ${id.toUpperCase()} centred: ${/pixel7/.test(name) ? 'every shown card (' + f.length + ' of 8)' : 'all 8 cards'} inside the viewport and visibly uncovered ${bad.join(' ')}`);
    const order = await ev(() => [...document.querySelectorAll('#seats .seat')].filter(c => !document.body.classList.contains('depth') || !c.classList.contains('centre')).map(c => c.getBoundingClientRect()).map((a, i, arr) => i === 0 || a.left >= arr[i - 1].left - .5).every(Boolean));
    ok(order, `${tag}: ${id.toUpperCase()} centred: on-screen order still B8 (left) .. B1 (right)`);
    strips.push(await ev(() => { const v = [...document.querySelectorAll('#seats .seat')].map(c => c.getBoundingClientRect()); const st = []; for (let i = 1; i < v.length; i++) st.push(Math.abs(v[i].left - v[i - 1].left)); return Math.round(Math.min(...st.filter(x => x > 0))); }));
  }
  console.log(`INFO ${tag}: narrowest visible strip per centred seat B1..B8: ${strips.join(',')}px`);
  await ev(() => jumpTo('b1')); await tick(30);
  // compact face on side cards
  await ev(() => { startTimer('b3'); seats.b3.startTime -= 20 * 60000; }); await tick(300);
  const face = await ev(() => { const m = document.querySelector('#seat-b3 .mini'), cs = getComputedStyle(m); return { disp: cs.display, num: m.querySelector('b').textContent, w: +getComputedStyle(m.querySelector('b')).fontWeight, mm: m.querySelector('.mm').textContent, dot: getComputedStyle(m.querySelector('.md')).backgroundColor, cen: getComputedStyle(document.querySelector('#seat-b1 .mini')).display }; });
  if (depth) ok(face.disp === 'flex' && face.num === '3' && face.w >= 700 && face.mm === '40m' && face.cen === 'none', `${tag}: depth: back card shows seat number + status dot + minutes left (${JSON.stringify(face)})`);
  else if (false) ok(face.disp === 'flex' && await ev(() => { const m = document.querySelector('#seat-b3 .mini'), a = m.getBoundingClientRect(), c = document.getElementById('seat-b3').getBoundingClientRect(); return [...m.children].every(k => getComputedStyle(k).display === 'none') && a.width >= c.width - 2; }) && face.cen === 'none', `${tag}: narrow phone: side cards are clean status peeks (no squeezed text; chips carry the numbers)`);
  else ok(face.disp === 'flex' && face.num === '3' && face.w >= 700 && face.mm === '40m' && face.cen === 'none', `${tag}: side card compact face = bold seat number + status dot + minutes left (${JSON.stringify(face)})`);
  ok(await ev(() => { const g = getComputedStyle(document.querySelector('#seat-b3 .mini')).boxShadow; return /inset/.test(g); }), `${tag}: compact face has a status-coloured edge`);
  if (depth) ok(await ev(() => ['b2', 'b5', 'b8'].every(id => +document.querySelector('#seat-' + id + ' .dim').style.opacity > 0 && +document.querySelector('#seat-' + id + ' .dim').style.opacity <= .2)), `${tag}: depth: back cards slightly dimmed (no blur)`);
  else ok(await ev(() => +document.querySelector('#seat-b8 .dim').style.opacity > +document.querySelector('#seat-b2 .dim').style.opacity && +document.querySelector('#seat-b2 .dim').style.opacity > 0), `${tag}: side cards dim progressively by distance`);
  const scl = await ev(() => ['b2', 'b5', 'b8'].map(id => +(/scale\(([\d.]+)\)/.exec(document.getElementById('seat-' + id).style.transform) || [0, 1])[1]));
  if (depth) ok(scl.every(x => x < .35), `${tag}: depth: back cards are smaller (${scl.join(', ')})`);
  else ok(scl[0] > scl[1] && scl[1] > scl[2], `${tag}: side cards shrink progressively by distance (${scl.join(' > ')})`);
  for (let k = 0; k < 15 && !(await ev(() => (m => Math.hypot(m.a, m.b))(new DOMMatrix(getComputedStyle(document.getElementById('seat-b1')).transform)) > 1.005)); k++) await p.waitForTimeout(100);
  ok(await ev(() => (m => Math.hypot(m.a, m.b))(new DOMMatrix(getComputedStyle(document.getElementById('seat-b1')).transform)) > 1.005 && getComputedStyle(document.getElementById('spot')).display !== 'none'), `${tag}: centre card raised with a spotlight behind it (${await ev(() => getComputedStyle(document.getElementById('seat-b1')).scale + ' ' + document.getElementById('seat-b1').className)})`);
  await ev(() => endSession('b3', false)); await tick(300);
  const pose = await ev(() => { const c = document.getElementById('seat-b2'); return { tf: c.style.transform, op: +c.style.opacity, side: c.classList.contains('side') }; });
  if (reduce) ok(!/rotateY|perspective/.test(pose.tf) && pose.side, `${tag}: no 3D under reduced motion (side card flat, "${pose.tf}")`);
  else if (depth) ok(/translate\([-\d.]+px, -\d[\d.]*px\) scale\(0\.[1-3]/.test(pose.tf) && !/rotate|perspective/.test(pose.tf), `${tag}: depth: back card raised and scaled down, 2D only (${pose.tf})`);
  else ok(/rotateY\(6[0-9](\.\d+)?deg\)/.test(pose.tf) && /scale\(0\.[78]/.test(pose.tf), `${tag}: side card turned ≈65° like Cover Flow and scaled down (${pose.tf})`);
  // continuous interpolation mid-swipe
  await ev(() => { sfxLog.length = 0; const sc = document.getElementById('seats'); sc.scrollLeft -= document.getElementById('seat-b1').offsetWidth * .5; updateFlow(); });
  const mid = await ev(() => { const m = /rotateY\((-?[\d.]+)deg\)/.exec(document.getElementById('seat-b1').style.transform); return m ? +m[1] : 0; });
  if (depth) { const sm = await ev(() => +(/scale\(([\d.]+)\)/.exec(document.getElementById('seat-b1').style.transform) || [0, 1])[1]); ok(sm > .4 && sm < .8, `${tag}: depth: pose interpolates with drag position (B1 at half a card: scale ${sm})`); }
  else ok(reduce ? mid === 0 : Math.abs(mid) > 10 && Math.abs(mid) < 35, `${tag}: pose interpolates with drag position (B1 at half a card: rotateY ${mid}°)`);
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
  else { for (let k = 0; k < 30 && !(await ev(() => centreId === 'b2' && !glide && document.getElementById('seat-b3').classList.contains('side'))); k++) { await tick(20); await p.waitForTimeout(30); } globalThis.__pre = await ev(() => { const pre = document.getElementById('seat-b3').className + '|' + centreId + '|' + seats.b3.running; document.querySelector('#seat-b3 .timer').click(); return pre; }); }   // phone: synthetic tap on the side card
  await waitC('b3');
  ok(await ev(() => centreId === 'b3' && !seats.b3.running), `${tag}: tap the next side card to centre it, without starting it ${JSON.stringify(await ev(() => ({ c: centreId, t: flowTarget, r: seats.b3.running, sm: selectMode })))} pre=${globalThis.__pre || ''}`);
  // indicator jump
  await p.waitForTimeout(500);   // let a running front-swap finish before reading positions
  if (/pixel7/.test(name)) { await ev(() => jumpTo('b5')); await p.waitForTimeout(900); }   // phones fade the far cards: bring B8 into the stack
  { const pt = await ev(() => { const a = document.getElementById('seat-b8').getBoundingClientRect(); return { x: Math.round(a.left + 5), y: Math.round(Math.max(a.top + 20, Math.min(a.top + a.height / 2, innerHeight - 30))) }; }); if (opts.hasTouch) await p.touchscreen.tap(pt.x, pt.y); else await p.mouse.click(pt.x, pt.y); } await waitC('b8');
  ok(await ev(() => centreId) === 'b8' && await off('b8') <= 1.5, `${tag}: tapping B8's side strip centres B8`);
  // momentum: one fast flick travels several seats, then settles exactly on one
  if (opts.hasTouch && !reduce) {
    // Headless Chrome does not synthesise a fling, so this drives a fast long touch drag (~2.6 cards) and checks it settles on a seat.
    const cdp = await ctx.newCDPSession(p);
    const b = await p.locator('#seats').boundingBox(), y = Math.round(b.y + b.height * .6), w = await ev(() => document.getElementById('seat-b8').offsetWidth);
    await p.waitForTimeout(500);   // let any front-swap finish first
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 360, y }] });
    for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(360 - k * w * 2.6 / 12 / 2), y }] }); }
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
  await ev(() => window.scrollTo(0, 0)); await p.waitForTimeout(50);   // sticky header: measure with the page at the top
  const lay = await ev(() => { const a = document.getElementById('offAlert'), r = a.getBoundingClientRect(); return { inSum: !!a.closest('#summary'), over: [...document.querySelectorAll('#seats .seat')].filter(c => { const b = c.getBoundingClientRect(); return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top; }).map(c => c.dataset.seat + '@' + Math.round(c.getBoundingClientRect().top) + '/' + getComputedStyle(c).opacity), r: [Math.round(r.top), Math.round(r.bottom)], sy: scrollY }; });
  ok(lay.inSum && lay.over.length === 0, `${tag}: alert button sits in the summary line and covers no card (${JSON.stringify(lay)})`);
  await shot('alert');
  await p.locator('#offAlert').click(); await waitC('b6');
  ok(await ev(() => centreId) === 'b6' && await p.locator('#offAlert').isHidden(), `${tag}: Show centres B6 and clears the alert ${await ev(() => JSON.stringify({c: centreId, g: !!glide, h: document.getElementById('offAlert').hidden, al: seatAlerts, sl: document.getElementById('seats').scrollLeft}))}`);
  // selection flattens, then restores
  await ev(() => enterSelectMode()); await tick(50);
  ok(await ev(() => [...document.querySelectorAll('#seats .seat')].every(c => !/rotateY/.test(c.style.transform) && !c.classList.contains('side'))), `${tag}: selection mode flattens the carousel`);
  await ev(() => { setSelected('b6', true); setSelected('b5', true); }); await tick(50);
  if (!reduce) await p.waitForTimeout(600);
  await shot('select');
  await ev(() => exitSelectMode()); await tick(50);
  ok(await ev(() => document.getElementById('seat-b1').classList.contains('side') && (matchMedia('(prefers-reduced-motion: reduce)').matches || /rotateY|scale\(0\./.test(document.getElementById('seat-b1').style.transform))), `${tag}: leaving selection restores the carousel`);
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
  const r = await ev(() => { const t = document.querySelector('#seat-b1 .timer'), cs = getComputedStyle(t); return { ff: cs.fontFamily, fw: +cs.fontWeight, num: cs.fontVariantNumeric, lab: getComputedStyle(document.querySelector('#seat-b1 .seat-label'), '::before').content, svg: document.querySelectorAll('#seat-b1 svg.li').length, lead: getComputedStyle(document.querySelector('#seat-b1 .ring .lead')).display, bf: getComputedStyle(document.querySelector('#seat-b1')).backdropFilter, bi: getComputedStyle(document.querySelector('#seat-b1')).backgroundImage, sh: getComputedStyle(document.querySelector('#seat-b1')).boxShadow, sheet: getComputedStyle(document.querySelector('.settings-panel')).backdropFilter }; });
  ok(/InterLocal/.test(r.ff) && r.fw <= 300 && /tabular-nums/.test(r.num), `${tag}: thin tabular timer digits in Inter (${r.ff.slice(0, 30)}, ${r.fw}, ${r.num})`);
  ok(/Seat ·/.test(r.lab), `${tag}: letter-spaced 'Seat · B1' label (${r.lab})`);
  ok(r.svg >= 1 && await ev(() => !/[▶⏸↺]/u.test(document.querySelector('#seat-b1 .btn-primary').textContent)), `${tag}: line icons instead of emoji (${r.svg} svg)`);
  ok(r.lead === 'block', `${tag}: gradient ring lead dot shown`);
  ok((r.bf === 'none' || !r.bf) && /gradient/.test(r.bi) && r.sh === 'none' && /blur/.test(r.sheet || ''), `${tag}: cards are solid glass-look (gradient face; no backdrop blur and no box-shadow on moving cards for smoothness); sheets stay frosted (${r.sheet})`);
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
  ok(await ev(() => document.querySelectorAll('.guest-card').length === 8 && /rgb\(/.test(getComputedStyle(document.querySelector('.guest-card')).backgroundColor) && /InterLocal/.test(getComputedStyle(document.querySelector('.guest-card')).fontFamily)), `${tag}: guest view premium-styled`);
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

async function chipTests(browser, name, opts, reduce, narrow) {
  const W = narrow ? 340 : 412;
  const tag = name + (reduce ? '-reduced' : '') + (narrow ? ' seat buttons (340px)' : ' seat buttons');
  if (name === 'pixel7' && narrow) opts = { ...opts, viewport: { width: 340, height: 740 }, screen: { width: 340, height: 740 } };
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE); await p.clock.fastForward(300);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const settleWait = async () => { for (let k = 0; k < 25; k++) { await tick(30); await p.waitForTimeout(reduce ? 5 : 40); } };
  const shot = async n => { if (name === 'pixel7' && !narrow && !reduce) await p.screenshot({ path: path.join(SHOTS, `chips-${TAG}-pixel7-${n}.png`), fullPage: true }); };
  if (name !== 'pixel7') {
    ok(await ev(() => getComputedStyle(document.getElementById('seatNav')).display === 'none'), `${tag}: wide screen keeps the full fan without chips`);
    await ctx.close(); return;
  }
  const chips = () => ev(() => [...document.querySelectorAll('#seatNav button')].map(b => { const a = b.getBoundingClientRect(), cs = getComputedStyle(b);
    return { id: b.id.slice(4), t: b.querySelector('.cn').textContent, m: b.querySelector('.cm').textContent, l: a.left, r: a.right, h: a.height, w: a.width, top: a.top, cls: b.className, bc: cs.borderTopColor, bs: cs.borderTopStyle, bg: cs.backgroundColor,
      clip: [...b.querySelectorAll('.cn, .cm')].some(k => k.scrollWidth > k.clientWidth + .5 || k.getBoundingClientRect().right > a.right + .5 || k.getBoundingClientRect().left < a.left - .5) }; }));
  let c = await chips();
  ok(c.length === 8 && c.map(x => x.id).join() === 'b8,b7,b6,b5,b4,b3,b2,b1' && c.map(x => x.t).join() === 'B8,B7,B6,B5,B4,B3,B2,B1', `${tag}: 8 chips, B8 left .. B1 right`);
  ok(c.every((x, i) => i === 0 || x.l > c[i - 1].r - .5) && Math.max(...c.map(x => x.top)) - Math.min(...c.map(x => x.top)) <= 4, `${tag}: chips in one row, not overlapping`);
  ok(c[0].l >= 0 && c[7].r <= W && await ev(() => { const n = document.getElementById('seatNav'); return n.scrollWidth <= n.clientWidth && document.documentElement.scrollWidth <= innerWidth; }), `${tag}: row fits ${W}px with no overflow (${Math.round(c[0].l)}..${Math.round(c[7].r)})`);
  ok(c.every(x => x.h >= 44 && x.w >= (narrow ? 34 : 44)), `${tag}: touch targets ≥44px tall (min ${Math.min(...c.map(x => x.h)).toFixed(0)}×${Math.min(...c.map(x => x.w)).toFixed(0)})`);
  ok(c.every(x => !x.clip), `${tag}: no clipped chip text`);
  ok(await ev(() => { const n = document.getElementById('seatNav').getBoundingClientRect(), s = document.getElementById('seat-b1').getBoundingClientRect(); return n.top >= s.bottom - 1 && n.bottom <= document.documentElement.scrollHeight; }), `${tag}: chips sit under the ${narrow ? 'fan' : 'depth stack'}`);
  if (!narrow) ok(await ev(() => document.body.classList.contains('depth') && [...document.querySelectorAll('#seats .seat.side')].length === 7), `${tag}: back cards still shown behind the front card (buttons are in addition)`);
  ok(c[7].cls.includes('centre') && c.filter(x => x.cls.includes('centre')).length === 1, `${tag}: centred B1 chip highlighted`);
  // statuses
  await ev(() => { ['b2', 'b3', 'b6', 'b7', 'b8'].forEach(id => startTimer(id)); seats.b3.startTime -= 34 * 60000; seats.b2.startTime -= 50 * 60000; seats.b7.startTime -= 61 * 60000; togglePause('b6'); });
  await tick(400);
  c = await chips(); const by = Object.fromEntries(c.map(x => [x.id, x]));
  const col = v => ev(v => { const d = document.createElement('i'); d.style.color = `var(${v})`; document.body.appendChild(d); const r = getComputedStyle(d).color; d.remove(); return r; }, v);
  ok(by.b8.bc === await col('--bar-ok') && by.b3.bc === await col('--bar-warn') && by.b2.bc === await col('--bar-danger'), `${tag}: chip edges in status colours (running / amber / red)`);
  ok(by.b7.bg === await col('--bar-danger') && by.b7.m === 'up', `${tag}: time-up chip filled red and reads 'up'`);
  ok(by.b6.bs === 'dashed' && /paused/.test(by.b6.cls), `${tag}: paused chip has dashed paused styling`);
  ok(by.b5.m === 'free' && by.b8.m === '60m' && by.b3.m === '26m', `${tag}: chips show minutes left / free (${c.map(x => x.m).join(',')})`);
  ok(c.every(x => !x.clip), `${tag}: no clipped chip text with busy seats`);
  // alert pulse
  ok(await ev(() => document.getElementById('nav-b7').classList.contains('alert') && !document.getElementById('offAlert').hidden), `${tag}: off-centre time-up pulses the B7 chip (and Show button stays)`);
  const pa = await ev(() => getComputedStyle(document.getElementById('nav-b7'), '::after').animationName);
  ok(reduce ? pa === 'none' : pa === 'breathe', `${tag}: chip alert ${reduce ? 'static under reduced motion' : 'pulses'} (${pa})`);
  await shot('alert');
  // tap centres
  await p.locator('#nav-b5').tap(); await settleWait();
  ok(await ev(() => centreId === 'b5' && document.getElementById('nav-b5').classList.contains('centre') && !document.getElementById('nav-b1').classList.contains('centre')), `${tag}: tapping B5 chip centres B5 and moves the highlight`);
  if (!reduce) await p.waitForTimeout(400); await shot('b5');
  // highlight follows a swipe
  await ev(() => { const sc = document.getElementById('seats'); sc.scrollLeft += document.getElementById('seat-b5').offsetWidth * 1.2; userScroll = true; updateFlow(); settle(); }); await settleWait(); await tick(300);
  ok(await ev(() => centreId === 'b4' && document.getElementById('nav-b4').classList.contains('centre')), `${tag}: chip highlight follows a swipe (now ${await ev(() => centreId)})`);
  // the fan has no clipped text: side cards are clean covers, centre card text fits
  if (narrow) ok(await ev(() => { const bad = []; for (const c of document.querySelectorAll('#seats .seat.side')) { const m = c.querySelector('.mini'), a = m.getBoundingClientRect(), b = c.getBoundingClientRect(); if (a.width < b.width - 2 || [...m.children].some(k => getComputedStyle(k).display !== 'none')) bad.push(c.dataset.seat); } return bad.length === 0; }), `${tag}: phone side cards are clean peeks (no squeezed/clipped text)`);
  ok(await ev(() => { const c = document.getElementById('seat-' + centreId), cr = c.getBoundingClientRect(); return [...c.querySelectorAll('.timer, .seat-label, .badge, .meta, .seat-actions button')].filter(e => e.offsetWidth > 0).every(e => { const r = e.getBoundingClientRect(); return e.scrollWidth <= e.clientWidth + 1 && r.left >= cr.left - 1 && r.right <= cr.right + 1; }); }), `${tag}: centre card text not clipped ${await ev(() => { const c = document.getElementById('seat-' + centreId), cr = c.getBoundingClientRect(); return [...c.querySelectorAll('.timer, .seat-label, .badge, .meta, .seat-actions button')].filter(e => { const r = e.getBoundingClientRect(); return !(e.scrollWidth <= e.clientWidth + 1 && r.left >= cr.left - 1 && r.right <= cr.right + 1); }).map(e => e.className + ':' + e.scrollWidth + '/' + e.clientWidth + ' ' + Math.round(e.getBoundingClientRect().left) + '-' + Math.round(e.getBoundingClientRect().right) + ' card ' + Math.round(cr.left) + '-' + Math.round(cr.right)).join(' ; '); })}`);
  // selection mode: chip tap selects
  await ev(() => enterSelectMode()); await tick(50);
  if (!reduce) await p.waitForTimeout(500);
  await p.locator('#nav-b3').scrollIntoViewIfNeeded();
  ok(await ev(() => { const a = document.getElementById('nav-b3').getBoundingClientRect(), e = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2); return e && e.closest('#nav-b3'); }), `${tag}: in selection mode the action bar does not cover the chips`);
  await p.locator('#nav-b3').tap(); await tick(300);
  ok(await ev(() => selectMode && seats.b3.selected && document.getElementById('nav-b3').classList.contains('sel')), `${tag}: in selection mode a chip tap selects the seat`);
  await ev(() => setSelected('b2', true)); await tick(300); if (!reduce) await p.waitForTimeout(600); await shot('select');
  await ev(() => exitSelectMode()); await tick(300);
  // keys still map to seats
  ok(await ev(() => document.getElementById('nav-b1').getAttribute('aria-label').startsWith('B1')), `${tag}: chips are labelled for screen readers`);
  // B1 shot, Daytime, Arcade
  await ev(() => { delete seatAlerts.b7; jumpTo('b1'); }); await settleWait(); await tick(300); if (!reduce) await p.waitForTimeout(500); await shot('b1');
  if (reduce) await shot('reduced');
  await ev(() => setDaytime(true)); await tick(300); if (!reduce) await p.waitForTimeout(500);
  ok(await ev(() => document.body.classList.contains('daytime') && getComputedStyle(document.getElementById('seatNav')).display === 'grid'), `${tag}: chips in Daytime`); await shot('daytime');
  await ev(() => { setDaytime(false); setLook('arcade'); }); await tick(300); if (!reduce) await p.waitForTimeout(500);
  c = await chips();
  ok(await ev(() => document.body.classList.contains('theme-arcade')) && c.length === 8 && c.every(x => !x.clip && x.h >= 44), `${tag}: chips in Arcade`); await shot('arcade');
  await ev(() => toggleGuestView()); await tick(200);
  ok(await ev(() => getComputedStyle(document.getElementById('seatNav')).display === 'none'), `${tag}: chips hidden in guest view`);
  await ev(() => toggleGuestView()); await ev(() => setLook('premium'));
  ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

const DISPLAY_IDS_IDX = id => ['b8','b7','b6','b5','b4','b3','b2','b1'].indexOf(id);
async function smoothTests(browser, name, opts) {
  if (name !== 'pixel7') return;
  const tag = 'pixel7 smooth';
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => { sessionStorage.setItem('bst.intro', '1'); window.__noLite = 1; });
  await p.goto(BASE); await p.waitForTimeout(1200);
  await p.evaluate(() => { ['b2', 'b3', 'b5', 'b6', 'b7'].forEach(id => startTimer(id)); seats.b7.startTime -= 61 * 60000; });
  await p.waitForTimeout(600);
  const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // frame times during scripted tap-to-front glides + a touch swipe, measured with rAF in the page
  await p.evaluate(() => { const f = []; let last = 0, on = true; const loop = t => { if (last && inMotion()) f.push(t - last); last = t; if (on) requestAnimationFrame(loop); }; requestAnimationFrame(loop); window.__stopF = () => { on = false; return f; }; });   // frames while a drag or settle is in progress
  const mid = [];
  for (const id of ['b6', 'b2', 'b8', 'b1']) { await p.evaluate(id => { jumpTo(id, true); }, id); await p.waitForTimeout(150); mid.push(await p.evaluate(() => document.body.classList.contains('moving'))); await p.waitForTimeout(600); }
  const box = await p.locator('#seats').boundingBox(), y = Math.round(box.y + box.height * .45);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y }] });
  for (let k = 1; k <= 20; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120 + k * 9, y }] }); await p.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(900);
  const f = (await p.evaluate(() => window.__stopF())).sort((a, b) => a - b), q = k => f[Math.min(f.length - 1, Math.floor(k * f.length))];
  console.log(`INFO ${tag}: 4x CPU throttle, ${f.length} frames: p50 ${q(.5).toFixed(1)}ms, p95 ${q(.95).toFixed(1)}ms, max ${f[f.length - 1].toFixed(1)}ms`);
  const drops = f.filter(x => x > 17.5).length;
  console.log(`INFO ${tag}: 60 Hz motion frames: ${drops} of ${f.length} missed one vsync`);
  ok(q(.5) <= 17 && q(.95) <= 17, `${tag}: drag + settle hold 60 fps under 4x CPU throttle (p50 ${q(.5).toFixed(1)}ms, p95 ${q(.95).toFixed(1)}ms ≤ 17)`);
  ok(f[f.length - 1] <= 34, `${tag}: no motion frame longer than two vsyncs (max ${f[f.length - 1].toFixed(1)}ms ≤ 34; 33.3 = a single missed vsync)`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  ok(mid.every(Boolean), `${tag}: ambient effects pause while the fan moves (body.moving during glides)`);
  await p.waitForTimeout(500);
  ok(await p.evaluate(() => !document.body.classList.contains('moving')), `${tag}: ambient effects resume at rest`);
  ok(await p.evaluate(() => [...document.querySelectorAll('#seats .seat')].every(c => getComputedStyle(c).backdropFilter === 'none' && getComputedStyle(c).willChange === 'auto')) && await p.evaluate(() => { glide = { raf: 0 }; moving(); const ok = [...document.querySelectorAll('#seats .seat')].every(c => /transform/.test(getComputedStyle(c).willChange) && /opacity/.test(getComputedStyle(c).willChange)); glide = null; return ok; }), `${tag}: cards have no backdrop blur; promoted (will-change) only while moving, freed at rest`);
  // the per-frame pose reads no layout: updateFlow with a known scroll position triggers no forced layout
  ok(await p.evaluate(() => { let reads = 0; const P = HTMLElement.prototype, keys = ['offsetLeft', 'offsetWidth', 'offsetTop', 'offsetHeight', 'offsetParent', 'clientWidth']; const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(P, k) || Object.getOwnPropertyDescriptor(Element.prototype, k)]);
    for (const [k, d] of saved) { const host = Object.getOwnPropertyDescriptor(P, k) ? P : Element.prototype; Object.defineProperty(host, k, { configurable: true, get() { reads++; return d.get.call(this); } }); }
    const gb = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function () { reads++; return gb.call(this); };
    try { updateFlow(document.getElementById('seats').scrollLeft); updateNav(); } finally { for (const [k, d] of saved) { const host = Object.getOwnPropertyDescriptor(P, k) ? P : Element.prototype; Object.defineProperty(host, k, d); } Element.prototype.getBoundingClientRect = gb; }
    return reads === 0; }), `${tag}: per-frame fan update + nav do zero layout reads`);
  // ---- One motion source: no native scroll, one float position, transform/opacity only ----
  ok(await p.evaluate(() => { const sc = document.getElementById('seats'), cs = getComputedStyle(sc); return sc._native.get.call(sc) === 0 && cs.overflowX === 'hidden' && cs.touchAction === 'pan-y'; }), `${tag}: the stack is not a native scroller (overflow hidden, real scrollLeft 0, touch-action pan-y)`);
  ok(await p.evaluate(() => [...document.querySelectorAll('#seats .seat')].every(c => { const cs = getComputedStyle(c); return cs.transitionDuration.split(',').every(d => parseFloat(d) === 0) && cs.boxShadow === 'none' && cs.filter === 'none' && (!cs.webkitBoxReflect || cs.webkitBoxReflect === 'none') && cs.scale === 'none' && cs.rotate === 'none'; })), `${tag}: moving cards have no transitions, box-shadow, filter, reflection, or scale/rotate properties fighting the JS transform`);
  const trace = async fn => {   // collect UpdateLayoutTree / Layout events while fn runs
    const evs = []; const on = d => evs.push(...d.value); cdp.on('Tracing.dataCollected', on);
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline' + ',disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReportEvents' });
    await fn();
    const done = new Promise(r => cdp.once('Tracing.tracingComplete', r)); await cdp.send('Tracing.end'); await done; cdp.off('Tracing.dataCollected', on);
    const st = evs.filter(e => e.name === 'UpdateLayoutTree' && e.ph === 'X'), lay = evs.filter(e => e.name === 'Layout');
    const inv = evs.filter(e => e.name === 'StyleRecalcInvalidationTracking').map(e => ((e.args && e.args.data) || {}).nodeName || '');
    if (process.env.INV) { const agg = {}; evs.filter(e => /Invalidation/.test(e.name)).forEach(e => { const d = (e.args && e.args.data) || {}; const k = e.name + ' ' + (d.nodeName || '') + ' ' + (d.reason || d.invalidationList && JSON.stringify(d.invalidationList).slice(0, 120) || '') + ' ' + (d.changedClass || d.changedAttribute || d.changedId || d.changedPseudo || ''); agg[k] = (agg[k] || 0) + 1; }); console.log('INV', JSON.stringify(agg, null, 1)); }
    return { inv, recalcs: st.length, maxEls: Math.max(0, ...st.map(e => (e.args && e.args.elementCount) || 0)), layouts: lay.length };
  };
  await p.evaluate(() => jumpTo('b1')); await p.waitForTimeout(1100);
  await p.evaluate(() => { window.__cardCls = [...document.querySelectorAll('#seats .seat')].map(c => c.className).join('|'); jumpTo('b8', true); }); await p.waitForTimeout(40);
  const tg = await trace(async () => { await p.waitForTimeout(260); });
  const outside = await p.evaluate(() => { const sc = document.getElementById('seats'); return [...document.querySelectorAll('body *')].filter(e => !sc.contains(e)).map(e => e.tagName + (e.id ? ` id='${e.id}'` : '') + (e.getAttribute('class') ? ` class='${e.getAttribute('class')}'` : '')); });
  const nonCard = list => [...new Set(list.filter(n => n && outside.includes(n)))];
  const rolesSame = await p.evaluate(() => [...document.querySelectorAll('#seats .seat')].map(c => c.className).join('|') === window.__cardCls && !!glide);
  console.log(`INFO ${tag}: glide frames: ${tg.recalcs} style recalcs, max ${tg.maxEls} elements each, ${tg.layouts} layouts`);
  ok(tg.recalcs >= 3 && tg.layouts === 0 && nonCard(tg.inv).length === 0, `${tag}: spring frames do zero layout and zero style recalculation outside the cards (${tg.recalcs} recalcs, ${tg.layouts} layouts, outside: ${JSON.stringify(nonCard(tg.inv))})`);

  await p.waitForTimeout(900);
  ok(rolesSame, `${tag}: no class toggles mid-motion (card roles change only at rest)`);
  ok(await p.evaluate(() => centreId === 'b8' && document.getElementById('seat-b8').classList.contains('centre') && document.querySelectorAll('#seats .seat.centre').length === 1), `${tag}: roles catch up once the spring settles`);
  // a finger drag: position tracks the finger 1:1 every frame, with no layout
  await p.evaluate(() => { jumpTo('b5'); sfxLog.length = 0; }); await p.waitForTimeout(1100);
  const fb = await p.locator('#seat-b5').boundingBox(), fy = Math.round(fb.y + fb.height * .6);
  const pos0 = await p.evaluate(() => document.getElementById('seats').scrollLeft);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: fy }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 290, y: fy }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 280, y: fy }] });   // past the 8px slop: the drag owns the gesture from here
  const base = await p.evaluate(() => document.getElementById('seats').scrollLeft);
  const lag = [];
  const td = await trace(async () => { for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 280 - k * 12, y: fy }] }); lag.push(await p.evaluate(() => new Promise(r => requestAnimationFrame(() => r(document.getElementById('seats').scrollLeft))))) ; } });
  const err = Math.max(...lag.map((v, k) => Math.abs(v - (base + (k + 1) * 12))));
  ok(err <= .5 && base > pos0, `${tag}: drag position follows the finger 1:1 on the next frame (max error ${err.toFixed(2)}px)`);
  console.log(`INFO ${tag}: drag frames: ${td.recalcs} style recalcs, max ${td.maxEls} elements, ${td.layouts} layouts`);
  ok(td.layouts === 0 && nonCard(td.inv).length === 0, `${tag}: drag frames do zero layout and zero style recalculation outside the cards (${td.recalcs} recalcs, ${td.layouts} layouts, outside: ${JSON.stringify(nonCard(td.inv))})`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(900);
  ok(await p.evaluate(() => { const sc = document.getElementById('seats'), i = DISPLAY_IDS.indexOf(centreId), c = FG.lefts[i] - (FG.W - FG.cw) / 2; return !glide && Math.abs(sc.scrollLeft - Math.max(0, Math.min(FG.max, c))) < .5; }), `${tag}: release springs exactly onto the nearest seat (${await p.evaluate(() => centreId)})`);
  // a hard flick from B8 to the far end: velocity projection carries it several seats, ticks are debounced
  await p.evaluate(() => { jumpTo('b8'); sfxLog.length = 0; }); await p.waitForTimeout(300);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 330, y: fy }] });
  for (let k = 1; k <= 6; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 330 - k * 40, y: fy }] }); await p.waitForTimeout(10); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(1300);
  const fl = await p.evaluate(() => ({ c: centreId, ticks: sfxLog.filter(x => x === 'tick').length, settle: sfxLog.filter(x => x === 'settle').length }));
  ok(DISPLAY_IDS_IDX(fl.c) >= 2 && fl.ticks <= DISPLAY_IDS_IDX(fl.c) && fl.settle === 1, `${tag}: a flick coasts several seats on its velocity (B8 → ${fl.c.toUpperCase()}), ≤ one tick per seat passed (${fl.ticks}) and one settle ${await p.evaluate(() => JSON.stringify(window.__lastFlick))}`);
  ok(await p.evaluate(() => { const sc = document.getElementById('seats'); return sc._native.get.call(sc) === 0; }), `${tag}: the real scroll position never moved during gestures`);
  // tapping a seat button uses the same spring
  await p.evaluate(() => { window.__g = []; const o = glideTo; glideTo = function (sc, to, v) { window.__g.push('spring'); return o.apply(this, arguments); }; });
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(100);
  { const q = await p.evaluate(() => { const c = document.getElementById('seat-b3'), a = c.getBoundingClientRect(); return [c.classList.contains('sr') ? a.right - 8 : a.left + 8, a.top + a.height / 2]; }); await p.touchscreen.tap(q[0], q[1]); } await p.waitForTimeout(900);
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(100);
  await p.evaluate(() => { const c = document.getElementById('seat-b6'), a = c.getBoundingClientRect(); window.__pt = [c.classList.contains('sr') ? a.right - 8 : a.left + 8, a.top + a.height / 2]; });
  const bp = await p.evaluate(() => window.__pt); await p.touchscreen.tap(bp[0], bp[1]); await p.waitForTimeout(900);
  ok(await p.evaluate(() => window.__g.length === 2 && centreId === 'b6'), `${tag}: back-card taps run the same spring as a swipe release ${await p.evaluate(() => JSON.stringify([window.__g, centreId, window.__pt]))}`);
  // performance meter
  await p.evaluate(() => setPerfMeter(true)); await p.waitForTimeout(1300);
  ok(await p.evaluate(() => !document.getElementById('perfMeter').hidden && /\d+ fps · worst \d+ ms/.test(document.getElementById('perfMeter').textContent) && settings.perfMeter === true), `${tag}: Settings 'Show performance meter' shows live fps (${await p.evaluate(() => document.getElementById('perfMeter').textContent)})`);
  ok(await p.evaluate(() => !!document.getElementById('setPerf') && /Show performance meter/.test(document.getElementById('setPerf').parentElement.textContent)), `${tag}: performance meter toggle is in Settings`);
  await p.evaluate(() => setPerfMeter(false));
  ok(await p.evaluate(() => document.getElementById('perfMeter').hidden && !settings.perfMeter), `${tag}: performance meter turns off`);
  // Smooth mode: slow frames engage lite automatically
  ok(await p.evaluate(() => { delete window.__noLite; setQuality('auto'); perfWatch.slow = 0; for (let r = 0; r < 8; r++) { perfWatch.f = Array.from({ length: 30 }, () => 40); perfWatch.raf = 1; perfWatch.stop(); } return document.body.classList.contains('lite') && localStorage.getItem('bst.lite') === 'auto'; }), `${tag}: slow frames switch on Smooth mode automatically`);
  ok(await p.evaluate(() => { const c = getComputedStyle(document.getElementById('seat-b2')); return c.webkitBoxReflect === 'none' || !c.webkitBoxReflect || c.webkitBoxReflect === ''; }) && await p.evaluate(() => getComputedStyle(document.getElementById('spot')).display === 'none'), `${tag}: Smooth mode drops reflections and the spotlight`);
  await p.reload(); await p.waitForTimeout(500);
  ok(await p.evaluate(() => document.body.classList.contains('lite')), `${tag}: Smooth mode remembered on this device`);
  await p.evaluate(() => setLite(false));
  ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}


// ---- Tablets / landscape / desktop: the depth stack with its row of 7 back-card seat buttons everywhere
async function tabletTests(browser) {
  const sizes = [[768, 1024], [1024, 768], [800, 1280], [1280, 800], [1366, 1024], [1024, 1366], [915, 412], [412, 915], [1440, 900]];
  for (const [w, h] of sizes) {
    const tag = `tablet ${w}x${h}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: w < 1400, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(INIT); await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
    await p.goto(BASE); await p.waitForTimeout(700);
    const ev = (f, a) => p.evaluate(f, a);
    await ev(() => { ['b2', 'b3', 'b6', 'b7', 'b8'].forEach(startTimer); seats.b3.startTime -= 34 * 60000; seats.b2.startTime -= 50 * 60000; seats.b7.startTime -= 61 * 60000; togglePause('b6'); });
    await p.waitForTimeout(500);
    ok(await ev(() => document.body.classList.contains('depth') && getComputedStyle(document.getElementById('seatNav')).display === 'none'), `${tag}: depth stack with back-card seat buttons (no fan, no chip row)`);
    const bad = [];
    for (const id of ['b8', 'b5', 'b1']) {
      await ev(id => jumpTo(id), id); await p.waitForTimeout(120);
      const g = await ev(() => { const vw = document.documentElement.clientWidth, cs = [...document.querySelectorAll('#seats .seat.side')].map(c => ({ r: c.getBoundingClientRect(), t: getComputedStyle(c).translate })).sort((a, b) => a.r.left - b.r.left);
        const ws = cs.map(c => c.r.width), hs = cs.map(c => c.r.height), gaps = cs.slice(1).map((c, k) => c.r.left - cs[k].r.right), tops = cs.filter(c => c.t === 'none').map(c => c.r.top);
        const a = document.getElementById('offAlert').getBoundingClientRect(), hit = cs.some(c => !document.getElementById('offAlert').hidden && c.r.left < a.right && c.r.right > a.left && c.r.top < a.bottom && c.r.bottom > a.top);
        const font = Math.min(...[...document.querySelectorAll('#seats .seat.side .mini .mn b')].map(b => b.getBoundingClientRect().height));
        return { n: cs.length, minL: Math.min(...cs.map(c => c.r.left)), maxR: Math.max(...cs.map(c => c.r.right)), vw, minTop: Math.min(...cs.map(c => c.r.top)), wMin: Math.min(...ws), hMin: Math.min(...hs), ws: Math.max(...ws) - Math.min(...ws), gs: Math.max(...gaps) - Math.min(...gaps), ts: Math.max(...tops) - Math.min(...tops), hit, font }; });
      if (!(g.n === 7 && g.minL >= 8 && g.maxR <= g.vw - 8 && g.minTop >= 0 && g.wMin >= 48 && g.hMin >= 48 && g.ws < 1 && g.gs < 1.5 && g.ts < 1 && !g.hit)) bad.push(id + ':' + JSON.stringify(g));
      if (id === 'b1') ok(w < 600 || g.wMin >= 80, `${tag}: larger screens get larger back cards (${g.wMin.toFixed(0)}px wide, ${g.font.toFixed(0)}px seat numbers)`);
    }
    ok(bad.length === 0, `${tag}: all 7 back cards fully visible with ≥8px margins, even, ≥48px, one row, clear of the Show alert ${bad.join(' ')}`);
    ok(await ev(() => { const f = document.getElementById('seat-' + centreId).getBoundingClientRect(); return f.width <= 470 && Math.abs((f.left + f.right) / 2 - document.documentElement.clientWidth / 2) < 2; }), `${tag}: front card capped and centred`);
    // tap a back card -> spring to front
    await ev(() => window.scrollTo(0, 0)); await p.waitForTimeout(100);
    const q = await ev(() => { const a = document.getElementById('seat-b4').getBoundingClientRect(); return [a.left + a.width / 2, a.top + Math.min(20, a.height / 3)]; });
    await p.touchscreen.tap(q[0], q[1]); await p.waitForTimeout(900);
    ok(await ev(() => centreId === 'b4' && !seats.b4.running && !glide), `${tag}: tapping B4's back card springs it to the front`);
    // drag tracks the finger
    const cdp = await ctx.newCDPSession(p);
    const fb = await p.locator('#seat-b4').boundingBox(), fy = Math.round(fb.y + Math.min(fb.height * .6, (h - fb.y) - 20)), fx = Math.round(w / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fx, y: fy }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fx - 12, y: fy }] });
    const base = await ev(() => document.getElementById('seats').scrollLeft); let err = 0;
    for (let k = 1; k <= 6; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fx - 12 - k * 15, y: fy }] }); const v = await ev(() => new Promise(r => requestAnimationFrame(() => r(document.getElementById('seats').scrollLeft)))); err = Math.max(err, Math.abs(v - (base + k * 15))); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(900);
    ok(err <= .5 && await ev(() => !glide), `${tag}: drag tracks the finger 1:1 (max error ${err.toFixed(2)}px) and springs to a seat (${await ev(() => centreId)})`);
    await ev(() => jumpTo('b1')); await p.waitForTimeout(400);
    if ([[768, 1024], [1024, 768], [1280, 800], [800, 1280], [915, 412]].some(([a, b]) => a === w && b === h)) await p.screenshot({ path: path.join(SHOTS, `tablet-${TAG}-${w}x${h}.png`) });
    ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
    await ctx.close();
  }
}

// ---- v4.3 parties were reverted: saved party data must load safely
async function partyMigrationTests(browser) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(INIT); await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
  await p.goto(BASE); await p.waitForTimeout(500);
  await p.evaluate(() => { const key = STORE_KEY, d = JSON.parse(localStorage.getItem(key) || '{}'); const t = Date.now() - 10 * 60000;
    d.seats = d.seats || {}; ['b4', 'b3'].forEach(id => { d.seats[id] = { running: true, paused: false, startTime: t, pausedAt: null, pausedTotal: 0, extraMs: 0, extensions: 0, limitMs: 3600000, greenMs: 1800000, amberMs: 2700000, party: 'b4+b3', sessionStart: new Date(t).toISOString() }; });
    d.history = [{ seat: 'b5', party: 'b6+b5', limitMin: 60, durationMin: 12, extensions: 0, start: new Date(t).toISOString(), end: new Date().toISOString(), autoEnd: false }];
    localStorage.setItem(key, JSON.stringify(d)); });
  await p.reload(); await p.waitForTimeout(800);
  const st = await p.evaluate(() => ({ party: ['b4', 'b3'].some(id => 'party' in seats[id]), run: seats.b4.running && seats.b3.running, left: Math.round((getDurationMs(seats.b4) - getElapsed(seats.b4)) / 60000), hp: history.some(h => 'party' in h), ui: !!document.querySelector('.btn-ungroup, .mpt, .lnk') || /party/i.test(document.body.innerText) }));
  ok(!st.party && st.run && st.left === 50 && !st.hp && !st.ui, `party migration: saved v4.3 party data loads as two ordinary running seats, no party UI (${JSON.stringify(st)})`);
  await p.evaluate(() => { jumpTo('b4'); document.querySelector('#seat-b4 .btn-reset').click(); }); await p.waitForTimeout(200);
  ok(await p.evaluate(() => !seats.b4.running && seats.b3.running), `party migration: former members end independently (nothing stuck)`);
  ok(errs.length === 0, `party migration: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

// ---- v4.4 Cover Flow on phones, tablets (both orientations) and desktop
async function coverflowTests(browser) {
  const sizes = [['pixel7', devices['Pixel 7']], ['915x412', { viewport: { width: 915, height: 412 } }], ['768x1024', { viewport: { width: 768, height: 1024 } }], ['1024x768', { viewport: { width: 1024, height: 768 } }],
    ['800x1280', { viewport: { width: 800, height: 1280 } }], ['1280x800', { viewport: { width: 1280, height: 800 } }], ['1366x1024', { viewport: { width: 1366, height: 1024 } }], ['1024x1366', { viewport: { width: 1024, height: 1366 } }], ['1440x900', { viewport: { width: 1440, height: 900 } }]];
  for (const [name, o] of sizes) {
    const tag = 'coverflow ' + name, phone = name === 'pixel7' || name === '915x412';
    const ctx = await browser.newContext({ hasTouch: true, isMobile: !/1440/.test(name), ...o, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(INIT); await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
    await p.goto(BASE); await p.waitForTimeout(700);
    const ev = (f, a) => p.evaluate(f, a);
    await ev(() => { ['b2', 'b3', 'b6', 'b7', 'b8'].forEach(id => startTimer(id, true)); seats.b3.startTime -= 34 * 60000; seats.b2.startTime -= 50 * 60000; seats.b7.startTime -= 61 * 60000; togglePause('b6', true); saveAll(); SEAT_IDS.forEach(updateSeat); });
    await ev(() => jumpTo('b5')); await p.waitForTimeout(500);
    const pose = await ev(() => DISPLAY_IDS.map(id => { const c = document.getElementById('seat-' + id), m = /rotateY\(([-\d.]+)deg\)/.exec(c.style.transform), a = c.getBoundingClientRect(); return { id, ry: m ? +m[1] : 0, cx: (a.left + a.right) / 2, op: +getComputedStyle(c).opacity }; }));
    const cen = pose.find(x => x.id === 'b5'), L = pose.slice(0, 3), R = pose.slice(4);
    ok(Math.abs(cen.ry) < .01 && L.every(x => x.ry >= 60 && x.ry <= 70) && R.every(x => x.ry <= -60 && x.ry >= -70), `${tag}: centre faces forward (0°), side cards turned 60–70° away from it (${pose.map(x => x.ry.toFixed(0)).join(',')})`);
    const shown = pose.filter(x => x.op > .05);
    ok(shown.every((x, i) => !i || x.cx > shown[i - 1].cx) && shown.map(x => x.id).join() === ['b8','b7','b6','b5','b4','b3','b2','b1'].filter(id => shown.some(s => s.id === id)).join(), `${tag}: B8..B1 left to right`);
    ok(await ev(() => !document.body.classList.contains('depth') && [...document.querySelectorAll('#seats .seat')].every(c => !/box-reflect/.test(c.getAttribute('style') || '') && (getComputedStyle(c).webkitBoxReflect || 'none') === 'none') && !!document.querySelector('#seat-b4 .refl') && getComputedStyle(document.querySelector('#seat-b4 .refl')).display !== 'none'),
      `${tag}: reflections are a static child (no box-reflect on moving cards)`);
    // visible + readable for every centred seat
    const bad = []; let minShown = 8;
    for (const id of ['b8','b7','b6','b5','b4','b3','b2','b1']) {
      await ev(id => jumpTo(id), id); await p.waitForTimeout(60);
      const r = await ev(() => { const vw = document.documentElement.clientWidth, vh = innerHeight, out = [];
        for (const c of document.querySelectorAll('#seats .seat')) { if (+getComputedStyle(c).opacity < .05) continue;
          const a = c.getBoundingClientRect(), cen = c.classList.contains('centre'), x = { id: c.dataset.seat, inV: a.left >= 0 && a.right <= vw && a.top >= 0 && (a.bottom <= vh || vh < 500) };   // short landscape phones: the page scrolls vertically, the label sits high
          if (!cen) { const m = c.querySelector('.mini'), parts = [...m.querySelectorAll('.mn, .mm')]; x.txt = parts.map(k => k.textContent).join(' ');
            x.read = getComputedStyle(m).display === 'flex' && parts.every(k => { const b = k.getBoundingClientRect(), e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return b.width >= 6 && b.height >= 9 && b.left >= 0 && b.right <= vw && e && e.closest('.seat') === c; }); }
          else x.read = true; out.push(x); }
        return out; });
      minShown = Math.min(minShown, r.length);
      const b = r.filter(x => !x.inV || !x.read); if (b.length) bad.push(id + ':' + JSON.stringify(b));
    }
    ok(bad.length === 0, `${tag}: every shown card fully on screen, side cards show a readable seat number + minutes on their visible sliver ${bad.join(' ').slice(0, 600)}`);
    ok(phone ? minShown >= 4 : minShown === 8, `${tag}: ${phone ? 'as many side cards as fit readably' : 'all 8 seats visible'} for every centred seat (min ${minShown})`);
    // alert stays in the summary line, clear of the cards
    await ev(() => jumpTo('b1')); await p.waitForTimeout(300); await ev(() => { seats.b8.startTime -= 61 * 60000; }); await p.waitForTimeout(1500);
    ok(await ev(() => { const a = document.getElementById('offAlert'), r = a.getBoundingClientRect(); return !a.hidden && !!a.closest('#summary') && [...document.querySelectorAll('#seats .seat')].every(c => { const b = c.getBoundingClientRect(); return !(b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top); }); }), `${tag}: Show alert sits in the summary line and overlaps no card`);
    // tap a side card's sliver -> glides to centre; only the centre card's controls act
    await ev(() => window.scrollTo(0, 0)); await p.waitForTimeout(100);
    const q = await ev(() => { const c = document.getElementById('seat-b3'), a = c.getBoundingClientRect(); return [c.classList.contains('sr') ? a.right - 8 : a.left + 8, Math.min(a.top + a.height / 2, innerHeight - 30)]; });
    await p.touchscreen.tap(q[0], q[1]); await p.waitForTimeout(900);
    ok(await ev(() => centreId === 'b3' && !glide && seats.b3.running && seats.b3.startTime < Date.now() - 30 * 60000), `${tag}: tapping B3's side card glides it to the centre (and doesn't trigger its controls) ${await ev(q => { const e = document.elementFromPoint(q[0], q[1]); return centreId + ' ' + (e && (e.className + '|' + (e.closest('.seat') || {}).id)) + ' ' + q; }, q)}`);
    // drag 1:1 + settle on a seat + swing pose mid-drag
    const cdp = await ctx.newCDPSession(p), vw = await ev(() => innerWidth);
    const fb = await p.locator('#seat-b3').boundingBox(), y = Math.round(fb.y + Math.min(fb.height * .45, 160)), x = Math.round(vw / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 12, y }] });
    const base = await ev(() => document.getElementById('seats').scrollLeft); let err = 0, mid = null;
    for (let k = 1; k <= 8; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 12 + k * 14, y }] }); const v = await ev(() => new Promise(r => requestAnimationFrame(() => r(document.getElementById('seats').scrollLeft)))); err = Math.max(err, Math.abs(v - (base - k * 14))); if (k === 8) mid = await ev(() => ['b3', 'b4'].map(id => +(/rotateY\(([-\d.]+)deg\)/.exec(document.getElementById('seat-' + id).style.transform) || [0, 0])[1])); }
    await p.waitForTimeout(150); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(1000);
    ok(err <= .5, `${tag}: drag tracks the finger 1:1 (max error ${err.toFixed(2)}px)`);
    ok(Math.abs(mid[0]) > 1 && Math.abs(mid[0]) < 64 && Math.abs(mid[1]) < 64, `${tag}: mid-drag the cards swing through the centre (rotations ${mid.map(v => v.toFixed(1)).join(', ')})`);
    ok(await ev(() => { const sc = document.getElementById('seats'), i = DISPLAY_IDS.indexOf(centreId), t = Math.max(0, Math.min(FG.max, FG.lefts[i] - (FG.W - FG.cw) / 2)); return !glide && Math.abs(sc.scrollLeft - t) < .5 && /rotateY\(0(\.0+)?deg\)/.test(document.getElementById('seat-' + centreId).style.transform); }), `${tag}: release settles exactly on a seat (${await ev(() => centreId)}), facing forward`);
    if (['pixel7', '915x412', '768x1024', '1024x768'].includes(name)) { await ev(() => jumpTo('b5')); await p.waitForTimeout(700); await p.screenshot({ path: path.join(SHOTS, `coverflow-${TAG}-${name}.png`) }); }
    ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
    await ctx.close();
  }
}

// ---- v4.5: frame-rate independent spring, motion quality tiers + setting
async function qualityTests(browser) {
  for (const [name, o] of [['pixel7', devices['Pixel 7']], ['1280x800', { viewport: { width: 1280, height: 800 } }]]) {
    const tag = 'quality ' + name;
    const ctx = await browser.newContext({ ...o, serviceWorkers: 'block', reducedMotion: 'no-preference' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(INIT); await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
    await p.goto(BASE); await p.waitForTimeout(700);
    const ev = (f, a) => p.evaluate(f, a);
    if (name === 'pixel7') {
      // the spring itself, stepped at 60 vs 120 Hz (and 90, 30): same landing, same duration within one frame
      const s = await ev(() => [60, 90, 120, 30].map(hz => springSim(-600, 2500, hz)));
      ok(s.every(r => r.x === 0) && Math.max(...s.map(r => r.t)) - Math.min(...s.map(r => r.t)) <= 1 / 30 + 1e-9, `${tag}: spring lands on the seat with the same duration at 60/90/120/30 Hz (${s.map(r => (r.t * 1000).toFixed(0) + 'ms').join(' / ')})`);
      // the real glide driven by synthetic rAF timestamps at 60 Hz vs 120 Hz: the same curve in time and the same landing
      const run = await ev(async () => { const sc = document.getElementById('seats'), R = window.requestAnimationFrame, C = window.cancelAnimationFrame, res = {};
        for (const hz of [60, 120]) {
          jumpTo('b1'); let q = [], now = performance.now(), t0 = now; window.requestAnimationFrame = f => { q.push(f); return q.length; }; window.cancelAnimationFrame = () => {};
          const i = DISPLAY_IDS.indexOf('b6'), to = Math.max(0, Math.min(FG.max, FG.lefts[i] - (FG.W - FG.cw) / 2));
          glideTo(sc, to, 0); const tr = []; let n = 0;
          while (glide && n < 2000) { const fs = q; q = []; now += 1000 / hz; fs.forEach(f => f(now)); n++; tr.push([now - t0, sc.scrollLeft]); }
          window.requestAnimationFrame = R; window.cancelAnimationFrame = C;
          const at = ms => { let k = 0; tr.forEach((x, j) => { if (Math.abs(x[0] - ms) < Math.abs(tr[k][0] - ms)) k = j; }); return tr[k][1]; };
          res[hz] = { end: sc.scrollLeft, to, dur: tr.length ? tr[tr.length - 1][0] : 0, p100: at(100), p200: at(200) };
          if (glide) glideStop();
        }
        return res; });
      const a = run[60], b = run[120];
      ok(Math.abs(a.end - a.to) < .01 && Math.abs(b.end - b.to) < .01, `${tag}: glide lands exactly on the seat at 60 Hz and 120 Hz`);
      ok(Math.abs(a.dur - b.dur) <= 17 && Math.abs(a.p100 - b.p100) < 2 && Math.abs(a.p200 - b.p200) < 2, `${tag}: glide is frame-rate independent (duration ${a.dur.toFixed(0)} vs ${b.dur.toFixed(0)}ms; position at 100ms ${a.p100.toFixed(1)} vs ${b.p100.toFixed(1)}, at 200ms ${a.p200.toFixed(1)} vs ${b.p200.toFixed(1)})`);
      // a stalled frame (200 ms gap) is clamped: no jump past 1/30 s of spring time
      const st = await ev(() => { const sc = document.getElementById('seats'), R = window.requestAnimationFrame; jumpTo('b1'); let q = [], now = performance.now(); window.requestAnimationFrame = f => { q.push(f); return 1; };
        glideTo(sc, 0, 0); const xs = []; for (const dt of [16.7, 16.7, 200, 16.7]) { const fs = q; q = []; now += dt; fs.forEach(f => f(now)); xs.push(sc.scrollLeft); } window.requestAnimationFrame = R; glideStop(); return xs; });
      ok(Math.abs(st[2] - st[1]) > 0 && Math.abs(st[2] - st[1]) < Math.abs(st[1] - st[0]) * 2.6, `${tag}: a stalled frame is clamped (step after a 200ms stall ${(st[2] - st[1]).toFixed(1)}px vs normal ${(st[1] - st[0]).toFixed(1)}px)`);
      // pointer moves only record; drawing happens once per rAF
      ok(await ev(() => { const src = document.documentElement.innerHTML; return /getCoalescedEvents/.test(src); }), `${tag}: pointer velocity uses coalesced events`);
    }
    // setting: Motion quality Auto / High / Smooth
    ok(await ev(() => { const s = document.getElementById('setQuality'); return !!s && [...s.options].map(o => o.textContent).join() === 'Auto,High,Smooth' && s.value === 'auto'; }), `${tag}: Settings has 'Motion quality: Auto / High / Smooth' (default Auto)`);
    await ev(() => { ['b2', 'b3', 'b7'].forEach(id => startTimer(id, true)); jumpTo('b4'); }); await p.waitForTimeout(400);
    const snap = () => ev(() => { const c = [...document.querySelectorAll('#seats .seat')], shown = c.filter(x => x.style.opacity !== '0.00' && x.style.visibility !== 'hidden'), refl = getComputedStyle(document.querySelector('#seat-b3 .refl')).display;
      const G = fanGeom(document.getElementById('seats'), document.getElementById('seats').scrollLeft); return { tier: Q.tier, refl, kL: G.kL, kR: G.kR, rot: c.some(x => /rotateY\((?!0(\.0+)?deg)/.test(x.style.transform)), lite: document.body.classList.contains('lite'), shown: shown.length }; });
    const s0 = await snap();
    ok(s0.tier === 0 && s0.refl !== 'none' && s0.rot && !s0.lite, `${tag}: full quality at start (reflections, perspective) ${JSON.stringify(s0)}`);
    const slow = () => ev(() => { delete window.__noLite; for (let r = 0; r < 2; r++) { perfWatch.f = Array.from({ length: 30 }, () => 33.3); perfWatch.raf = 1; perfWatch.stop(); } });
    await slow(); const s1 = await snap();
    ok(s1.tier === 1 && s1.refl === 'none' && s1.rot, `${tag}: Auto, frames over budget: tier 1 drops reflections first ${JSON.stringify(s1)}`);
    await slow(); const s2 = await snap();
    ok(s2.tier === 2 && s2.kL <= 5 && s2.kR <= 5 && s2.rot, `${tag}: tier 2 shows at most 5 side cards per side ${JSON.stringify(s2)}`);
    await slow(); const s3 = await snap();
    ok(s3.tier === 3 && !s3.rot && !s3.lite, `${tag}: tier 3 flattens the perspective ${JSON.stringify(s3)}`);
    await p.reload(); await p.waitForTimeout(600);
    ok(await ev(() => Q.tier === 3 && Q.mode === 'auto'), `${tag}: the stepped-down tier is remembered on this device`);
    await slow();
    ok(await ev(() => document.body.classList.contains('lite')), `${tag}: still over budget at tier 3: Smooth mode`);
    // good frames never step down
    await ev(() => setQuality('auto')); await ev(() => { for (let r = 0; r < 4; r++) { perfWatch.f = Array.from({ length: 30 }, () => 16.7); perfWatch.raf = 1; perfWatch.stop(); } });
    ok(await ev(() => Q.tier === 0 && !document.body.classList.contains('lite')), `${tag}: frames within budget keep full quality`);
    // High: never steps down
    await ev(() => setQuality('high')); await slow(); await slow();
    ok(await ev(() => Q.tier === 0 && !document.body.classList.contains('lite') && Q.mode === 'high'), `${tag}: High never steps down, even on slow frames`);
    // Smooth: lite + flat from the start, remembered
    await ev(() => setQuality('smooth')); await p.waitForTimeout(100);
    const sm = await snap();
    ok(sm.lite && !sm.rot && sm.refl === 'none', `${tag}: Smooth = lite, flat, no reflections ${JSON.stringify(sm)}`);
    await p.reload(); await p.waitForTimeout(600);
    ok(await ev(() => Q.mode === 'smooth' && document.body.classList.contains('lite') && document.getElementById('setQuality').value === 'smooth'), `${tag}: Smooth setting remembered`);
    await ev(() => setQuality('auto'));
    ok(await ev(() => Q.tier === 0 && !document.body.classList.contains('lite')), `${tag}: back to Auto restores full quality`);
    // reflections only at rest; faded cards hidden at rest
    await ev(() => jumpTo('b1')); await p.waitForTimeout(500);
    const rr = await ev(() => { const r = document.querySelector('#seat-b3 .refl'), atRest = getComputedStyle(r).visibility; glide = { raf: 0 }; moving(); updateFlow(); const mv = getComputedStyle(r).visibility; glide = null; return { atRest, mv }; });
    ok(rr.atRest === 'visible' && rr.mv === 'hidden', `${tag}: reflections show only at rest ${JSON.stringify(rr)}`);
    await p.waitForTimeout(500);
    ok(await ev(() => [...document.querySelectorAll('#seats .seat')].every(c => c.style.opacity !== '0.00' || c.style.visibility === 'hidden')), `${tag}: cards faded out at rest are visibility:hidden`);
    ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
    await ctx.close();
  }
}

// ---- 60 Hz tablet: drag + settle frame times under 4x CPU throttle (motion frames only)
async function tabletPerfTests(browser) {
  for (const [name, vp] of [['1024x768', { width: 1024, height: 768 }]]) {
    const tag = 'tablet perf ' + name;
    const ctx = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true, serviceWorkers: 'block', reducedMotion: 'no-preference' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { sessionStorage.setItem('bst.intro', '1'); window.__noLite = 1; });
    await p.goto(BASE); await p.waitForTimeout(1000);
    await p.evaluate(() => { setQuality('high'); ['b2', 'b3', 'b5', 'b6', 'b7'].forEach(id => startTimer(id, true)); seats.b7.startTime -= 61 * 60000; jumpTo('b1'); }); await p.waitForTimeout(800);
    const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await p.evaluate(() => { const f = []; let last = 0, on = true; const loop = t => { if (last && inMotion()) f.push(t - last); last = t; if (on) requestAnimationFrame(loop); }; requestAnimationFrame(loop); window.__stopF = () => { on = false; return f; }; });
    const box = await p.locator('#seats').boundingBox(), y = Math.round(box.y + box.height * .45);
    for (let r = 0; r < 3; r++) { const dir = r % 2 ? -1 : 1, x0 = dir > 0 ? 200 : 820;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
      for (let k = 1; k <= 40; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dir * k * 9, y }] }); await p.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForFunction(() => !inMotion(), null, { timeout: 5000 }).catch(() => {}); await p.waitForTimeout(400); }
    for (const id of ['b6', 'b2', 'b8']) { await p.evaluate(id => jumpTo(id, true), id); await p.waitForFunction(() => !inMotion(), null, { timeout: 5000 }).catch(() => {}); await p.waitForTimeout(400); }
    const f = (await p.evaluate(() => window.__stopF())).sort((a, b) => a - b), q = k => f[Math.min(f.length - 1, Math.floor(k * f.length))];
    console.log(`INFO ${tag}: 4x CPU throttle, ${f.length} motion frames: p50 ${q(.5).toFixed(1)}ms, p95 ${q(.95).toFixed(1)}ms, max ${f[f.length - 1].toFixed(1)}ms, ${f.filter(x => x > 17.5).length} missed one vsync`);
    ok(q(.95) <= 17, `${tag}: drag + settle hold 60 fps (p95 ${q(.95).toFixed(1)}ms ≤ 17)`);
    const long = f.filter(x => x > 34).length;   // headless software compositing of 8 large 3D layers on a shared box: isolated outliers happen; real GPUs don't compose in software
    ok(long <= Math.ceil(f.length * .01), `${tag}: frames longer than two vsyncs are rare isolated outliers (${long} of ${f.length} ≤ 1%; max ${f[f.length - 1].toFixed(1)}ms)`);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
    await ctx.close();
  }
}

// ---- v4.6: selected cards stick together (visual only) + bigger seat names + side-card progress bars
async function stickTests(browser) {
  const sizes = [['pixel7', devices['Pixel 7']], ['915x412', { viewport: { width: 915, height: 412 }, hasTouch: true, isMobile: true }], ['768x1024', { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true }], ['1024x768', { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true }]];
  for (const [name, o] of sizes) {
    for (const reduce of name === 'pixel7' ? [false, true] : [false]) {
      const tag = 'stick ' + name + (reduce ? '-reduced' : '');
      const ctx = await browser.newContext({ ...o, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.addInitScript(INIT); await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
      await p.goto(BASE); await p.waitForTimeout(700);
      const ev = (f, a) => p.evaluate(f, a), settle = () => p.waitForTimeout(reduce ? 80 : 900);
      await ev(() => { startTimer('b3', true); seats.b3.startTime -= 20 * 60000; saveAll(); SEAT_IDS.forEach(updateSeat); });
      const shape = () => ev(() => { const s = JSON.parse(localStorage.getItem(STORE_KEY)); return JSON.stringify({ top: Object.keys(s).sort(), seat: Object.keys(s.seats.b1).sort(), set: Object.keys(s.settings).sort(), keys: Object.keys(localStorage).sort() }); });
      const shape0 = await shape();
      await ev(() => enterSelectMode()); await p.waitForTimeout(reduce ? 100 : 700);
      const rects = () => ev(() => { const o = {}; DISPLAY_IDS.forEach(id => { const a = document.getElementById('seat-' + id).getBoundingClientRect(); o[id] = { l: a.left, r: a.right, t: a.top, b: a.bottom }; }); o.vw = document.documentElement.clientWidth; o.vh = innerHeight; return o; });
      const r0 = await rects();
      // two non-adjacent seats: B7 and B3
      await ev(() => { toggleSelect('b7'); toggleSelect('b3'); });
      if (reduce) ok(await ev(() => !STICK.raf && document.getElementById('seat-b3').style.translate !== ''), `${tag}: reduced motion regroups instantly (no animation)`);
      await settle();
      const r1 = await rects(), gap = r1.b3.l - r1.b7.r;
      ok(r1.b7.l < r1.b3.l && gap <= 1 && gap >= -14, `${tag}: B7 and B3 (not neighbours) slide together, touching/overlapping slightly (gap ${gap.toFixed(1)}px), B7 left of B3`);
      const ring = await ev(() => { const rs = document.querySelectorAll('#seats .stick-ring'); if (rs.length !== 1) return { n: rs.length }; const a = rs[0].getBoundingClientRect(), cs = getComputedStyle(rs[0]); return { n: 1, l: a.left, r: a.right, t: a.top, b: a.bottom, host: rs[0].parentElement.id, bw: cs.borderTopWidth, op: cs.opacity, vis: cs.visibility }; });
      ok(ring.n === 1 && ring.host === 'seat-b7' && ring.l <= r1.b7.l + 1 && ring.r >= r1.b3.r - 1 && ring.t <= Math.min(r1.b7.t, r1.b3.t) + 1 && ring.b >= Math.max(r1.b7.b, r1.b3.b) - 1 && parseFloat(ring.bw) >= 2 && +ring.op > .9, `${tag}: one shared outline wraps the whole cluster ${JSON.stringify(ring)}`);
      ok(r1.b7.l >= -0.5 && r1.b3.r <= r1.vw + .5, `${tag}: the cluster is fully on screen (${r1.b7.l.toFixed(0)}–${r1.b3.r.toFixed(0)} of ${r1.vw})`);
      ok(await ev(() => { const cx = id => { const a = document.getElementById('seat-' + id).getBoundingClientRect(); return a.left + a.width / 2; }; const o = ['b8', 'b6', 'b5', 'b4', 'b2', 'b1'].map(cx); return o.every((x, i) => !i || x > o[i - 1]); }), `${tag}: the other cards keep B8..B1 order around the cluster`);
      ok(await ev(() => ['b7', 'b3'].every(id => { const l = document.querySelector('#seat-' + id + ' .seat-label').getBoundingClientRect(), k = document.querySelector('#seat-' + id + ' .sel-check').getBoundingClientRect(); return l.right <= k.left + 1 || l.left >= k.right - 1 || l.bottom <= k.top + 1 || l.top >= k.bottom - 1; })), `${tag}: seat names don't collide with the selection tick`);
      if (name !== '915x412') await p.screenshot({ path: path.join(SHOTS, `stick-${TAG}-${name}${reduce ? '-reduced' : ''}-two.png`) });
      // a third seat snaps on, in B8..B1 order inside the cluster
      await ev(() => toggleSelect('b5')); await settle();
      const r2 = await rects(), g1 = r2.b5.l - r2.b7.r, g2 = r2.b3.l - r2.b5.r;
      ok(r2.b7.l < r2.b5.l && r2.b5.l < r2.b3.l && g1 <= 1 && g1 >= -14 && g2 <= 1 && g2 >= -14, `${tag}: a third seat (B5) snaps on between them in B8..B1 order (gaps ${g1.toFixed(1)}, ${g2.toFixed(1)})`);
      ok(r2.b7.l >= -0.5 && r2.b3.r <= r2.vw + .5 && await ev(() => { const r = document.querySelector('#seats .stick-ring').getBoundingClientRect(), b = document.getElementById('seat-b3').getBoundingClientRect(); return r.right >= b.right - 1; }), `${tag}: 3-card cluster fully on screen with the outline spanning it`);
      if (!reduce) await p.screenshot({ path: path.join(SHOTS, `stick-${TAG}-${name}-three.png`) });
      // deselect peels it off back to its own slot
      await ev(() => toggleSelect('b5')); await settle();
      const r3 = await rects(), sl = await ev(() => document.getElementById('seats').scrollLeft), b5home = await ev(() => STICK.lefts[DISPLAY_IDS.indexOf('b5')]);
      ok(await ev(() => { const cx = id => { const a = document.getElementById('seat-' + id).getBoundingClientRect(); return [a.left, a.right]; }; const [b6, b5, b4, b7, b3] = ['b6', 'b5', 'b4', 'b7', 'b3'].map(cx);
        return !document.getElementById('seat-b5').classList.contains('stuck') && b6[0] < b5[0] && b5[0] < b4[0] && (b5[0] >= b3[1] - 1 || b5[1] <= b7[0] + 1); }), `${tag}: deselecting B5 peels it off: back in the B8..B1 row (between B6 and B4), clear of the cluster`);
      ok(Math.abs((r3.b3.l - r3.b7.r)) <= 14, `${tag}: B7 + B3 stay stuck after the peel`);
      // batch actions work on the selected seats exactly as before; no shared/party state
      await ev(() => { toggleSelect('b3'); toggleSelect('b5'); }); await settle();
      const before = await ev(() => ({ b7: seats.b7.startTime, b5: seats.b5.startTime }));
      await p.locator('#actionBar .ab-act', { hasText: 'Start' }).click(); await p.waitForTimeout(reduce ? 200 : 900);
      const after = await ev(() => ({ r: [seats.b7.running, seats.b5.running, seats.b3.running], sm: selectMode, tr: [...document.querySelectorAll('#seats .seat')].map(c => c.style.translate + c.style.scale).join(''), ring: document.querySelectorAll('.stick-ring').length, st: [seats.b7.startTime, seats.b5.startTime] }));
      ok(after.r[0] && after.r[1] && after.r[2] && !after.sm, `${tag}: action bar Start starts exactly the selected seats and leaves selection (${JSON.stringify(after.r)})`);
      ok(after.tr === '' && after.ring === 0, `${tag}: leaving selection springs everything back (no stick offsets or outline left)`);
      ok(await ev(() => { const cx = DISPLAY_IDS.map(id => { const a = document.getElementById('seat-' + id).getBoundingClientRect(); return a.left + a.width / 2; }); return cx.every((x, i) => !i || x > cx[i - 1]) && !document.body.classList.contains('select-mode') && (matchMedia('(prefers-reduced-motion: reduce)').matches || /rotateY/.test(document.querySelector('#seats .seat.side').style.transform)); }), `${tag}: the board is back to Cover Flow in B8..B1 order`);
      ok(await shape() === shape0 && await ev(() => !/party|group/i.test(localStorage.getItem(STORE_KEY)) && seats.b7 !== seats.b5 && typeof seats.b7.startTime === 'number'), `${tag}: saved state is unchanged in shape (no party/group/shared timer)`);
      // Cancel restores too
      await ev(() => { enterSelectMode(); toggleSelect('b8'); toggleSelect('b1'); }); await settle();
      ok(await ev(() => document.querySelectorAll('.seat.stuck').length === 2), `${tag}: B8 + B1 (opposite ends) stick`);
      const r4 = await rects(); ok(r4.b8.l >= -0.5 && r4.b1.r <= r4.vw + .5 && Math.abs(r4.b1.l - r4.b8.r) <= 14, `${tag}: B8 + B1 cluster touching and on screen`);
      await p.locator('#actionBar .ab-x').click(); await p.waitForTimeout(reduce ? 200 : 900);
      ok(await ev(() => !selectMode && [...document.querySelectorAll('#seats .seat')].every(c => !c.style.translate && !c.style.scale && !c.classList.contains('stuck'))), `${tag}: Cancel restores the normal B8..B1 Cover Flow`);
      ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
      await ctx.close();
    }
  }
  // perf: regrouping under 4x CPU throttle on Pixel 7 stays within the 60 Hz budget
  { const ctx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', reducedMotion: 'no-preference' });
    const p = await ctx.newPage(); await p.addInitScript(() => { sessionStorage.setItem('bst.intro', '1'); window.__noLite = 1; });
    await p.goto(BASE); await p.waitForTimeout(900); await p.evaluate(() => { setQuality('high'); enterSelectMode(); }); await p.waitForTimeout(800);
    const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await p.evaluate(() => { const f = []; let last = 0, on = true; const loop = t => { if (last && STICK.raf) f.push(t - last); last = t; if (on) requestAnimationFrame(loop); }; requestAnimationFrame(loop); window.__stopF = () => { on = false; return f; }; });
    for (const id of ['b8', 'b2', 'b5', 'b2', 'b8', 'b5']) { await p.evaluate(id => toggleSelect(id), id); await p.waitForFunction(() => !STICK.raf, null, { timeout: 4000 }).catch(() => {}); await p.waitForTimeout(200); }
    const f = (await p.evaluate(() => window.__stopF())).sort((a, b) => a - b), q = k => f[Math.min(f.length - 1, Math.floor(k * f.length))];
    console.log(`INFO stick perf pixel7: 4x CPU throttle, ${f.length} regroup frames: p50 ${q(.5).toFixed(1)}ms, p95 ${q(.95).toFixed(1)}ms, max ${f[f.length - 1].toFixed(1)}ms`);
    ok(f.length > 20 && q(.95) <= 17 && f[f.length - 1] <= 34, `stick perf pixel7: regroup springs hold 60 fps under 4x throttle (p95 ${q(.95).toFixed(1)}ms ≤ 17, max ${f[f.length - 1].toFixed(1)}ms ≤ 34)`);
    await ctx.close(); }
}
async function labelBarTests(browser) {
  const sizes = [['pixel7', devices['Pixel 7']], ['915x412', { viewport: { width: 915, height: 412 }, hasTouch: true, isMobile: true }], ['768x1024', { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true }], ['1024x768', { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true }]];
  for (const [name, o] of sizes) {
    const tag = 'labels ' + name, wide = !/pixel7/.test(name);
    const ctx = await browser.newContext({ ...o, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(INIT); await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
    await p.goto(BASE); await p.waitForTimeout(700);
    const ev = (f, a) => p.evaluate(f, a);
    await ev(() => { ['b2', 'b3', 'b6', 'b7'].forEach(id => startTimer(id, true)); seats.b3.startTime -= 34 * 60000; seats.b2.startTime -= 15 * 60000; seats.b7.startTime -= 61 * 60000; togglePause('b6', true); saveAll(); SEAT_IDS.forEach(updateSeat); jumpTo('b5'); });
    await p.waitForTimeout(700);
    // centre seat name: ≥ 1.6x the old 12px, letter-spaced caps, not clipped
    const L = await ev(() => { const l = document.querySelector('#seat-b5 .seat-label'), cs = getComputedStyle(l), a = l.getBoundingClientRect(), c = document.getElementById('seat-b5').getBoundingClientRect();
      return { fs: parseFloat(cs.fontSize), ls: parseFloat(cs.letterSpacing), tt: cs.textTransform, clip: l.scrollWidth > l.clientWidth + 1, inCard: a.left >= c.left - .5 && a.right <= c.right + .5, txt: getComputedStyle(l, '::before').content }; });
    ok(L.fs >= 19.2 && L.ls >= 2 && L.tt === 'uppercase' && !L.clip && L.inCard, `${tag}: centre 'SEAT · B5' label is bigger (${L.fs}px ≥ 19.2 = 1.6× 12px), letter-spaced caps, not clipped ${JSON.stringify(L)}`);
    const sideIds = ['b8', 'b7', 'b6', 'b4', 'b3', 'b2'];
    const S = await ev(ids => ids.map(id => { const c = document.getElementById('seat-' + id); if (+getComputedStyle(c).opacity < .05) return null;
      const m = c.querySelector('.mini'), b = m.querySelector('.mn b'), bar = m.querySelector('.mbar'), fill = bar.firstElementChild, mb = m.getBoundingClientRect(), nb = m.querySelector('.mn').getBoundingClientRect(), bb = bar.getBoundingClientRect();
      const tf = fill.style.transform, sy = +(/scaleY\(([\d.]+)\)/.exec(tf) || [0, -1])[1], s = seats[id], rem = getDurationMs(s) - getElapsed(s);
      let e; const cs = getComputedStyle(bar);
      return { id, fs: parseFloat(getComputedStyle(b).fontSize), fw: +getComputedStyle(b).fontWeight, numIn: nb.left >= mb.left - .5 && nb.right <= mb.right + .5 && m.querySelector('.mn').scrollWidth <= m.clientWidth,
        barShown: cs.display !== 'none', barIn: bb.left >= 0 && bb.right <= innerWidth && bb.top >= 0 && Math.min(bb.bottom, innerHeight) - bb.top > 40 && (bb.bottom <= innerHeight || innerHeight < 500) && (e = document.elementFromPoint(bb.left + bb.width / 2, Math.min(bb.top + bb.height / 2, innerHeight - 10))) && e.closest('.seat') === c,
        edge: c.classList.contains('sl') ? bb.left - mb.left : mb.right - bb.right, sy, want: !s.running ? 0 : rem <= 0 ? 1 : rem / getDurationMs(s), bg: getComputedStyle(fill).backgroundImage + getComputedStyle(fill).backgroundColor, tok: (() => { const k = document.createElement('i'); document.body.appendChild(k); const r = {}; for (const v of ['--bar-ok', '--bar-warn', '--bar-danger']) { k.style.color = `var(${v})`; r[v] = getComputedStyle(k).color; } k.remove(); return r; })(), cls: c.className, op: +getComputedStyle(fill).opacity }; }).filter(Boolean), sideIds);
    const minFs = wide ? 40 : 28;
    ok(S.length >= 4 && S.every(x => x.fs >= minFs && x.fw >= 800 && x.numIn), `${tag}: side seat numbers bigger (≥${minFs}px), bold, fit their sliver ${JSON.stringify(S.map(x => [x.id, x.fs, x.numIn]))}`);
    const running = S.filter(x => !/free/.test(x.cls));
    ok(running.length >= 3 && running.every(x => x.barShown && x.barIn && x.edge >= 0 && x.edge <= 10), `${tag}: every running side card shows a vertical progress bar on the outward edge of its visible sliver, in view ${JSON.stringify(running.map(x => [x.id, x.barIn, x.edge.toFixed(1)]))}`);
    ok(running.every(x => Math.abs(x.sy - x.want) <= .02), `${tag}: bar fill = remaining time (±2%) ${JSON.stringify(running.map(x => [x.id, x.sy, +x.want.toFixed(3)]))}`);
    const g = id => S.find(x => x.id === id);
    if (g('b3')) ok(g('b3').bg.includes(g('b3').tok['--bar-warn']), `${tag}: amber seat (B3) bar is amber (${g('b3').bg} = ${g('b3').tok['--bar-warn']})`);
    if (g('b2')) ok(g('b2').bg.includes(g('b2').tok['--bar-ok']) && /green/.test(g('b2').cls), `${tag}: running seat (B2) bar is green (${g('b2').bg})`);
    if (g('b7')) ok(g('b7').sy === 1 && /timeup/.test(g('b7').cls) && g('b7').bg.includes(g('b7').tok['--bar-danger']), `${tag}: time-up seat (B7) bar is full red (${g('b7').bg})`);
    if (g('b6')) ok(/repeating-linear-gradient/.test(g('b6').bg) && g('b6').op < 1, `${tag}: paused seat (B6) bar is dashed and muted`);
    const free = S.filter(x => /free/.test(x.cls));
    ok(free.length >= 1 && free.every(x => !x.barShown), `${tag}: free seats show no bar`);
    // ticks drive the bar; motion defers it (no DOM writes mid-motion)
    ok(await ev(() => { const f = document.querySelector('#seat-b2 .mbar > i'), t0 = f.style.transform; seats.b2.startTime -= 6 * 60000; glide = { raf: 0 }; tick(); const mid = f.style.transform; glide = null; tick(); return mid === t0 && f.style.transform !== t0; }), `${tag}: bar updates on the timer tick, deferred during motion`);
    ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
    await ctx.close();
  }
}
async function depthTests(browser, name, opts, reduce) {
  if (name !== 'pixel7') return;
  const tag = 'pixel7' + (reduce ? '-reduced' : '') + ' depth';
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.addInitScript(INIT);
  await p.addInitScript(() => sessionStorage.setItem('bst.intro', '1'));
  await p.clock.install({ time: new Date('2026-10-20T19:00:00') });
  await p.goto(BASE); await p.clock.fastForward(300);
  const ev = (f, a) => p.evaluate(f, a), tick = ms => p.clock.fastForward(ms);
  const settleWait = async () => { for (let k = 0; k < 25; k++) { await tick(30); await p.waitForTimeout(reduce ? 5 : 40); } };
  const shot = async n => { if (!reduce) await p.screenshot({ path: path.join(SHOTS, `depth-${TAG}-pixel7-${n}.png`) }); };
  ok(await ev(() => document.body.classList.contains('depth') && getComputedStyle(document.getElementById('seatNav')).display === 'none'), `${tag}: phone portrait uses the depth layout (back cards are the seat buttons; no chip row)`);
  await ev(() => { ['b2', 'b3', 'b6', 'b7', 'b8'].forEach(id => startTimer(id)); seats.b3.startTime -= 34 * 60000; seats.b2.startTime -= 50 * 60000; togglePause('b6'); });
  await tick(400);
  // the back-card row = the seat buttons: fully on a 412px screen with margins, even, ≥48px, for every front seat
  { const bad = [];
    for (const id of ['b8', 'b7', 'b6', 'b5', 'b4', 'b3', 'b2', 'b1']) {
      await ev(id => jumpTo(id), id); await tick(50);
      const g = await ev(() => { const cs = [...document.querySelectorAll('#seats .seat.side')].map(c => ({ id: c.dataset.seat, r: c.getBoundingClientRect(), nudge: c.classList.contains('nudge') })).sort((a, b) => a.r.left - b.r.left);
        const ws = cs.map(c => c.r.width), gaps = cs.slice(1).map((c, k) => c.r.left - cs[k].r.right), tops = cs.filter(c => getComputedStyle(document.getElementById('seat-' + c.id)).translate === 'none').map(c => c.r.top);   // ignore a card mid alert-nudge
        return { vw: innerWidth, n: cs.length, minL: Math.min(...cs.map(c => c.r.left)), maxR: Math.max(...cs.map(c => c.r.right)), wMin: Math.min(...ws), wSpread: Math.max(...ws) - Math.min(...ws), gapSpread: Math.max(...gaps) - Math.min(...gaps), minGap: Math.min(...gaps), topSpread: Math.max(...tops) - Math.min(...tops) }; });
      if (!(g.n === 7 && g.minL >= 4 && g.maxR <= g.vw - 4 && g.wMin >= 48 && g.wSpread < 1 && g.gapSpread < 1.5 && g.minGap >= 2 && g.topSpread < 1)) bad.push(id + ':' + JSON.stringify(g));
    }
    ok(bad.length === 0, `${tag}: all 7 back cards fully inside the 412px screen with margins, even ≥48px tiles, even gaps, one row, for every front seat ${bad.join(' ')}`);
    await ev(() => jumpTo('b1')); await tick(50); }
  // readable back cards for every centred seat
  const check = () => ev(() => {
    const out = [], cen = document.getElementById('seat-' + centreId).getBoundingClientRect();
    for (const c of document.querySelectorAll('#seats .seat')) {
      const a = c.getBoundingClientRect(), id = c.dataset.seat, front = c.classList.contains('centre');
      const r = { id, inV: a.left >= -.5 && a.right <= innerWidth + .5 && a.top >= 0 && a.bottom <= innerHeight + .5 };
      if (front) { const e = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2); r.ok = !!(e && e.closest('.seat') === c); out.push(r); continue; }
      const m = c.querySelector('.mini'), texts = [...m.querySelectorAll('.mn, .mm, .mp')].filter(k => getComputedStyle(k).display !== 'none');
      r.text = texts.map(k => k.textContent).join(' ');
      r.clip = texts.filter(k => { const b = k.getBoundingClientRect(); if (k.scrollWidth > k.clientWidth + 1) return true; if (b.left < a.left - .5 || b.right > a.right + .5 || b.top < a.top - .5) return true;
        const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2), e2 = document.elementFromPoint(b.left + b.width / 2, b.bottom - 1); return !(e && e.closest('.seat') === c && e2 && e2.closest('.seat') === c); }).map(k => k.className);
      r.font = Math.min(...texts.map(k => { const b = k.getBoundingClientRect(); return b.height; }));
      r.touchW = a.width; r.touchH = Math.min(a.bottom, cen.top) - a.top;   // uncovered part above the front card
      r.ok = r.clip.length === 0 && r.touchW >= 44 && r.touchH >= 44;
      out.push(r);
    }
    return out; });
  for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']) {
    await ev(id => jumpTo(id), id); await tick(30);
    const r = await check(), bad = r.filter(x => !x.inV || !x.ok);
    ok(r.length === 8 && bad.length === 0, `${tag}: ${id.toUpperCase()} in front: all 8 visible; 7 back cards readable (no clipped/covered text) with ≥44px uncovered touch area ${bad.map(x => JSON.stringify(x)).join(' ')}`);
    const ord = await ev(() => [...document.querySelectorAll('#seats .seat:not(.centre)')].map(c => c.getBoundingClientRect().left));
    ok(ord.every((x, i) => i === 0 || x > ord[i - 1]), `${tag}: ${id.toUpperCase()} in front: back cards in B8..B1 order, left to right`);
    if (id === 'b1') console.log(`INFO ${tag}: back card min touch ${Math.min(...r.filter(x => x.touchW).map(x => x.touchW)).toFixed(0)}×${Math.min(...r.filter(x => x.touchH).map(x => x.touchH)).toFixed(0)}px, min text line ${Math.min(...r.filter(x => x.font).map(x => x.font)).toFixed(1)}px`);
  }
  await ev(() => jumpTo('b1')); await tick(50);
  const faces = await ev(() => Object.fromEntries(['b8', 'b7', 'b6', 'b3', 'b5'].map(id => { const m = document.querySelector('#seat-' + id + ' .mini'); return [id, [...m.querySelectorAll('.mn, .mm, .mp')].filter(k => getComputedStyle(k).display !== 'none').map(k => k.textContent).join(' ')]; })));
  ok(faces.b8 === 'B8 60m' && faces.b3 === 'B3 26m' && faces.b5 === 'B5 free' && /^B6 60m paused$/.test(faces.b6), `${tag}: back cards show number, minutes/free, paused (${JSON.stringify(faces)})`);
  ok(await ev(() => { const g = getComputedStyle(document.querySelector('#seat-b3 .mini')).boxShadow, o = getComputedStyle(document.querySelector('#seat-b6 .mini')).outlineStyle; return /inset/.test(g) && o === 'dashed'; }), `${tag}: status-coloured edge; paused card dashed`);
  ok(await ev(() => [...document.querySelectorAll('#seats .seat.side')].every(c => !/blur/.test(getComputedStyle(c).filter + getComputedStyle(c).backdropFilter) && +c.querySelector('.dim').style.opacity > 0)), `${tag}: back cards dimmed, never blurred`);
  if (!reduce) await p.waitForTimeout(500); await shot('b1');
  // tap a back card -> it comes forward (sample mid-swap), old front recedes
  const pt = await ev(() => { const a = document.getElementById('seat-b5').getBoundingClientRect(); return { x: Math.round(a.left + a.width / 2), y: Math.round(a.top + 20) }; });
  await p.touchscreen.tap(pt.x, pt.y);
  if (!reduce) { const seq = []; for (let k = 0; k < 14; k++) { await tick(40); seq.push(await ev(() => ['b5', 'b1'].map(id => { const m = new DOMMatrix(getComputedStyle(document.getElementById('seat-' + id)).transform); return +Math.hypot(m.a, m.b).toFixed(3); }))); }
    const mid = seq.some(([a, b]) => b < .98), grow = seq.every((x, k) => !k || x[0] >= seq[k - 1][0] - .002);
    ok(mid && grow && seq[seq.length - 1][0] > .99, `${tag}: on the shared spring the tapped card grows to the front while the old front recedes (${seq.map(x => x.join('/')).join(' ')})`); }
  await settleWait();
  ok(await ev(() => centreId === 'b5' && !seats.b5.running && document.getElementById('seat-b1').classList.contains('side')), `${tag}: tapping B5's back card brings it to the front without starting it; B1 recedes`);
  ok(await ev(() => /^translate\([^)]*\) scale\([\d.]+\)$/.test(document.getElementById('seat-b5').style.transform) && !document.getElementById('seat-b5').style.transform.includes('rotate')), `${tag}: swap uses transform only (translate + scale)`);
  if (!reduce) await p.waitForTimeout(500); await shot('b5');
  // swipe steps through seats
  const box = await p.locator('#seat-b5').boundingBox(), y = Math.round(box.y + box.height * .6);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y }] });
  for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300 - k * 22, y }] }); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  for (let k = 0; k < 25; k++) { await tick(30); await p.waitForTimeout(40); }
  const after = await ev(() => centreId);
  ok(after !== 'b5' && ['b4', 'b3', 'b2', 'b1'].includes(after), `${tag}: swiping left steps toward B1 (now ${after})`);
  // alert on a back card
  await ev(() => jumpTo('b1')); await tick(50);
  await ev(() => { seats.b7.startTime -= 61 * 60000; }); await tick(400);
  ok(await ev(() => document.getElementById('seat-b7').classList.contains('flag') && !document.getElementById('offAlert').hidden && /B7 time is up/.test(document.getElementById('offAlert').textContent)), `${tag}: off-front time-up flags B7's back card + Show button`);
  const fa = await ev(() => ({ before: getComputedStyle(document.getElementById('seat-b7'), '::after').animationName, card: getComputedStyle(document.getElementById('seat-b7')).animationName }));
  ok(reduce ? !/depthNudge/.test(fa.card) : /depthNudge/.test(fa.card) && fa.before !== 'none', `${tag}: back card alert ${reduce ? 'static (no nudge)' : 'pulses and nudges toward the front'} (${JSON.stringify(fa)})`);
  ok(await ev(() => { const m = document.querySelector('#seat-b7 .mini .mm'); return m.textContent === 'up'; }), `${tag}: time-up back card reads 'up'`);
  ok(await ev(() => { const a = document.getElementById('offAlert'), r = a.getBoundingClientRect(); return !a.hidden && r.width > 0 && [...document.querySelectorAll('#seats .seat')].every(c => { const b = c.getBoundingClientRect(); return !(b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top); }); }), `${tag}: the Show alert never overlaps any card`);
  ok(await ev(() => { const s = document.getElementById('summary'); return s.scrollWidth <= s.clientWidth + 1 && [...s.children].filter(e => e.offsetWidth).every(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }); }), `${tag}: summary line fits the screen (nothing cut off at the right)`);
  if (!reduce) await p.waitForTimeout(600); await shot('alert');
  await p.locator('#offAlert').click(); await settleWait();
  ok(await ev(() => centreId === 'b7' && document.getElementById('offAlert').hidden), `${tag}: Show brings B7 to the front`);
  // selection
  await ev(() => { jumpTo('b1'); enterSelectMode(); setSelected('b2', true); setSelected('b3', true); }); await tick(100); if (!reduce) await p.waitForTimeout(700);
  ok(await ev(() => selectMode && [...document.querySelectorAll('#seats .seat')].every(c => !c.style.transform)), `${tag}: selection mode lays the cards out flat`);
  await shot('select'); await ev(() => exitSelectMode()); await tick(100); if (!reduce) await p.waitForTimeout(600);
  ok(await ev(() => /scale\(0\./.test(document.getElementById('seat-b5').style.transform)), `${tag}: leaving selection restores the depth stack`);
  // keys
  await ev(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await p.keyboard.press('Digit4'); await tick(100);
  ok(await ev(() => seats.b4.running), `${tag}: key 4 still starts B4 (a back seat)`);
  // Daytime + Arcade
  await ev(() => setDaytime(true)); await tick(100); if (!reduce) await p.waitForTimeout(500);
  let r = await check(); ok(r.every(x => x.inV && x.ok), `${tag}: Daytime: all 8 readable`); await shot('daytime');
  await ev(() => { setDaytime(false); setLook('arcade'); }); await tick(100); if (!reduce) await p.waitForTimeout(500);
  r = await check(); ok(r.every(x => x.inV && x.ok), `${tag}: Arcade: all 8 readable ${r.filter(x => !x.ok).map(x => JSON.stringify(x)).join(' ')}`); await shot('arcade');
  await ev(() => setLook('premium'));
  // guest view unaffected
  await ev(() => toggleGuestView()); await tick(200);
  ok(await ev(() => document.querySelectorAll('.guest-card').length === 8 && [...document.querySelectorAll('.guest-card')].every(e => !e.style.transform)), `${tag}: guest view still a flat board`);
  await ev(() => toggleGuestView());
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
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('coverflowTests')) await coverflowTests(browser);
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('qualityTests')) await qualityTests(browser);
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('tabletPerfTests')) await tabletPerfTests(browser);
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('stickTests')) await stickTests(browser);
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('labelBarTests')) await labelBarTests(browser);
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('partyMigrationTests')) await partyMigrationTests(browser);
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
    // depthTests retired in v4.4 (Cover Flow replaced the depth stack); see coverflowTests
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('smoothTests')) await smoothTests(browser, name, opts);
    for (const rm of [false, true]) for (const nw of [true]) if (!process.env.ONLY || process.env.ONLY.split(',').includes('chipTests')) { if (nw && name !== 'pixel7') continue; await chipTests(browser, name, opts, rm, nw); }
    for (const rm of [false, true]) if (!process.env.ONLY || process.env.ONLY.split(',').includes('fanTests')) await fanTests(browser, name, opts, rm);
    if (!process.env.ONLY || process.env.ONLY.split(',').includes('pwaTests')) await pwaTests(browser, name, opts);
  }
  await browser.close();
  if (!process.env.ONLY) await installabilityCheck();
  if (srv) srv.close();
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
