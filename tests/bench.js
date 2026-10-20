// Frame-time bench: Pixel 7 emulation, 4x CPU throttle; rAF deltas tagged by phase (drag / settle / rest)
const { chromium, devices } = require('playwright-core');
const URL = process.argv[2] || 'http://localhost:8123/';
(async () => {

  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...(process.env.VP ? { viewport: { width: +process.env.VP.split('x')[0], height: +process.env.VP.split('x')[1] }, hasTouch: true, isMobile: true } : devices['Pixel 7']), serviceWorkers: 'block', reducedMotion: 'no-preference' });
  const p = await ctx.newPage();
  await p.addInitScript(() => { sessionStorage.setItem('bst.intro', '1'); window.__noLite = 1; });
  await p.goto(URL); await p.waitForTimeout(1200);
  await p.evaluate(() => { try { if (window.setQuality) setQuality(new URLSearchParams(location.search).get('q') || 'high'); } catch (e) {} ['b2', 'b3', 'b5', 'b6', 'b7'].forEach(id => startTimer(id, true)); seats.b7.startTime -= 61 * 60000; jumpTo('b1'); });
  await p.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.evaluate(() => { const f = []; let last = 0, on = true; let gs = 0, wasG = false, ge = 0; const loop = t => { const g = !!glide; if (g && !wasG) gs = t; if (!g && wasG) ge = t; wasG = g; if (last) f.push([t - last, window.__phase || 'rest', Math.round(t - gs), Math.round(t - ge), !!(drag && drag.on)]); last = t; if (on) requestAnimationFrame(loop); }; requestAnimationFrame(loop); window.__stopF = () => { on = false; return f; }; });
  const box = await p.locator('#seats').boundingBox(), y = Math.round(box.y + box.height * .45);
  for (let r = 0; r < 3; r++) {
    const dir = r % 2 ? -1 : 1, x0 = dir > 0 ? 80 : 330;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let k = 1; k <= 40; k++) { if (k === 4) await p.evaluate(() => window.__phase = 'drag'); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dir * k * 6, y }] }); await p.waitForTimeout(16); }
    await p.evaluate(() => window.__phase = 'settle');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForFunction(() => !inMotion(), null, { timeout: 5000 }).catch(() => {});
    await p.evaluate(() => window.__phase = 'rest'); await p.waitForTimeout(500);
  }
  for (const id of ['b6', 'b2', 'b8']) { await p.evaluate(id => { window.__phase = 'settle'; jumpTo(id, true); }, id); await p.waitForFunction(() => !inMotion(), null, { timeout: 5000 }).catch(() => {}); await p.evaluate(() => window.__phase = 'rest'); await p.waitForTimeout(500); }
  const f = await p.evaluate(() => window.__stopF());
  const st = ph => { const a = f.filter(x => ph === 'all' || x[1] === ph).map(x => x[0]).sort((a, b) => a - b), q = k => a[Math.min(a.length - 1, Math.floor(k * a.length))] || 0; return `${ph}: n=${a.length} p50 ${q(.5).toFixed(1)} p95 ${q(.95).toFixed(1)} max ${(a[a.length - 1] || 0).toFixed(1)} dropped(>17.5): ${a.filter(x => x > 17.5).length} >33.4: ${a.filter(x => x > 33.5).length}`; };

  for (const ph of ['drag', 'settle', 'rest', 'all']) console.log(st(ph));
  await browser.close();
})();
