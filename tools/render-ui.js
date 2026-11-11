#!/usr/bin/env node
/* Renders every state of the Figma plugin UI (figma-plugin/ui.html) in headless Chrome and builds
 * docs/compare_figma_ui.png: Figma design (docs/figma/*.png, exported via the Figma MCP) | our render | diff.
 * Usage: node tools/render-ui.js   (CHROME=/path/to/chrome to override) */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { launch, openUI } = require("./ui-harness.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "ui");
// Figma reference screenshots include a 4px margin for the card shadow, so we render the card the same way.
const SEL = "__toUI({type:'selection',count:1,names:['Frame Name'],changed:true});";
const OFF = "__ub.setConnected(false);";                                  // AE unreachable -> "No bridge" alert
const OFF_CLOSED = "__ub.ui.alertClosed = true; __ub.setConnected(false);"; // AE unreachable, alert closed
const ON = "__ub.setConnected(true);";
// One entry per variant of the Figma component set (docs/figma/<name>.png), then extra states that are not in the design.
const STATES = [
  { name: "waiting", connected: false, size: [468, 468], setup: OFF_CLOSED },
  { name: "waiting-connected", connected: true, size: [468, 468], setup: ON },
  { name: "waiting-alert", connected: false, size: [468, 658], setup: OFF },
  { name: "ready", connected: true, size: [477, 658], setup: ON + SEL },
  { name: "ready-dropdown", connected: false, size: [477, 658], setup: OFF_CLOSED + SEL + "__ub.applyOptions({rasterScaleCap:2}); __ub.openMenu(document.querySelector('.field.scale'));" },
  { name: "ready-alert", connected: false, size: [477, 799], setup: OFF + SEL },
  { name: "exporting", connected: true, size: [477, 658], setup: ON + SEL + "__ub.setState('exporting');" },
  { name: "exporting-disconnected", connected: false, size: [477, 658], setup: OFF_CLOSED + SEL + "__ub.setState('exporting');" },
  { name: "exporting-alert", connected: false, size: [477, 799], setup: OFF + SEL + "__ub.setState('exporting');" },
  { name: "success", connected: true, size: [468, 477], setup: ON + SEL + "__ub.setState('success');" },
  { name: "success-disconnected", connected: false, size: [468, 477], setup: OFF_CLOSED + SEL + "__ub.setState('success');" },
  { name: "success-alert", connected: false, size: [468, 477], setup: OFF + SEL + "__ub.setState('success');" },
  // not in the design (extra states we need)
  { name: "hover", connected: true, size: [477, 658], extra: true, setup: ON + SEL, hover: "#send" },
  { name: "error", connected: true, size: [468, 477], extra: true, setup: ON + SEL + "__ub.setState('error','After Effects import failed: Could not create the composition (Uiscore Bridge panel error 12).');" },
  { name: "ready-thumbnail", connected: true, size: [477, 658], extra: true, setup: ON, thumb: true }
];

// The dark Figma export frames the card 3px from the top-left and 2px / 4px from the right / bottom (light: 4 / 2 / 4 / 6).
const THEMES = [
  { theme: "light", out: OUT, figma: path.join(ROOT, "docs/figma"), size: (sz) => sz, compare: [] },
  { theme: "dark", out: path.join(OUT, "dark"), figma: path.join(ROOT, "docs/figma/dark"), size: (sz) => [sz[0] - 3, sz[1] - 1], compare: ["dark"] }
];

(async () => {
  const browser = await launch();
  try {
   for (const T of THEMES) {
    fs.mkdirSync(T.out, { recursive: true });
    const dims = {};
    for (const s0 of STATES) {
      const s = Object.assign({}, s0, { size: T.size(s0.size) });
      const page = await openUI(browser, { width: s.size[0], height: s.size[1], connected: s.connected, preview: true, theme: T.theme });
      if (s.thumb) {
        // a real thumbnail like main.js sends: the Figma "ready" reference itself as the selected frame image
        const bytes = Array.from(fs.readFileSync(path.join(ROOT, "docs/figma/success.png")));
        await page.eval(`__toUI({type:'selection',count:3,names:['Onboarding / Welcome','Card','Button'],changed:true}); __toUI({type:'selection',count:3,names:['Onboarding / Welcome','Card','Button'],thumb:new Uint8Array(${JSON.stringify(bytes)}),changed:false}); true`);
        await page.eval("new Promise(r => { const i = document.getElementById('thumb'); if (i.complete && i.naturalWidth) r(); else i.onload = r; })");
      }
      if (s.setup) await page.eval(s.setup + " true");
      await page.eval("new Promise(r => setTimeout(r, 120))");
      if (s.setup) await page.eval(s.setup + " true"); // again: the background /ping may have landed in between
      if (s.hover) {
        const c = await page.eval(`(() => { const r = document.querySelector('${s.hover}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
        await page.mouseMove(c[0], c[1]);
        await page.eval("new Promise(r => setTimeout(r, 80))");
      }
      dims[s.name] = await page.eval("(() => { const r = document.getElementById('app').getBoundingClientRect(); return [r.width, r.height]; })()");
      fs.writeFileSync(path.join(T.out, s.name + ".png"), await page.screenshot({ width: s.size[0], height: s.size[1] }));
      await page.close();
      console.log("wrote " + path.relative(ROOT, path.join(T.out, s.name + ".png")), "card " + dims[s.name].join("x"));
    }
    fs.writeFileSync(path.join(T.out, "dims.json"), JSON.stringify(dims, null, 2));
   }
  } finally { await browser.close(); }
  for (const T of THEMES) execFileSync("python3", [path.join(__dirname, "compare_ui.py"), ROOT].concat(T.compare), { stdio: "inherit" });
})().catch((e) => { console.error(e); process.exit(1); });
