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
