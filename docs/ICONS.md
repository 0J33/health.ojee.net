# Icons

The app uses one icon family: **Material Symbols Rounded, weight 400**, by
Google, licensed under the **Apache License 2.0**
(<https://github.com/google/material-design-icons>, packaged as
`@material-symbols/svg-400`). No other icon source is mixed in. The one
exception is `pulse`, the app's own mark, drawn from `docs/heart-rate.svg`.

Only the glyphs the app uses are shipped, as path data in
`web/js/icons.js`, served from our own origin (no icon font, no CDN). That
file is generated; do not edit it by hand.

## Adding or changing an icon

1. Add a line to `MAP` in `scripts/make-icon-set.mjs`:
   `ourName: ['material_symbol_name']`, with `, true` when it is a metric
   glyph that should be drawn filled.
2. Regenerate:

   ```bash
   npm pack @material-symbols/svg-400 && tar -xzf material-symbols-svg-400-*.tgz
   node scripts/make-icon-set.mjs ./package
   ```

   A metric's glyph is named by the server (`icon` of a metric, a Material
   Symbols name). Where the app already had that glyph under its own name,
   `ICON` in `web/js/metrics.js` maps it (`favorite` → `heart`, `bedtime` →
   `moon`, `chair` → `sedentary`, `calendar_month` → `cycle`, `sick` →
   `symptom`, `ecg` → `ecg_trace`, …); every other one is generated under
   the server's own name. All 41 names the catalogue sends exist in the
   package; none had to be substituted.

3. Use it: `ic('ourName')` in a template (`web/js/ui.js`), or
   `icon('ourName', { fill: true | false, size: 's' | 'l', label })`.

## Rules

- Material glyphs are **filled paths on a 960 grid** (`viewBox="0 -960 960
  960"`), so `.ic` is `fill: currentColor; stroke: none`. A stroked,
  hand-drawn path inside `.ic` renders as a solid block: do not add any.
- Metric glyphs are the filled drawing and take their metric family's
  colour (`docs/DESIGN.md`, Colour), usually on a soft tinted badge
  (`.ib`). Actions and settings rows use the outline in the text colour.
  The tab bar shows the outline, and the filled drawing for the selected tab.
- No emojis, no Apple SF Symbols, no second icon pack.

Apache-2.0 requires the licence to accompany redistribution: its text is at
<https://www.apache.org/licenses/LICENSE-2.0>, and this file is the notice.

## 2026-10-31: line icons

The redesign draws icons as lines: `web/js/lines.js` (one family, 24 grid,
stroke 1.75, round caps and joins; shapes after Lucide, ISC, plus the app's
own podium, gauge, dumbbell, lungs and figures). `icon(name)` in
`web/js/icons.js` returns the line drawing when `LINE[name]` exists (class
`ic--line`, stroked) and falls back to the Material glyph otherwise. The
generator (`scripts/make-icon-set.mjs`) writes that same check, so
regenerating icons.js keeps it. The app icon itself (a rose heart with a
pulse line) came from `~/Downloads/ui-overhaul/icon/3-heart-pulse/`.
