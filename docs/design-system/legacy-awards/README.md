# Legacy awards

The medals, achievement stars, trophies and rank crests as they were before the plate system:
lit metal, a two-tone ribbon, shadows and a 3D arrival. Kept for reference and to
go back to. Nothing in the app loads these files.

- `medals.js` was `web/js/medals.js`
- `medals.css` was `web/css/medals.css`
- `rankart.js` was `web/js/rankart.js`, the rank crests (taken from commit 62ede20; their shadow was on `.rk__svg` in `web/css/b-health.css`)

`medals.js` and `medals.css` are copies from commit 8521311. To restore the old look, put them back at those
paths, then also take `web/css/social.css`, `web/css/b-health.css` and the award
parts of `web/design-system.html` from that commit, and bump `VERSION` in `web/sw.js`.
