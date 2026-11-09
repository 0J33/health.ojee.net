# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The same site is wrapped by an iPhone app, an Android app (Capacitor) and a desktop app (Electron), in `ojee-health-app`. Those wrappers add native features; the design language stays the site's own.

## Users

- **Primary (in-app):** ojee and a small, growing circle of friends with mixed devices (Fitbit Air, Pixel Watch, Garmin, Apple Watch, a bare phone). Not athletes, not patients: people who train a few times a week and want to know how they are doing, and how they are doing against each other. Phone first, a few seconds at a time, several times a day; occasionally a desktop browser.
- **Landing page visitor (confirmed 2026-11-09):** anyone, the public. A stranger who reaches rep.ojee.net knowing nothing about it. The landing must explain what rep. is from zero and get them into the web app or onto the tester list.

## Product Purpose

rep. turns what a person's wearables and phone already record (sleep, readiness, steps, heart, workouts, body, water) into a calm daily judgement: "is this good for me?". Success is a person opening it each morning and evening and knowing where they stand in seconds, and a group of friends keeping each other going.

## Positioning

- Works with whatever you wear: Fitbit and Pixel through Google Health, Garmin directly, Health Connect / Samsung Health on Android, or just a phone. Not tied to one watch brand.
- Its own recovery and readiness scores, computed in the app (`server/core/scores.js`), not copied from a device.
- Social by choice: a shared leaderboard with read-time privacy; sleep, heart and body stay private unless shared.
- The name: **rep.** — short for **repair** (recovery), **repetition** (the habit, the reps) and **reputation** (standing among friends). The user wants this explained on the landing.

## Operating Context

- Live at https://rep.ojee.net (moved from health.ojee.net, which redirects). Signed-out browser visitors at `/` see the landing view (`web/js/views/landing.js`); native app users go straight to sign-in.
- Accounts: `/register` and `/signin` (shared login with the owner's other sites). **Registration is open to anyone (confirmed 2026-11-09).**
- Phone and desktop apps are in testing, not in the App Store or Play Store yet. Testers are added by hand: the landing's way to ask is email, `contact@ojee.net`.
- Native-only features (for honest claims): home and lock screen widgets (iOS and Android), icon changer, live heart rate over Bluetooth, background route recording, Android Quick Settings tile and Health Connect, desktop tray with today's numbers and live heart rate.

## Capabilities and Constraints

- Plain HTML/CSS/ES modules, no build step, no framework, no animation libraries. Strict CSP: fonts and scripts from this origin only, so no CDNs and no Google Fonts.
- Fonts self-hosted: Instrument Sans (400–700, width 75–100%), Newsreader (400–600).
- Icons: one line family in `web/js/lines.js` via `ic(name)`.
- Reduced motion must be honoured everywhere.
- The service worker precaches the shell (`web/sw.js` SHELL list); bump `VERSION` when shell files change.

## Brand Commitments

- Name: **rep.** — lowercase, always with its full stop.
- Rebrand (2026-11-09, approved by the owner from a prototype he liked): a mark of **three standing plates**; the single **gold plate** (`#E7B653` with darker ring `#D29F41`, `web/favicon.svg`) as favicon, tray and small mark; off-black `#1A1815` / `#0A0908`; bone `#F2EDE5`. Wordmark paths in `web/rep-mark.svg`. 32 app-icon variants in `web/app-icons/`.
- Tagline in use: "Build your rep."
- Voice: calm, exact, a little dry. A good instrument, not a coach. No cheering, no medical claims, no fake precision.

## Evidence on Hand

- The real product UI (Today, sleep, readiness, steps, leaderboard, widgets) can be shown, built from the app's own components and sample numbers labelled as samples.
- No testimonials, no user counts, no press, no store ratings, no store badges (not in the stores yet). Never fabricate any of these.
- No product photography.

## Product Principles

1. Answer "is this good for me?" before it is asked.
2. Whatever you wear: never pretend one device is required.
3. Private by default, social by choice.
4. Honest about the data: say when there is too little.
5. Calm over loud.

## Accessibility & Inclusion

Reduced motion honoured; text contrast at least WCAG AA; everything reachable by keyboard.
