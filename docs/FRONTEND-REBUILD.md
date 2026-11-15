# Frontend rebuild: one stage, live screens

Started 2026-11-15. Replaces the old "render a screen, throw the last one away"
runtime in `web/js/main.js` (with its kept covers, ghost outlines, cloned peeks
and rebuilds behind them) by a stage where screens stay alive.

Snapshot of the frontend before the rebuild: `git show refs/backup/before-frontend-rebuild`
(a stash commit of the working tree) and `~/.cache/rep-rebuild/web-before-rebuild-2026-11-15.tgz`.

## The model

- **Stage** (`web/js/stage.js`): `#main` is a fixed viewport. Every screen is a
  **pane**: `section.pane > div.pane__in > div.view`. The pane is its own
  vertical scroller, so every screen keeps its scroll position for as long as
  it lives, and nothing ever has to be restored.
- **Stacks**: each tab (`today`, `trends`, `workouts`, `ranks`, `settings`, and
  `bare` for sign-in/onboarding/landing) has a stack of panes. Opening a screen
  pushes a pane on the current tab's stack; back pops it, and the pane under it
  is the same live screen that was left, untouched. Tapping a tab shows that
  tab's stack as it was left (tapping the tab you are on pops to its first
  screen, then scrolls to the top).
- **History**: every entry carries `{ pid }`, the pane it shows. `popstate`
  finds that pane: below the top of its stack → pop to it; in another stack →
  switch tab; gone → build it fresh.
- **Hidden panes** stay in the DOM (`visibility:hidden; content-visibility:hidden; inert`),
  so returning is instant. Their ids are parked (`data-pid-id`) while hidden so
  `label for`/`getElementById` only ever find the visible screen.
- **Transitions** move real panes: push slides the new pane in from the right
  over the old one (which drifts left and dims), pop reverses it. A tab tap is
  instant. The back swipe drags the real top pane and shows the real pane
  under it; the tab swipe drags the real neighbouring tab (built on demand).
- **Pull to refresh** works on the active pane's scroller.

## The view contract (unchanged where possible)

`export default async function view(ctx)` with `ctx.root` to draw into, as
before, plus:

- `ctx.alive()` – the pane still exists and this run of the view is current.
- `ctx.onLeave(fn)` – the pane is destroyed (popped, replaced, signed out).
- `ctx.listen(type, fn)` – the app bus (`changed`, `sync`…); events that
  arrive while the pane is hidden are held (latest per type, `changed` lists
  merged) and delivered when it is shown again.
- `ctx.onShow(fn)` / `ctx.onHide(fn)` / `ctx.shown()`.
- `ctx.onRefresh(fn)` – pull to refresh.
- `ctx.scroller` – the pane's scroller (instead of `window` scroll).
- `ctx.setPath(path)` – the screen changed its own address in place
  (People's pages): history is replaced and the pane is re-keyed.

## Data

`web/js/api.js` keeps every GET (stale-while-revalidate, as before) and now
also writes it to IndexedDB per account, so a cold start draws every screen from
what it showed last (kept from earlier the same day only, so a "today" from
yesterday is never shown), then reads again behind it and redraws in place if
anything changed. A change (POST…) still forgets what is kept in memory, so a
screen never shows its own change undone. Signing out wipes both.

Screens stay alive, so most of the time nothing loads at all: going back, or to
another tab, shows the screen as it was left. Events that arrive while a screen
is hidden are held and given to it when it shows again; a screen hidden for
more than 30 seconds reads again quietly when it comes back.

Screens that were not loaded before draw a placeholder of the same shape as
what replaces it (see each view), and nothing below a placeholder can be
pushed down when it fills.

## Progress

- [x] stage.js: panes, stacks, history, transitions
- [x] gestures: back swipe, tab swipe, pull to refresh, Android back
- [x] api.js persistence
- [x] pager component (People, Awards, Routes)
- [x] views moved off window scroll / onto ctx.listen
- [x] old runtime removed (ghost.js, kept covers, motion.js gestures)
- [x] the other tabs' first screens built when the app is idle (stage.prebuild), so a first tap shows them whole
- [x] tests (2026-11-15, deployed as v326): desktop and phone Chrome, WebKit as an iPhone 15
  (browser and home-screen app), Chrome 133 on the Android 16 emulator (`-gpu guest`: its
  default SwiftShader renderer crashes the emulator itself on some pages, the old frontend too).
  Random-action stress runs (navigation, swipes, interrupted swipes, back during a landing,
  pull to refresh), a crawl of 90 kinds of screen, and layout-shift measurement on load and on
  moving between screens: zero shift on every screen.
