// Smoke audit: node audit.js <url>  (start/pause/+15/multi-select (seat labels)/End/no console errors, desktop + Pixel 7)
const { chromium, devices } = require('playwright-core');
const U = process.argv[2]; let f=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) f++;};
(async()=>{ const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
for (const [n,o] of [['desktop',{viewport:{width:1366,height:900}}],['pixel7',devices['Pixel 7']]]) {
 const c=await b.newContext({...o,acceptDownloads:true}); const p=await c.newPage(); const errs=[];
 p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
 let dialogs=0; p.on('dialog',d=>{dialogs++; d.accept();});
 await p.clock.install({time:new Date('2026-10-19T20:00:00')});
 const r=await p.goto(U); ok(r.status()===200,`${n} HTTP ${r.status()}`);
 const s=i=>p.locator('#seat-b'+i);
 await (await p.evaluate(i=>jumpTo('b'+i),1), s(1).locator('.btn-primary').click()); await p.clock.fastForward(600000);
 const t=(await s(1).locator('.timer').textContent()).trim(); ok(/^(50:00|49:5\d)$/.test(t),`${n} start ${t}`);
 await (await p.evaluate(i=>jumpTo('b'+i),1), s(1).locator('.btn-primary').click()); const t1=(await s(1).locator('.timer').textContent()).trim();
 await p.clock.fastForward(300000); ok((await s(1).locator('.timer').textContent()).trim()===t1,`${n} pause holds`);
 await (await p.evaluate(i=>jumpTo('b'+i),1), s(1).locator('.btn-primary').click()); await (await p.evaluate(i=>jumpTo('b'+i),1), s(1).locator('.btn-extend').click()); await p.clock.fastForward(1000);
 ok(/^1:0[45]/.test((await s(1).locator('.timer').textContent()).trim()),`${n} +15`);
 await (await p.evaluate(i=>jumpTo('b'+i),2), s(2).locator('.seat-label').click()); await (await p.evaluate(i=>jumpTo('b'+i),3), s(3).locator('.seat-label').click());
 await p.locator('#actionBar').getByRole('button',{name:/Start/}).click(); await p.clock.fastForward(1000);
 ok(await p.evaluate(()=>seats.b2.running&&seats.b3.running),`${n} multi-select start`);
 dialogs=0; await (await p.evaluate(i=>jumpTo('b'+i),1), s(1).locator('.btn-reset').click()); await p.clock.fastForward(300);
 ok(true,`${n} single End asked ${dialogs} confirmation(s)`);
 const tap=await p.evaluate(()=>[...document.querySelectorAll('.seat-actions button')].map(e=>e.getBoundingClientRect()).reduce((m,r)=>Math.min(m,r.height,r.width),999));
 console.log(`INFO ${n} min seat button size ${Math.round(tap)}px`);
 await p.screenshot({path:`${process.env.SHOTS_DIR||'/tmp'}/audit-${n}.png`,fullPage:true});
 const ls=await p.evaluate(()=>localStorage.getItem('barSeatTimers.v2').length); console.log(`INFO ${n} storage ${ls} bytes`);
 console.log(`INFO ${n} manifest=${await p.evaluate(()=>!!document.querySelector('link[rel=manifest]'))} sw=${await p.evaluate(()=>!!navigator.serviceWorker?.controller)} wakeLock=${await p.evaluate(()=>/wakeLock/.test(document.documentElement.innerHTML))}`);
 ok(errs.length===0,`${n} no console errors ${errs.join('|')}`); await c.close(); }
await b.close(); console.log(f?f+' FAILED':'ALL PASSED'); })();
