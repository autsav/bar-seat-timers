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
