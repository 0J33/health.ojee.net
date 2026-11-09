---
name: rep.
description: Sleep, health and training from whatever you wear, read like a good instrument.
colors:
  off-black: "#0A0908"
  bone: "#F2EDE5"
  bone-2: "#D6CFC4"
  dim-dark: "#A39B90"
  surface-dark: "#171513"
  surface-2-dark: "#24211E"
  line-dark: "#2A2622"
  hair: "rgba(242, 237, 229, 0.12)"
  gold: "#E7B653"
  gold-ring: "#D29F41"
  gold-hover: "#F0C266"
  silver: "#CBD1DC"
  silver-ring: "#B3BBC8"
  bronze: "#C98352"
  bronze-ring: "#AF6D41"
  on-metal: "#1A1815"
  sleep-blue: "#A9BEFF"
  sleep-tile-dark: "#1E3368"
  steps-mark-dark: "#F0C35A"
  steps-tile-dark: "#4B3810"
  energy-dark: "#FF9466"
  recovery-dark: "#F0A845"
  jade: "#74C3A1"
  paper-surface: "#FFFDF9"
  paper-inset: "#E9E3D8"
  paper-line: "#E4DDD1"
  ink: "#1D1A16"
  ink-2: "#3D3832"
  dim-light: "#6B6359"
  sleep-navy: "#2E4A80"
typography:
  display:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(3.5rem, 7.4vw, 6rem)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  room-word:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(3.25rem, min(13.4vw, 15vh + 6vw), 11.5rem)"
    fontWeight: 650
    lineHeight: 0.9
    letterSpacing: "-0.028em"
  headline:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(1.9rem, 3.6vw, 3rem)"
    fontWeight: 650
    lineHeight: 1.06
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 650
    lineHeight: 1.06
    letterSpacing: "-0.03em"
  spoken:
    fontFamily: "Newsreader, Georgia, Times New Roman, serif"
    fontSize: "1.375rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body-lead:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(1.0625rem, 1.5vw, 1.1875rem)"
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  caption:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "0.71875rem"
    fontWeight: 600
    fontFeature: "\"tnum\""
  number-hero:
    fontFamily: "Instrument Sans, system-ui, -apple-system, sans-serif"
    fontSize: "3.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
    fontFeature: "\"tnum\", \"lnum\""
    fontVariation: "\"wdth\" 88"
rounded:
  s: "10px"
  m: "14px"
  l: "24px"
  fragment: "28px"
  card: "36px"
  room: "clamp(26px, 3.6vw, 44px)"
  full: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "20px"
  s-6: "24px"
  s-7: "32px"
  s-8: "44px"
  gutter: "clamp(20px, 5vw, 56px)"
components:
  button-gold:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.on-metal}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: "0 clamp(18px, 4.6vw, 24px)"
    height: "50px"
  button-gold-hover:
    backgroundColor: "{colors.gold-hover}"
    textColor: "{colors.on-metal}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.bone}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: "0 clamp(18px, 4.6vw, 24px)"
    height: "50px"
  button-app-dark:
    backgroundColor: "{colors.bone}"
    textColor: "#141210"
    rounded: "{rounded.full}"
    padding: "0 20px"
    height: "48px"
  button-app-light:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-surface}"
    rounded: "{rounded.full}"
    padding: "0 20px"
    height: "48px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "40px"
  input-dark:
    backgroundColor: "{colors.off-black}"
    textColor: "{colors.bone}"
    rounded: "{rounded.m}"
    padding: "11px 14px"
    height: "48px"
  tile-plain-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.bone}"
    rounded: "{rounded.l}"
    padding: "14px 14px 13px 16px"
  tile-sleep-dark:
    backgroundColor: "{colors.sleep-tile-dark}"
    textColor: "{colors.bone}"
    rounded: "{rounded.l}"
    padding: "14px 16px"
  set-tick-done:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.on-metal}"
    rounded: "{rounded.full}"
    size: "34px"
  board-row-you-dark:
    backgroundColor: "{colors.surface-2-dark}"
    textColor: "{colors.bone}"
    rounded: "{rounded.m}"
    padding: "8px 10px"
  card-today:
    backgroundColor: "{colors.off-black}"
    textColor: "{colors.bone}"
    rounded: "{rounded.card}"
    padding: "14px 12px 12px"
  fragment:
    backgroundColor: "{colors.off-black}"
    textColor: "{colors.bone}"
    rounded: "{rounded.fragment}"
    padding: "18px 20px 20px"
  room-silver:
    backgroundColor: "{colors.silver}"
    textColor: "{colors.on-metal}"
    rounded: "{rounded.room}"
    padding: "clamp(24px, 4.4vw, 60px)"
  room-gold:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.on-metal}"
    rounded: "{rounded.room}"
    padding: "clamp(24px, 4.4vw, 60px)"
  room-bronze:
    backgroundColor: "{colors.bronze}"
    textColor: "{colors.on-metal}"
    rounded: "{rounded.room}"
    padding: "clamp(24px, 4.4vw, 60px)"
---

# Design System: rep.

## Overview

**Creative North Star: "The Weighted Instrument"**

rep. is a good instrument with a gym plate for a logo. The app is paper and ink in light and true black in dark, built from solid bento tiles, one colour per metric family, with numbers as the content. The signed-out landing keeps those exact tiles and adds what the app keeps small: the concentric plate and its three metals, at full scale, as the only imagery the system has.

Density splits by context. The app is phone-first and tight: 8px between tiles, a few seconds of attention at a time. The landing is spacious and sequential, with the app's dark tiles set inside it as pictures of the product. Both speak in one sans, titles included; a serif is held back for short spoken lines.

Motion is measured. Things arrive by short rises and fades on one long-tailed ease, rings close as numbers count, and every animation in the landing runs from content that is already complete in the markup, so removing the script or asking for reduced motion loses nothing. The data loops, the wire pulses and the step counter, stop when they leave the screen.

**Key Characteristics:**
- Warm off-black and bone, never pure black or white.
- One solid colour per metric family, read before the words.
- The plate as the recurring image, and its three metals as whole fields.
- Instrument Sans everywhere, titles included; Newsreader only for short spoken lines; tabular semi-condensed numbers.
- Finished work is marked, not tinted: a gold tick, a record named in text.
- Charts are rounded blocks on quiet grounds; the data is what has colour.
- Sample data shown in the app's own components, labelled as sample.

## Colors

Warm neutrals carry every surface; colour is either a metric family's solid hue or one of the three plate metals, which hold one value in both themes.

### Primary
- **Plate Gold** (#E7B653): the brand plate, the landing's primary action, focus ring, selection, full-stop marks, the live pulse on the data wires, and inside the app the tick of a finished set. Also the middle room.
- **Plate Gold Ring** (#D29F41): the darker band of the gold plate. Never used apart from the plate.
- **Lit Gold** (#F0C266): hover on a gold action only.

### Secondary
- **Plate Silver** (#CBD1DC) with ring (#B3BBC8): the repair plate, its word and its room.
- **Plate Bronze** (#C98352) with ring (#AF6D41): the reputation plate, its word and its room.

### Tertiary
Metric families, dark values shown, light values in `web/css/app.css`. Each has a mark colour, a text colour, and a deep solid tile with its own ink.
- **Sleep Blue** (#A9BEFF) on **Night Tile** (#1E3368): sleep marks; also the app's dark-theme accent for links and focus. Its light counterpart is **Sleep Navy** (#2E4A80).
- **Steps Gold** (#F0C35A) on **Umber Tile** (#4B3810): steps. It is a metric colour, close to but distinct from Plate Gold.
- **Ember** (#FF9466): energy, workouts and the awake stage.
- **Recovery Amber** (#F0A845): the recovery gauge and its bands.
- **Jade** (#74C3A1): landing state marks only, the synced dot and "Shared". In-app success stays on the theme's `--ok`.

### Neutral
- **Off-Black** (#0A0908): the dark ground and the landing's cards that hold tiles.
- **Bone** (#F2EDE5): dark-theme ink, and the light theme's page ground.
- **Bone Shade** (#D6CFC4): secondary text on dark.
- **Warm Dim** (#A39B90): tertiary text on dark, 7.25:1 on Off-Black.
- **Dark Surface** (#171513), **Raised Dark** (#24211E), **Dark Line** (#2A2622): tiles, insets and rules inside the app's dark theme.
- **Hairline** (rgba(242, 237, 229, 0.12)): landing dividers and the ghost button's edge.
- **Metal Ink** (#1A1815): all text on a metal field.
- **Paper Surface** (#FFFDF9), **Paper Inset** (#E9E3D8), **Paper Line** (#E4DDD1), **Ink** (#1D1A16), **Ink Shade** (#3D3832), **Paper Dim** (#6B6359): the light theme's cards, insets, rules and text.

### Named Rules
**The Three Metals Rule.** On the mark and the landing's rooms, silver is repair, gold is repetition, bronze is reputation, in that order. A metal appears as a whole field or a small mark. On an award a metal is a rank instead: gold best ever, silver best in a year, bronze best in 90 days, and platinum, an achievement's top level.

**The Action Colour Rule.** The app's primary action is ink on paper and bone on black. Gold is the primary action only on signed-out brand surfaces, where the plate is the subject. The gold tick of a finished set is a state, not an action.

**The Always-Dark Rule.** A signed-out brand surface is dark whatever the device asks for, and it sets the app's dark tile tokens on its own root so embedded tiles stay true to the app.

**The Family Hue Rule.** Each metric family owns one hue, split into a mark value for rings and bars and a text value that holds 4.5:1. Colour for a metric comes from its family tokens and nowhere else.

## Typography

**Display Font:** Instrument Sans (with system-ui, -apple-system, sans-serif)
**Spoken-Line Font:** Newsreader (with Georgia, Times New Roman, serif)

**Character:** A plain, tightly set grotesque does the work of every title, label and number; Newsreader is a second voice, slightly literary and unhurried, that only ever says something short. Both are self-hosted because the CSP allows fonts from this origin only.

### Hierarchy
- **Display** (650, up to 6rem, 0.98): the landing's one headline, and its close at a slightly smaller clamp.
- **Room Word** (650, up to 11.5rem, 0.9): one of the three words set as art across a metal room, single line, decorative to assistive technology.
- **Headline** (650, up to 3rem, 1.06): landing section statements, balanced wrap.
- **Title** (650, 2.125rem, 1.06, -0.03em): app page titles. Sheets (1.75rem), empty states (1.5rem) and signed-out and first-run titles at their larger clamps sit at -0.025em; a screen with a back arrow titles at 1.1875rem and -0.02em. Section headings are 650 at -0.02em.
- **Spoken** (500, 1.375rem, 1.2): a short line said to the reader, at this size for an AI heading. The Today note runs at 1.0625rem, the landing's line that names the mark at up to 2.5rem, and the headings of legal and developer pages at 2.25 to 2.5rem.
- **Body Lead** (400, up to 1.1875rem, 1.5): landing paragraphs, capped at 46ch.
- **Label** (600, 0.9375rem): tile labels with a 16px line icon.
- **Caption** (600, 0.71875rem, tabular): tile metadata such as time ranges.
- **Number** (600, 1.5rem to 3.125rem, 88% width, tabular lining): every metric value, with units at 0.42em and full width.

### Named Rules
**The Instrument Numbers Rule.** Every metric value is Instrument Sans at 88% width with tabular lining figures, so digits hold still while they count.

**The Title Voice Rule.** A title is Instrument Sans at 650, tracked tight. No title inside the app is set in Newsreader.

**The Spoken Line Rule.** Newsreader is weight 500 and reserved for short spoken lines: the Today note, an AI heading, the landing's line that names the mark, and the legal and developer pages. Running copy stays in Instrument Sans.

## Layout

The app is a single phone column with a 16px page pad and a two-column bento at 8px gaps; a tile spans both columns when it is wide. Spacing follows a 4 to 44px scale, and the shell changes shape at 600px and 960px.

The landing runs in a 1240px container with a fluid gutter (`clamp(20px, 5vw, 56px)`). Sections breathe at roughly 72 to 140px by clamp. The metal rooms break wider than the container, to 1360px, with 12 to 20px between them and at the page edge. The hero is one column until 1200px, then two equal columns with the plate standing behind the product card. Rooms pair text with a fragment up to 480px wide from 900px, and the gold room reverses the order so the three do not stack identically. The landing's other breakpoints are 760px for the three name columns and table rows, and 900px for the device flow, which runs straight down on a phone and fans into wires when wide. Short laptops (under 820px tall) scale the pinned name section down rather than losing the pin; it falls back to normal flow when its content will not fit.

## Elevation & Depth

A hybrid. App tiles are flat colour with a 1px inset edge, and depth comes from tonal steps, so a row that needs lifting takes the next surface up rather than a shadow; soft warm shadows are reserved for floating chrome and sheets. On the landing the one lifted object per moment is a dark product piece, and it casts a deep soft shadow tinted to whatever it sits on.

### Shadow Vocabulary
- **Tile Edge** (`box-shadow: 0 0 0 1px rgb(255 246 232 / 0.04) inset`): plain dark tiles, in place of a border, felt more than seen.
- **Float** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.5), 0 8px 24px -8px rgb(0 0 0 / 0.6)`): dark-theme floating bar.
- **Sheet** (`box-shadow: 0 2px 6px rgb(0 0 0 / 0.6), 0 24px 56px -12px rgb(0 0 0 / 0.8)`): dark-theme overlays.
- **Product Card** (`box-shadow: 0 2px 6px rgb(0 0 0 / 0.3), 0 40px 90px -24px rgb(0 0 0 / 0.75)`, with Tile Edge): the Today card on black.
- **Fragment on Metal** (`box-shadow: 0 2px 6px rgb(40 26 8 / 0.2), 0 28px 50px -22px rgb(40 26 8 / 0.5)`): a dark fragment on a metal room, brown-tinted to read as a shadow on metal.

### Named Rules
**The Flat Metal Rule.** A metal is flat and casts nothing: a room, a plate, a medal, an achievement star, a trophy. Awards are two hard tones with the mark's rings and no lighting, ribbon or shadow. Only the dark fragment resting on a metal room lifts.

## Shapes

Round and heavy, after the plate. Radii step up with the size of the object: 10 and 14px for controls and inset rows, 24px for tiles, 28px for a fragment, 36px for a phone-sized card, up to 44px for a room. Actions and chips are full pills.

The plate is the one silhouette: a flat disc with a hub hole and a darker band, its ring boundaries at 17%, 37% and 75% of the radius with hard stops. It appears as the favicon and small mark, at up to 640px beside the hero card, and in miniature as the full stop of "rep." in large headlines, where the hub shows the ground beneath. The three-plate mark comes from `web/rep-mark.svg`, never redrawn. Dividers are 1px rules; tile progress is a 4px rounded bar, and scores are round-capped rings. Chart marks are rounded blocks, never past half their width: bars to 5px (4px in a sparkline), stage blocks to 3px.

## Components

### Buttons
Heavy, soft and direct.
- **Shape:** full pill (999px).
- **Gold (landing primary):** Plate Gold with Metal Ink, 50px tall.
- **Ghost (landing secondary):** transparent with Bone text and a 1px inset Hairline.
- **App primary:** the theme's brand pair, ink on paper or bone on black, 48px tall; tonal and ghost variants below it, with a 44px small size.
- **Hover / Focus:** Lit Gold, a 7% bone wash on ghost, hover only on fine pointers; on press the button scales to 0.97 to 0.98. Landing focus is a 2px gold outline offset 3px.

### Chips
- **Style:** 40px pill, 1px strong line, secondary ink at 600.
- **State:** selected fills with ink on the ground colour.

### Bento Tiles
The system's core object.
- **Corner Style:** 24px.
- **Background:** the family's solid tile, or Dark Surface with Tile Edge for a plain tile.
- **Content:** label top-left, metadata or a ring top-right, the number at the bottom. Rings and bars take the tile's mark colour on a track mixed from its ink.
- **Press:** scales to 0.975 when interactive.

### Inputs / Fields
- **Style:** 48px, ground-coloured, 1px strong line, 14px radius, text never below 16px.
- **Focus:** the border takes the accent with a 3px accent-soft ring.
- **Error:** the border takes the bad colour.
- **In a set row:** filled with the raised surface, no border.

### Navigation
- **App:** a floating tab bar with a sliding rounded indicator, 22px line icons over 0.6875rem labels; the current tab goes to ink at 600. It becomes a rail on wide screens.
- **Landing:** the wordmark with its small plate at left and a single quiet text link at right.

### Stage Lanes
One night of sleep in four labelled lanes: Awake, REM, Light and Deep from top to bottom, names at the left at 0.6875rem in the dim ink. Each stretch is a block in its stage colour with a 3px radius, 5px between lanes and 1.2px between blocks. Without stage data the night is one band. A tap on a block reads its stage and times.

### Charts
The data has the colour and the ground stays quiet. Bars take the family's mark, or 42% of it when short of the goal. A highlighted range is 5% of the mark, and heart-rate zone bands are held to 32% of their tint.

### Set Row
A set of an exercise, in the logger and the routine editor. Rows sit on 1px hairlines with no fill.
- **Tick:** a 34px circle with a 1.5px strong-line ring. Done, it fills Plate Gold with a Metal Ink check; on press it scales to 0.9.
- **Done:** only the tick changes. Neither the row nor its exercise card is tinted.
- **Records:** named in the steps text colour at 650, with no chip or ground.

### Leaderboard Row
Rows sit directly on the board's card, 14px radius, with no dividers and no comparison bar; the number is the value. Your own row is lifted out on the raised surface, one step further on hover.

### Metal Room
A full-bleed-feeling rounded field in one metal: its word huge across the top with an on-metal plate for the full stop, then a statement beside one dark fragment. Body copy is Metal Ink at 84%, which is 4.59:1 on bronze and is the floor.

### Product Fragment
A slice of a real app screen on Off-Black using the app's own tiles, rings and number styles. A live detail plays once when it scrolls in: a hypnogram wipes, sets check off, five pace bars rise, a friend gets overtaken.

### Device Flow
Devices on the left, a plate at the centre, readings on the right, joined by thin bone wires with small gold pulses that run only while on screen.

### The Name
The three plates of the mark, pinned while the page scrolls, each plate and its word lit in turn. Light is the only change: an unlit piece holds 16% opacity and nothing moves.

## Do's and Don'ts

### Do:
- **Do** show the product through the app's own tile, ring and number components, not illustrations of them.
- **Do** label every number on a signed-out surface as a sample, in the fragment's own metadata line.
- **Do** build the plate with hard ring stops at 17%, 37% and 75% of its radius.
- **Do** keep body copy on a metal at Metal Ink 84% or stronger.
- **Do** draw new icons in the round-capped line of `web/js/lines.js`, on a 24-unit grid.
- **Do** make every entrance rewind content that is already complete, and remove all of it under reduced motion.
- **Do** pause data loops such as wire pulses and live counters when they leave the screen.
- **Do** lift hover states behind `(hover: hover)` so they never stick on touch.
- **Do** keep a chart's ground quieter than its data.

### Don't:
- **Don't** swap a metal's meaning or use a metal for a metric; Steps Gold is the metric, Plate Gold is the brand.
- **Don't** put a metal behind a wash or soft gradient. The only dimming is the name section's unlit plates as they wait their turn, lit by opacity alone and never moved.
- **Don't** cast a shadow from a metal room.
- **Don't** use gold as the primary action inside the signed-in app.
- **Don't** set an app title or running copy in Newsreader.
- **Don't** tint a set row or exercise card for being done, or put a record in a chip.
- **Don't** add dividers or comparison bars to leaderboard rows; your own row is the only one lifted.
- **Don't** load a font from anywhere but this origin, or add a third family.
- **Don't** set metric values in proportional figures or at full width.
- **Don't** render the name as anything but lowercase "rep." with its full stop.
