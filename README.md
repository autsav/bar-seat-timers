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
- Multi-select bulk actions, notes, session history with CSV export, guest-facing view, light/dark/high-contrast themes, optional manager PIN, and keyboard shortcuts (`1`–`8` start or select, `Shift`+`1`–`8` end, `R` reset all).

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
