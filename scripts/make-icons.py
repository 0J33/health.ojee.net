#!/usr/bin/env python3
"""Generate the health.ojee.net icon set from one source glyph.

    python3 scripts/make-icons.py [glyph.svg]      (default: docs/heart-rate.svg)

Produces, into web/:

    favicon.svg           the coloured glyph on a transparent background
    favicon.ico           16 / 32 / 48
    apple-touch-icon.png  180
    icon-192.png          192   (PWA / Android)
    icon-512.png          512   (PWA splash, maskable)

Family style of the other ojee sites (adapted from ojee-console's script):

    background   #000000   flat, square, no rounded corners. iOS and Android
                           apply their own mask; baking one in gets it masked
                           twice.
    glyph        #b6f23c   one flat colour, centred, 55.6% of the canvas
    margin       22.2%     on every side, inside the maskable safe zone

The glyph colour is the app's accent (--accent in web/css/app.css for the
dark theme). Change it in both places or not at all.

Requires cairosvg and Pillow, only to REGENERATE the icons. The committed
output has no runtime dependency.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import cairosvg
    from PIL import Image
except ImportError:
    sys.exit("needs cairosvg and pillow:  pip install --user cairosvg pillow")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web"
DEFAULT_SRC = ROOT / "docs" / "heart-rate.svg"

BG = "#000000"
FG = "#b6f23c"
CANVAS = 180                    # the reference size everything is expressed against
GLYPH = 100                     # 55.6% of CANVAS
OFFSET = (CANVAS - GLYPH) / 2   # 40, a 22.2% margin


def extract_paths(svg_text: str) -> tuple[str, float]:
    """The drawable content of a source glyph, plus its viewBox size."""
    vb = re.search(r'viewBox="([\d.\s-]+)"', svg_text)
    if not vb:
        raise SystemExit("source svg has no viewBox")
    parts = [float(p) for p in vb.group(1).split()]
    size = parts[2] if len(parts) >= 3 else 24.0

    body = re.sub(r"<\?xml.*?\?>", "", svg_text, flags=re.S)
    body = re.sub(r"<svg[^>]*>", "", body, count=1)
    body = re.sub(r"</svg>", "", body)
    # Drop any hardcoded fill so the whole glyph takes our colour.
    body = re.sub(r'\sfill="(?!none)[^"]*"', "", body)
    return body.strip(), size


def app_icon(glyph_body: str, glyph_size: float) -> str:
    scale = GLYPH / glyph_size
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}"
     width="{CANVAS}" height="{CANVAS}" role="img" aria-label="Health">
  <rect width="{CANVAS}" height="{CANVAS}" fill="{BG}"/>
  <g transform="translate({OFFSET:g} {OFFSET:g}) scale({scale:.6f})" fill="{FG}">
    {glyph_body}
  </g>
</svg>
'''


def favicon(glyph_body: str, glyph_size: float) -> str:
    """The glyph alone, full-bleed on a transparent ground, for browser tabs."""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {glyph_size:g} {glyph_size:g}" role="img" aria-label="Health">
  <g fill="{FG}">
    {glyph_body}
  </g>
</svg>
'''


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.exists():
        sys.exit(f"no such glyph: {src}")

    body, size = extract_paths(src.read_text())
    OUT.mkdir(parents=True, exist_ok=True)

    (OUT / "favicon.svg").write_text(favicon(body, size))
    print(f"favicon.svg           vector   from {src.name}")

    raw = app_icon(body, size).encode()
    for name, px in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]:
        cairosvg.svg2png(bytestring=raw, write_to=str(OUT / name),
                         output_width=px, output_height=px)
        print(f"{name:<21} {px}px")

    # Render each .ico frame at its true size rather than downscaling one
    # large bitmap. The tab icon is the glyph on a transparent ground, like
    # favicon.svg, so it does not turn into a black tile at 16px.
    fav = favicon(body, size).encode()
    frames = []
    for px in (16, 32, 48):
        tmp = OUT / f".ico-{px}.png"
        cairosvg.svg2png(bytestring=fav, write_to=str(tmp), output_width=px, output_height=px)
        frames.append(Image.open(tmp).convert("RGBA"))
    frames[-1].save(OUT / "favicon.ico", format="ICO",
                    sizes=[(f.width, f.height) for f in frames],
                    append_images=frames[:-1])
    for px in (16, 32, 48):
        (OUT / f".ico-{px}.png").unlink(missing_ok=True)
    print("favicon.ico           16/32/48")


if __name__ == "__main__":
    main()
