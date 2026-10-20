# Bar Seat Timers

Timers for the 8 walk-in bar seats (B1–B8). Each seat runs a session that turns green → amber → red as its limit
approaches, with sound, vibration and optional system notifications.

**Live:** https://autsav.github.io/bar-seat-timers/

## Features
- **One walk-in limit:** every seat uses the same session limit (60 min by default, editable in Settings). Amber and red come in at 50 % and 75 % of the limit by default. Each seat locks its limit when it starts, so changing settings never retimes seats that are already running. History and the CSV record each session's limit.
- **Undo:** End, Reset Selected, Reset All and Shift+1–8 show an 8-second **Undo** bar. End sits on its own row, away from +15.
- **Stays awake:** uses the Screen Wake Lock API while any seat is running (toggle in Settings), and re-acquires it when you come back to the tab.
- **Missed alerts:** if the phone slept or the tab was hidden, the amber, red and time-up alerts you missed are caught up and summarised when you return.
- **Install / offline:** an installable PWA (manifest, icons, versioned service worker). Use **Menu → Install app**, or Chrome's "Install app" / "Add to Home screen". It works offline after the first visit.
- **Selecting seats (no checkboxes):** tap a free seat to start it straight away (Undo appears for 8 s). To act on several seats, **long-press** any seat or tap **☑ Select**. In selection mode, tap seats to toggle them (tinted with a ✓ and a short vibration), or **drag across** seats to select several in one move. The bottom bar shows the count with **Start / Pause / +15 / End / Cancel**. Running an action, **Cancel**, **Done**, **Esc** or the phone's **Back** button exits the mode. Seat labels (B1…) are buttons that work with a keyboard or screen reader (`aria-pressed`), and the selected count is announced.
- Bulk actions, notes, session history with CSV export, guest-facing view, light/dark/high-contrast themes, optional manager PIN, and keyboard shortcuts (`1`–`8` start a free seat or select a running one, `Shift`+`1`–`8` end, `R` reset all).

## Privacy
- Everything (seats, notes, history, settings) is stored **only in this browser's local storage on this device**. Nothing is sent to a server, and there's no analytics or tracking. The page is static, hosted on GitHub Pages.
- **Don't put personal data in notes** (guest names, phone numbers, allergies tied to a person). The device is likely shared behind the bar, and notes end up in the CSV export.
- Clearing the browser's site data, or uninstalling the app, deletes all history. Export the CSV if you need a record.

## Limitations
- A web page can't run timers while the phone is fully asleep. Alerts you miss are shown when you return, so keep the screen on (wake lock) during service.
- Data isn't synced between devices.

## Development
Single `index.html`, plus `sw.js`, `manifest.webmanifest` and `icons/`. No build step.

Tests (Playwright, desktop + Pixel 7 emulation):
```
cd tests && npm install
node run.js                                          # serves the repo locally and tests it
node run.js https://autsav.github.io/bar-seat-timers/  # tests the live site
node audit.js <url>                                  # quick smoke audit
```
Set `CHROME_PATH` if Chrome isn't at `/usr/bin/google-chrome`. Bump `VERSION` in `sw.js` on each release.

## Motion (v3.3.0)
Progress rings (pure `transform` half-arcs), gradual green→amber→red ring colour, amber breathing glow, red pulse, time-up shake + glow,
paused stripes/dim, tap ripple + ring sweep, long-press fill ring, selection shrink + tick pop + drag highlight, +15 float with ring wind-back,
End folds toward the menu (Undo unfolds), undo countdown bar, spring action bar with rolling count, sliding sheets, staggered entrance,
rolling summary numbers, sliding "While away" banner, guest-view flip digits and a wave when a seat frees.
All motion is decorative (Web Animations / CSS on transform + opacity only), runs after state changes, and is fully disabled under
`prefers-reduced-motion: reduce`. Timing and alerts never depend on it (tests pause every animation and check alerts still fire).

## Cinematic layer (v3.4.0)
Charcoal bar backdrop with warm overhead light + vignette, mood that drifts amber → blue across a 17:00–01:00 shift, neon ring bloom,
3D press tilt, skippable 1.5 s "BAR OPEN" intro (never blocks taps), "SEAT N · GO" / "BAR FULL!" banners, "TIME!" stamp + subtle screen shake,
scoreboard digits, sparks on free + confetti when full, staff-board wave, snackbar slide-out, WebAudio sound effects (start, +15, warning, time up)
with vibration and a Menu → Sound toggle (synced with Settings → Mute), and a cinematic guest view (flip-board tiles, film grain, slow drift).
All of it is skipped under prefers-reduced-motion, and none of it gates timers or alerts.

## Bar row layout (v3.5.0)
The staff board is one horizontal, scroll-snapping row in physical bar order B8 … B1 (B1 on the right; the page opens scrolled to B1).
A B8…B1 indicator above the row shows each seat's status (running / amber / red / time-up / paused) and which seats are off-screen; tap to jump.
When a seat turns amber, red or time-up while off-screen, its indicator pulses and a "⚠ Bn … · Show ›" button scrolls to it.
Outside selection mode swipes scroll; in selection mode a horizontal drag selects, auto-scrolling near the edges. Keys 1–8 still mean B1–B8.

## Cover Flow (v3.6.0)
The staff row is a Cover Flow carousel (B8 … B1, opens with B1 centred). Side covers rotate ~45°, scale ~0.85, sit back and dim,
interpolated continuously from the scroll position; the row glides to the nearest seat when scrolling stops. Only the centred card's
controls act; tapping a side card centres it. Selection mode flattens the strip; reduced motion keeps it flat (no 3D).

## Premium look (default) / Arcade
Settings → **Look** switches between **Premium** (default) and **Arcade** (the original game look). The choice is saved with your settings.

What Premium changes:
- **Cards and backdrop:** frosted-glass cards with layered shadows, on a textured slate backdrop.
- **Colours:** champagne-gold accent, with emerald, amber and wine-red status colours.
- **Ring:** a gradient ring with a bright leading dot.
- **Type:** Inter (bundled, SIL OFL 1.1, `fonts/`), with thin tabular digits and letter-spaced `SEAT · B3` labels.
- **Motion:** slower easing with no overshoot.
- **Effects:**
  - A golden shimmer instead of confetti and sparks.
  - A soft "Time" badge instead of the TIME! stamp.
  - An occasional sheen across the centre card.
- **Sound and touch:** warmer chimes and crisp haptics.
- **Icons:** line icons instead of emoji.
- **Intro:** a logo reveal.
- **Sheets and menus:** Settings and History open as glass bottom sheets with a scrim behind them.

Cover Flow, alerts, selection, reduced motion, high contrast and the guest view all work in both looks.

## Fan (v3.8): all eight seats on screen
- **Layout:** the Cover Flow is now a compressed fan. The centre seat is large and raised, with a spotlight behind it. All other seats are visible at once as overlapping, steeply tilted (≈55°) side cards that scale down and dim by distance. Order is B8 (left) to B1 (right), with B1 centred on load.
- **Side cards:** each shows a compact face (bold seat number, status dot and edge, minutes left).
- **Strip widths:**
  - When there is room (desktop) each side card shows about 30% of its width.
  - On a 412 px phone the strips narrow to fit, so all eight stay on screen (about 10–25 px each, depending on which seat is centred).
- **Navigation:** swipe, the settle (with a soft click) and tap-a-strip-to-centre all work. Only the centre card's controls act. The pill strip is gone.
- **Off-centre alerts:**
  - The Show button stays.
  - The side card gets a stronger status ring.
  - A time-up seat nudges toward the centre.
- **Settings:** **Daytime** (a light Premium variant) and **Gentle tilt with phone motion** (DeviceOrientation). Permission is requested only where the browser requires it, and tilt fails quietly with a short note otherwise.
- **Colour:** a navy-to-charcoal backdrop, and status colours that glow onto neighbouring cards. Statuses differ in brightness as well as hue.
- **Time display:** huge, light time on the centre card that gets heavier near expiry, with no layout shift.
- **Reduced motion:** a flat fan, with no tilt, gyro or nudge.

## Chips + smoothness (v3.9)
- **Chip row on narrow phones (<600px):** under the fan sit 8 seat chips, B8 to B1, each 48px tall. Each chip shows the seat number plus minutes left, "free" or "up", in its status colour (time-up is filled red, paused is dashed). The centred seat's chip is highlighted.
  - Tapping a chip centres that seat; in selection mode it selects instead.
  - Off-centre alerts pulse the chip, and the Show button stays.
  - On the phone, side cards become clean status-edged peeks with no squeezed text. Wide screens keep the full fan without chips.
- **Smoothness:**
  - No per-card backdrop blur. Cards are solid and promoted to their own compositor layers (`will-change: transform`).
  - Fan geometry is measured once and cached, so per-frame updates read no layout.
  - The settle is a critically damped spring (~380ms, no overshoot in Premium). Native scrolling still provides the finger-tracking and flick momentum.
  - Ambient loops and reflections pause while the fan moves.
- **Smooth mode:** if motion frames run slow on a device (p75 over 26ms in two separate movements), heavy decoration switches off automatically and stays off on that device. It is stored in `localStorage` as `bst.lite`.
- **Perf probe:** `node tests/perf.js [url]` runs Pixel 7 emulation at 4x CPU throttle and reports rAF frame stats plus DevTools metrics for a swipe, tap-to-front, and idle.

## Depth stack (v4.0): phone portrait
- **Layout (360–599px wide):** the centre seat is a large card in front. The other 7 seats are smaller cards behind it, slightly dimmed (never blurred), raised in a shallow arc. They run B8..B1 left to right.
- **Back cards:** each one's top peeks out above the front card and shows the seat number, minutes left (or free/up), a status-coloured edge and dot, and a dashed "paused" state. Each has at least a 52×60px tap area.
- **Tap a back card:** it swaps to the front. The cards animate from their old poses to the new ones (FLIP, transform and opacity only): the tapped card grows forward while the old front recedes into its slot.
- **Swipe:** still steps through seats, with the same continuous pose blend.
- **Alerts:** a time-up back card pulses and nudges down toward the front, and the Show button stays.
- **Narrower screens:** below 360px, the chip row returns as a fallback. Wider screens keep the fan.

## One motion source (v4.1)

Real-device feedback on v4.0 was that the depth stack felt clunky. Root cause: the stack was a native horizontal
scroller (compositor thread) while every card transform was written from scroll events on the main thread, so on
Android the cards lagged the finger by a frame or more and the JS settle fought the native fling.

Now there is no native scrolling outside selection mode:

- `#seats` is `overflow: hidden; touch-action: pan-y` (vertical page scroll still works). Its `scrollLeft` is a
  virtual float position; the real scroll position stays 0.
- Pointer events drive that position 1:1 with the finger (8px slop, soft edges); one rAF per frame writes only
  `transform` (cards) and `opacity` (dim/mini layers).
- Release, tap-to-front and the Show alert all use the same critically damped spring, with the flick's velocity
  projected to pick the target seat.
- During motion: no layout reads, no class toggles (card roles, tint, spotlight change at rest), no timer DOM
  updates (deferred until the spring settles), at most one tick sound per seat passed and none in a fast flick.
- Moving cards have no transitions, box-shadow, filter, reflection, or `scale`/`rotate` properties (those would
  multiply the JS transform); alert shake/nudge use `translate` only.
- Settings → "Show performance meter" shows live fps and the worst frame of the last second.

Back-card row polish: the 7 back cards are the seat buttons, laid out as one flat, even row fitted to the visible
screen width with 10px margins (≥48px tiles on a 412px phone). The off-front alert ("Show") sits in the summary line,
so it never covers a card, and the summary line wraps instead of being cut off. No extra chip row above 360px.

## Depth stack everywhere (v4.2)

Tablets (portrait and landscape), landscape phones and desktop now use the same depth stack as phones: the
front card is capped (440px from 600px, 460px from 1000px) and centred. The 7 back-card seat buttons form one even
row centred on screen, with 24px margins and 12px gaps on wide screens. Tiles are up to 136px wide and their text
scales with them, up to 1.7×. The stack's top padding follows the measured tile height, and short landscape screens
drop the card's minimum height. `tabletTests` checks 768×1024, 1024×768, 800×1280, 1280×800, 1366×1024, 1024×1366,
915×412, 412×915 and 1440×900.
