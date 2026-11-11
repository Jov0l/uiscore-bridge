"""Builds docs/compare_figma_ui.png: per state Figma reference | our headless render | |diff| x4, with mean deltas."""
import json, os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

root = sys.argv[1]
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"
sub = "dark" if dark else ""
fig, ours = os.path.join(root, "docs/figma", sub), os.path.join(root, "docs/ui", sub)
states = ["waiting", "waiting-connected", "waiting-alert", "ready", "ready-dropdown", "ready-alert",
          "exporting", "exporting-disconnected", "exporting-alert", "success", "success-disconnected", "success-alert"]
extras = ["hover", "error", "ready-thumbnail"]

def font(size, bold=False):
    for f in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(f): return ImageFont.truetype(f, size)
    return ImageFont.load_default()

rows, report = [], {}
for s in states + extras:
    o = Image.open(os.path.join(ours, s + ".png")).convert("RGB")
    fp = os.path.join(fig, s + ".png")
    if s in states and os.path.exists(fp):
        f = Image.open(fp).convert("RGB")
        w, h = max(f.width, o.width), max(f.height, o.height)
        fa = Image.new("RGB", (w, h), "white"); fa.paste(f, (0, 0))
        oa = Image.new("RGB", (w, h), "white"); oa.paste(o, (0, 0))
        d = ImageChops.difference(fa, oa)
        mean = sum(ImageStat.Stat(d).mean) / 3
        report[s] = {"figma": [f.width, f.height], "ours": [o.width, o.height], "meanAbsDiff": round(mean, 2)}
        d = d.point(lambda v: min(255, v * 4))
        rows.append((s, [("Figma design", f), ("Uiscore Bridge ui.html", o), ("|diff| x4  (mean %.2f / 255)" % mean, d)]))
    else:
        rows.append((s + "  (not in the design)", [("", None), ("Uiscore Bridge ui.html", o), ("", None)]))

PAD, LABEL, COLW = 24, 28, 480
W = PAD + 3 * (COLW + PAD)
H = 64 + sum(LABEL + max((im.height for _, im in cols if im), default=0) + PAD for _, cols in rows)
out = Image.new("RGB", (W, H), (250, 250, 250))
dr = ImageDraw.Draw(out)
dr.text((PAD, 18), ("Uiscore Bridge DARK - Figma design (node 2887:1001)" if dark else "Uiscore Bridge - Figma design (node 2686:126894)") + " vs figma-plugin/ui.html, headless Chrome, 1x", fill=(9, 9, 11), font=font(18, True))
y = 64
for name, cols in rows:
    hmax = max((im.height for _, im in cols if im), default=0)
    for i, (lab, im) in enumerate(cols):
        x = PAD + i * (COLW + PAD)
        if i == 0: dr.text((x, y), name.upper(), fill=(82, 82, 92), font=font(13, True))
        if im is not None:
            dr.text((x + (0 if i else 160), y), lab, fill=(113, 113, 123), font=font(12))
            out.paste(im, (x, y + LABEL))
    y += LABEL + hmax + PAD
dst = os.path.join(root, "docs/compare_figma_ui_dark.png" if dark else "docs/compare_figma_ui.png")
out.save(dst)
json.dump(report, open(os.path.join(ours, "compare.json"), "w"), indent=2)
print("wrote " + os.path.relpath(dst, root))
for k, v in report.items(): print("  %-22s figma %s  ours %s  mean|diff| %.2f" % (k, v["figma"], v["ours"], v["meanAbsDiff"]))
if report: print("  average mean|diff| %.2f over %d design states" % (sum(v["meanAbsDiff"] for v in report.values()) / len(report), len(report)))
