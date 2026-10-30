"""Builds docs/demo.gif and docs/social-card.png for the README: python docs/make_visuals.py docs

Every event shown is a real line from the gateway log (gateway.jsonl):
  page 1, night of 22 Oct: D->B failover-replay 21:12:33, B->C 23:01:11, all restricted 00:26:04 (D opens 01:00)
  page 2, 21 Oct: all restricted 11:23:56 (B opens 14:20), served by B 14:21:01 with nobody typing (HANDOFF)
Status lines use statusline.mjs's real format; usage is omitted, as it is when the numbers are unknown.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
MONO = r"C:\Windows\Fonts\CascadiaMono.ttf"
SANS, SANS_B = r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\segoeuib.ttf"

BG, WIN, EDGE, BAR = "#0d1117", "#161b22", "#30363d", "#1f2630"
TEXT, DIM, GREEN, AMBER, RED, BLUE = "#e6edf3", "#8b949e", "#3fb950", "#d29922", "#f85149", "#58a6ff"


def mono(size, bold=False):
    f = ImageFont.truetype(MONO, size)
    try:
        f.set_variation_by_name("Bold" if bold else "Regular")
    except Exception:
        pass
    return f


W, H = 880, 352
F, FB, FS = mono(17), mono(17, True), mono(14)
CW = F.getlength("M")
X0, Y0, LH = 34, 98, 31


def segs(draw, x, y, parts, font=F):
    for text, color in parts:
        draw.text((x, y), text, font=font, fill=color)
        x += font.getlength(text)


def page(title, lines, status, status_color=TEXT):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((10, 10, W - 10, H - 10), 12, fill=WIN, outline=EDGE)
    d.rounded_rectangle((10, 10, W - 10, 50), 12, fill=BAR)
    d.rectangle((11, 38, W - 11, 50), fill=BAR)
    d.line((11, 50, W - 11, 50), fill=EDGE)
    for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        d.ellipse((28 + i * 22, 24, 40 + i * 22, 36), fill=c)
    cap = "replay of real gateway log lines  ·  accounts B, C, D"
    d.text(((W - FS.getlength(cap)) / 2, 22), cap, font=FS, fill=DIM)
    d.text((X0, 66), title, font=FB, fill=TEXT)
    for i, parts in enumerate(lines):
        segs(d, X0, Y0 + i * LH, parts)
    # Claude Code's status line, as statusline.mjs prints it
    d.line((24, H - 62, W - 24, H - 62), fill=EDGE)
    segs(d, X0, H - 48, [("status line  ", DIM), (status, status_color)], F)
    return im


T = lambda t: (t + "  ", DIM)
ARROW = ("  →  ", DIM)
OK = ("  ✓ 200", GREEN)

p1 = "22 Oct, evening: one long Claude Code task"
l1 = [T("21:12"), ("D", AMBER), (" hits its limit (429)", TEXT), ARROW, ("same request re-sent on ", TEXT), ("B", BLUE), OK]
l2 = [T("23:01"), ("B", AMBER), (" hits its limit (429)", TEXT), ARROW, ("re-sent on ", TEXT), ("C", BLUE), OK]
l3a = [T("00:26"), ("C", AMBER), (" full too: ", TEXT), ("all three full", RED)]
l3 = l3a + [ARROW, ("D reopens first, 01:00", TEXT)]

p2 = "21 Oct: all three full, terminal chat left alone"
m1a = [T("11:24"), ("all three full", RED)]
m1 = m1a + [ARROW, ("Claude Code told: resets 2:20 pm", TEXT)]
m2 = [("       ", DIM), ("... three hours, nobody typing ...", DIM)]
m3 = [T("14:20"), ("B", BLUE), ("'s 5-hour window resets", TEXT)]
m4a = [T("14:21")]
m4 = m4a + [("the chat carries on by itself on ", TEXT), ("B", BLUE), OK]

S_D, S_B, S_C = "gw→D [B,C,D]", "gw→B [B,C,D]", "gw→C [B,C,D]"
S_FULL1 = "gw→D [B,C,D] | all full, D opens 01:00 AM"
S_FULL2 = "gw→B [B,C,D] | all full, B opens 02:20 PM"

frames = [  # (image, milliseconds)
    (page(p1, [], S_D), 1400),
    (page(p1, [l1[:3]], S_D), 700),
    (page(p1, [l1], S_B), 1500),
    (page(p1, [l1, l2[:3]], S_B), 700),
    (page(p1, [l1, l2], S_C), 1500),
    (page(p1, [l1, l2, l3a], S_C), 700),
    (page(p1, [l1, l2, l3], S_FULL1, AMBER), 2600),
    (page(p2, [], S_FULL2, AMBER), 1200),
    (page(p2, [m1a], S_FULL2, AMBER), 600),
    (page(p2, [m1], S_FULL2, AMBER), 1400),
    (page(p2, [m1, m2], S_FULL2, AMBER), 1500),
    (page(p2, [m1, m2, m3], S_FULL2, AMBER), 1100),
    (page(p2, [m1, m2, m3, m4a], S_FULL2, AMBER), 500),
    (page(p2, [m1, m2, m3, m4], S_B, GREEN), 4200),
]

# One shared palette taken from the busiest frames keeps colours steady and the file small.
ref = Image.new("RGB", (W, H * 2))
ref.paste(frames[6][0], (0, 0))
ref.paste(frames[-1][0], (0, H))
pal = ref.quantize(colors=48, method=Image.Quantize.MEDIANCUT)
qs = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im, _ in frames]
qs[0].save(OUT + "/demo.gif", save_all=True, append_images=qs[1:], duration=[ms for _, ms in frames],
           loop=0, optimize=True, disposal=1)

# ---- social preview card, 1280x640 (GitHub's recommended size; content kept 40px+ from the edges)
CWD, CHT = 1280, 640
im = Image.new("RGB", (CWD, CHT), BG)
d = ImageDraw.Draw(im)
title = ImageFont.truetype(SANS_B, 70)
sub = ImageFont.truetype(SANS, 34)
small = ImageFont.truetype(SANS, 26)
d.text((80, 78), "Claude Code", font=title, fill=TEXT)
d.text((80, 160), "Account Switcher", font=title, fill=BLUE)
d.text((80, 270), "Switches to your next Claude account when one hits its limit.", font=sub, fill=TEXT)
d.text((80, 318), "When all are full, a terminal chat carries on by itself at the reset.", font=sub, fill=TEXT)
# a terminal strip with two real status lines
d.rounded_rectangle((80, 400, CWD - 80, 520), 14, fill=WIN, outline=EDGE)
sf = mono(26)
segs(d, 112, 420, [(S_FULL2, AMBER)], sf)
segs(d, 112, 466, [(S_B, GREEN), ("   ✓ carried on by itself at 02:21 PM", DIM)], sf)
d.text((80, 552), "Windows · Linux · zero dependencies · Apache-2.0", font=small, fill=DIM)
im.save(OUT + "/social-card.png", optimize=True)
print("ok")
