/* Renders the AE panel states to /workspace/ae_panel_*.png (or argv[2] dir):
 * <state>.png at a typical panel size (420x560) and <state>_figma.png at the Figma variant's frame size (460 wide). */
const fs = require("fs");
const path = require("path");
const { launch } = require("./cdp.js");
const { openPanel } = require("./ae-panel-harness.js");
const OUT = process.argv[2] || "/workspace";

const LOG = [
  ["Job written: /Users/test/Projects/Uiscore Bridge/2026-11-11_2131_Hero (14 images, 3 gradients)", "info"],
  ["Imported: 1 comp, 42 layers (Hero 1440x900)", "info"],
  ["Gradient preset not written (radial: no template for ae25-6)", "warn"],
  ["Job written: /Users/test/Projects/Uiscore Bridge/2026-11-11_2133_Card (2 images, 0 gradients)", "info"],
  ["Imported: 1 comp, 9 layers (Card 375x240)", "info"]
];
const CLOSED = 'localStorage.setItem("uiscoreBridge.accordions", JSON.stringify({ groups: false, managing: false, log: false }));';
const ERR = "window.__ae.opts.log('error', 'Import failed: Cannot create layer \"Hero / Mask\": After Effects returned an error (Unable to set value).');";
// name: [accordion init, js after load, hover selector, Figma variant frame height]
const STATES = {
  default: [CLOSED, "", null, 272],
  hover: [CLOSED, "", "#accManaging .acc-head", 272],
  default_connected: [CLOSED, "window.__ae.opts.onPing();", null, 272],
  collapsed_error: [CLOSED, ERR, null, 413],
  opened: ["", "", null, 688],
  opened_connected: ["", "window.__ae.opts.onPing();", null, 688],
  opened_error: ["", ERR, null, 829]
};

(async () => {
  const browser = await launch(null, { scrollbars: true }); // show the styled log scrollbar
  try {
    for (const [suffix, w, fixedH] of [["", 420, 560], ["_figma", 460, null]]) for (const [name, [init, js, hover, figH]] of Object.entries(STATES)) {
      const h = fixedH || figH;
      const page = await openPanel(browser, { width: w, height: h, init });
      await page.eval("(function(){" + JSON.stringify(LOG) + ".forEach(function (l) { window.__ae.opts.log(l[1], l[0]); }); " + js + " document.getElementById('log').scrollTop = 1e9; return true; })()");
      if (hover) {
        const r = await page.eval(`(function(){ var b = document.querySelector(${JSON.stringify(hover)}).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
        await page.mouseMove(r[0], r[1]);
      }
      await new Promise((r) => setTimeout(r, 150));
      const file = path.join(OUT, "ae_panel_" + name + suffix + ".png");
      fs.writeFileSync(file, await page.screenshot({ width: w, height: h })); console.log(file, w + "x" + h);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
