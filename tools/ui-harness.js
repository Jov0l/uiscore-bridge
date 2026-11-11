/* Loads the built figma-plugin/ui.html in headless Chrome with a fake Figma host:
 * parent.postMessage is recorded, fetch() to the bridge is stubbed, and plugin->UI messages can be injected.
 * Shared by tests/ui.test.js and tools/render-ui.js. */
const path = require("path");
const { launch } = require("./cdp.js");

const UI_FILE = path.join(__dirname, "..", "figma-plugin", "ui.html");
const SIZES = { compact: { width: 460, height: 469 }, full: { width: 469, height: 650 } };

const INIT = `
  window.__posted = [];
  window.__bridge = { connected: false, importResponse: { ok: true, summary: "1 comp, 12 layers", warnings: [] }, imports: [], pings: 0 };
  const realPost = window.postMessage.bind(window);
  window.parent.postMessage = function (data) { window.__posted.push(JSON.parse(JSON.stringify(data && data.pluginMessage || data))); };
  window.__toUI = function (msg) { window.dispatchEvent(new MessageEvent("message", { data: { pluginMessage: msg } })); };
  window.fetch = async function (url, init) {
    url = String(url);
    if (/\\/ping$/.test(url)) {
      window.__bridge.pings++;
      if (!window.__bridge.connected) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ ok: true, host: { name: "AEFT", version: "25.0" } }), { status: 200 });
    }
    if (/\\/import$/.test(url)) {
      window.__bridge.imports.push(init && init.body);
      if (!window.__bridge.connected) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(window.__bridge.importResponse), { status: 200 });
    }
    throw new TypeError("blocked in harness: " + url);
  };
`;

async function openUI(browser, opts) {
  opts = opts || {};
  const page = await browser.newPage(opts.width || 480, opts.height || 660);
  // opts.colorScheme / opts.reducedMotion emulate the OS media features; opts.theme = "dark" | "light" mimics Figma's html class
  const features = [];
  if (opts.colorScheme) features.push({ name: "prefers-color-scheme", value: opts.colorScheme });
  if (opts.reducedMotion) features.push({ name: "prefers-reduced-motion", value: "reduce" });
  if (features.length) await page.send("Emulation.setEmulatedMedia", { features });
  await page.addInitScript(INIT + (opts.connected ? "window.__bridge.connected = true;" : ""));
  await page.goto("file://" + UI_FILE);
  if (opts.theme) await page.eval(`document.documentElement.classList.add("figma-${opts.theme}"); true`);
  await page.eval("Promise.all([document.fonts.load('400 14px \"Plus Jakarta Sans\"'), document.fonts.load('500 14px \"Plus Jakarta Sans\"')]).then(() => document.fonts.ready).then(() => true)");
  if (opts.preview) await page.eval("document.documentElement.classList.add('preview','still'); true");
  await page.eval("new Promise(r => setTimeout(r, 50))");
  return page;
}

module.exports = { launch, openUI, UI_FILE, SIZES };
