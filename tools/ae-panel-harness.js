/* Loads ae-extension/index.html in headless Chrome with a fake CEP host (window.__adobe_cep__ + cep_node.require):
 * the bridge server is stubbed, window.__ae.opts exposes the createBridge() options so tests can fire onPing()/log().
 * Shared by tests/ui.test.js and tools/render-ae-panel.js. */
const path = require("path");
const PANEL = path.join(__dirname, "..", "ae-extension", "index.html");

const INIT = `
  window.__ae = { opts: null, startError: null, started: 0, evals: [], opened: [], tools: {} };
  window.__adobe_cep__ = {
    getSystemPath: function () { return "file:///Users/test/Library/Application%20Support/Adobe/CEP/extensions/uiscore-bridge"; },
    getHostEnvironment: function () { return JSON.stringify({ appVersion: "25.1" }); },
    evalScript: function (s, cb) {
      window.__ae.evals.push(s);
      var m = /UiscoreBridge\.(precompose|decompose|toggleVisibility)\(\)/.exec(s);
      setTimeout(function () { cb(m ? JSON.stringify(window.__ae.tools[m[1]] || { ok: true, summary: m[1] + " done", warnings: [] }) : (/typeof UiscoreBridge/.test(s) ? "object" : "/Users/test/Projects")); }, 0);
    }
  };
  window.cep_node = { require: function (name) {
    if (name === "path") return { join: function () { return [].slice.call(arguments).join("/"); }, normalize: function (p) { return p; } };
    if (name === "os") return { homedir: function () { return "/Users/test"; } };
    if (name === "fs") return { mkdirSync: function () {}, readFileSync: function () { return "{}"; } };
    if (name === "child_process") return { exec: function (c) { window.__ae.opened.push(c); } };
    if (/geom\\.jsx$/.test(name)) return {};
    if (/ffx\\.js$/.test(name)) return { templateFamily: function () { return "ae25-6"; } };
    if (/server\\.js$/.test(name)) return { createBridge: function (opts) {
      window.__ae.opts = opts;
      return { start: function (port) { window.__ae.started++; return window.__ae.startError ? Promise.reject(window.__ae.startError) : Promise.resolve(port); },
               stop: function () { return Promise.resolve(); } };
    } };
    throw new Error("harness: unexpected require " + name);
  } };
  window.process = { platform: "darwin" };
`;

async function openPanel(browser, opts) {
  opts = opts || {};
  const page = await browser.newPage(opts.width || 420, opts.height || 560);
  await page.addInitScript((opts.keepStorage ? "" : "try { localStorage.clear(); } catch (e) {}") + INIT + (opts.init || ""));
  await page.goto("file://" + PANEL);
  await page.eval("new Promise(function (r) { (function w() { if (window.__ae.started) setTimeout(r, 20); else setTimeout(w, 10); })(); })");
  await page.eval("document.fonts.ready.then(function () { return true; })");
  return page;
}

module.exports = { openPanel, PANEL };
