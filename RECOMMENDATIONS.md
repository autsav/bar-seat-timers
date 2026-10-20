# Bar Seat Timers: audit and recommendations

Audit date: 20 Oct 2026. Commit `6a179c6` (local matches live byte for byte). Analysis only, no code changed.

## Test results
- Updated smoke test (`/workspace/bst-test/audit.js`), local and live, on desktop 1366×900 and Pixel 7: **all pass** (HTTP 200; start, pause hold, resume, +15, multi-select start through the floating action bar; no console errors).
- The older `test.js` no longer runs: it targets `.name-input` and the Start/Pause button layout, both removed in the redesign. It needs rewriting for the current UI.
- Evidence screenshots: `/workspace/bar-seat-timers-shots/audit-desktop.png`, `audit-pixel7.png`.
- Not present: `<link rel="manifest">` (`/manifest.json` returns 404), a service worker, Wake Lock, a `visibilitychange` handler, or a LICENSE file.

Effort: S = under 1 hour, M = half a day, L = 1 day or more.

---

## 1. Fix now

### R1. One tap on ⏹ End wipes a live seat, with no confirmation or undo. Effort: S. Impact: High
- **Problem / evidence:** `resetSeat()` only checks the PIN, and the PIN is blank by default. The test showed 0 dialogs on End. End sits right next to +15 (Pixel 7 screenshot), so a wet thumb can hit it by mistake. Shift+1–8 also resets without asking. The session goes straight into history and the timer is lost.
- **Upgrade:** Show an "Ended B2 · Undo" bar for 8 seconds that restores the seat state from before the end. Alternatively, use press-and-hold on End. Separate End from +15 (put it in its own row or on the far edge), and make Shift+digit ask for confirmation.

### R2. Only one session length, but the venue runs 60 min for walk-ins and 90 min for reservations. Effort: S–M. Impact: High
- **Problem / evidence:** `settings.durationMin` is global. Changing it to 90 for one booking retimes **every** running seat, including walk-ins already seated, because `getDurationMs()` reads the global value live.
- **Upgrade:** Save `limitMin` on each seat when the session starts. Make the primary button offer "Walk-in 60" and "Booking 90" (or switch types with a long press), show the type badge on the card, and record it in history and the CSV. Keep the amber and red thresholds relative to the limit (for example amber at 15 min left) rather than fixed minutes.

### R3. Alerts don't fire when the tab is in the background or the phone sleeps, and the screen sleeps during service. Effort: M. Impact: High
- **Problem / evidence:** Alerts run only from `setInterval(tick, 250)`. Chrome slows background timers to about once a minute, and a sleeping or frozen Android tab doesn't run them at all. There's no Wake Lock, so a Pixel behind the bar dims after about 30 s. The timers themselves stay **accurate**, because they're worked out from `Date.now()` and the test confirmed pause and resume after time jumps. Only the *alerts* get lost.
- **Upgrade:** Request `navigator.wakeLock.request('screen')` while any seat is running, and request it again on `visibilitychange`. On `visibilitychange` and `focus`, run `tick()` straight away and show any alerts that were missed. When installed as a PWA, schedule notifications through the service worker (`showNotification`, with `TimestampTrigger` where it's available). Say clearly in the UI that alerts need the screen on.

## 2. Service-floor UX

### R4. You can't see all 8 seats at a glance on a phone. Effort: M. Impact: High
- **Problem / evidence:** The Pixel 7 portrait view stacks the seats in 4 rows of 2, so you have to scroll to see B5 to B8. Each free card spends space on a notes box and a "60 min session" line. The summary chips spill over the edge ("Amber" is cut off). The floating selection bar covers B3 and B4.
- **Upgrade:** Add a compact "service" layout that fits all 8 seats on one screen without scrolling, in portrait or landscape. Show big remaining-time digits and a colour fill, hide notes behind a tap, and lay the seats out like the real bar counter (B1 to B8 in a row in landscape). Dock the action bar at the bottom and leave room for it, and make the summary chips scroll sideways or shrink to "2/8 · next B3 12:04".

### R5. Getting through service one-handed with wet hands. Effort: S. Impact: Medium
- **Problem / evidence:** Selection depends on small "Select" checkboxes (20 px) at the top of each card, away from your thumb. Primary actions use a 44 px tap target, which is the minimum, not generous.
- **Upgrade:** Make the whole card the tap target (tap to start, pause or resume, long press to select). Use 56 px or larger buttons in the bottom half of each card. Add a "large buttons" setting and haptic feedback (`navigator.vibrate(20)`) on every action.

### R6. Accessibility gaps. Effort: S. Impact: Medium
- **Evidence:** The redesign added good semantics (`role=status`, `aria-live`, labelled progress bars, text and icons alongside colour). But all eight `.badge` elements carry `role="status"` and the summary also has `role=status`, so screen readers get flooded with updates every 250 ms. Warnings use `alert()`, `confirm()` and `prompt()` for the PIN, and those prompts are clumsy on Android and block the timers.
- **Upgrade:** Keep a single polite live region for state changes only, remove `role=status` from the per-seat badges, replace the native dialogs with an in-page sheet, and honour `prefers-reduced-motion` for the pulsing and glow effects.

## 3. Multi-device / sync

### R7. All data lives in one browser's localStorage with no backup. Effort: S. Impact: High
- **Problem / evidence:** Seats, history and settings are stored as a single key, `barSeatTimers.v2` (about 2 KB). Clearing site data, using private mode, uninstalling the PWA or switching phones loses everything. `saveAll()` ignores errors silently, and history grows forever.
- **Upgrade:** Add Export/Import of a full JSON backup in settings, plus a warning banner when storage isn't available. Call `navigator.storage.persist()`. Cap history (for example 90 days) and offer an automatic CSV at the end of each shift.

### R8. Two devices (bar tablet and manager phone) never agree. Effort: S for the same device, L for cross-device. Impact: Medium–High
- **Problem / evidence:** There's no `storage` event listener, so even two tabs on the same phone overwrite each other's state (whoever saves last wins). Different devices share nothing at all.
- **Upgrade:** Step 1 (S): listen for `storage` or a `BroadcastChannel`, then reload state and merge it seat by seat using an `updatedAt` stamp. Step 2 (L): add an optional shared backend so one bar tablet stays in charge and other screens follow it read-only. Firebase or Supabase realtime would fit, behind a venue code and PIN. This needs a privacy decision (see R10).

## 4. Insights

### R9. History is stored but doesn't say much. Effort: M. Impact: Medium
- **Evidence:** The analytics show only the total count and the average duration. The CSV has seat, duration, extensions, start, end and auto-end, but no session type, and nothing shows how many sessions ran over time.
- **Upgrade:** Add per-shift stats: turns per seat, average time against the limit, and the percentage that overran or were extended, split by walk-in or booking (once R2 is in). Add a busiest-hours chart, and filter the CSV by date or shift. That would show whether 60 minutes is realistic at the bar.

## 5. Repo and PWA

### R10. It isn't installable and doesn't work offline, and the README and privacy notes are thin. Effort: S. Impact: Medium
- **Evidence:** There's no manifest (`/manifest.json` returns 404) and no service worker, so Chrome on the Pixel offers only a bookmark, not "Install app", and the page won't load without signal (basement or cellar Wi-Fi). The README doesn't mention installing, data storage or privacy. The **notes field may hold guest details** (names, allergies) in plain text on a shared device, and that goes into the CSV, which raises UK GDPR questions if exported.
- **Upgrade:** Add `manifest.webmanifest` (name, icons at 192 and 512, `display: standalone`, landscape) and a small cache-first service worker. Add a note under the notes field: "don't enter personal data". Add a README section on install, data and privacy.

### R11. Repo hygiene. Effort: S. Impact: Low–Medium
- **Evidence:** No LICENSE (`licenseInfo: null`), no topics, no homepage URL set on the repo, and tests live outside the repo in `/workspace/bst-test` and are out of date (they fail on `.name-input`). The README still describes a "guest names" feature that was removed.
- **Upgrade:** Add a licence (MIT, or "All rights reserved" if it's private to the venue), set the homepage to the Pages URL and add topics. Move a fixed Playwright test into `tests/` with a GitHub Action that runs on each push, and update the README and add a CHANGELOG.

---

## Suggested order
R1 → R2 → R3 (Wake Lock part) → R10 (PWA) → R4 → R7 → R5 → R8 step 1 → R6 → R9 → R11 → R8 step 2.
The first four make it safe and dependable for a real service, and together come to about one day of work.
