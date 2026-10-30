#!/usr/bin/env python3
"""Render the link-preview card: 1200x630, the app's own icon (the rose heart) and palette.

    python3 scripts/make-og.py

Same layout as the other ojee.net sites (teg.ojee.net/assets/make-og.py), so a
pasted link looks like one of the family. Needs Pillow.
"""
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
C = dict(out=ROOT / "web/og.png", icon=ROOT / "web/icon-512.png", bg="#0A0908", panel="#171513",
         accent="#E27B92", ink="#F2EDE5", dim="#A39B90",
         title="health.", sub="tracker", lines=["A health tracker for friends",
                                                "steps · sleep · heart · workouts · a shared leaderboard"])


def font(size, bold=False):
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" if bold else
                 "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
                 "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


W, H = 1200, 630
im = Image.new("RGB", (W, H), C["bg"])
d = ImageDraw.Draw(im)
# a faint grid, the same texture the family's cards use
for x in range(0, W, 40):
    d.line([(x, 0), (x, H)], fill=C["panel"], width=1)
for y in range(0, H, 40):
    d.line([(0, y), (W, y)], fill=C["panel"], width=1)
d.rectangle([56, 56, W - 56, H - 56], outline=C["accent"], width=2)

glyph = Image.open(C["icon"]).convert("RGBA").resize((150, 150), Image.LANCZOS)
im.paste(glyph, (110, 150), glyph)

d.text((110, 340), C["title"], font=font(84, True), fill=C["ink"])
tw = d.textlength(C["title"], font=font(84, True))
d.text((110 + tw + 16, 372), C["sub"], font=font(40), fill=C["accent"])
for i, line in enumerate(C["lines"]):
    d.text((112, 442 + i * 40), line, font=font(26), fill=C["dim"] if i else C["ink"])
d.text((112, H - 88), "ojee.net", font=font(22), fill=C["accent"])
im.save(C["out"])
print("wrote", C["out"])
