/* After Effects CEP panel (ae-extension/index.html) = Figma "Uiscore Bridge AE - dark" (node 2896:47300).
 * Static checks always run; the behaviour checks drive the panel in headless Chrome with a fake CEP host (skipped without Chrome). */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const G = require("../shared/geom.js");
const { createBridge } = require("../ae-extension/js/server.js");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const html = read("ae-extension/index.html");
const css = read("ae-extension/css/panel.css");
const main = read("ae-extension/js/main.js");

test("panel markup keeps every hook main.js uses", () => {
  const ids = new Set([...main.matchAll(/\$\("(\w+)"\)/g)].map((m) => m[1]));
  for (const id of ["restart", "sample", "openJobs", "clear", "log", "dot", "status", "meta", "badge", "alertWrap", "alertTitle", "alertDesc", "alertClose"]) assert.ok(ids.has(id), "main.js uses #" + id);
  for (const id of ids) assert.match(html, new RegExp('id="' + id + '"'), "#" + id + " exists in index.html");
  for (const id of ["precomp", "decomp", "toggle"]) { assert.match(main, new RegExp(id + ": \\["), "tool " + id); assert.match(html, new RegExp('id="' + id + '"')); }
  for (const t of ["Groups", "Managing", "Audit Log", "Precomp", "Decomp", "Toggle", "Restart", "Import", "Open Folder", "Clear Log"]) assert.match(html, new RegExp(">" + t + "<"), t);
});

test("panel assets and fonts are local (CEP has no guaranteed internet)", () => {
  assert.doesNotMatch(html + css, /https?:\/\//, "no remote URLs");
  assert.doesNotMatch(html + css, /figma\.com\/api\/mcp\/asset|localhost:3845/);
  for (const m of (html + css).matchAll(/(?:src|url)\(?=?"(?!#)([^"]+\.(?:svg|png|woff2))"/g)) {
    const p = path.join(ROOT, "ae-extension", m[1].startsWith("../") ? m[1].slice(3) : m[1]);
    assert.ok(fs.existsSync(p) && fs.statSync(p).size > 0, m[1]);
  }
  assert.match(css, /--font-family-body:\s*"Plus Jakarta Sans", Inter/);
  assert.match(css, /font-family: "Geist Mono"/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /:has\(|@container/, "CEP 9 Chromium: no :has() / container queries");
  // the design's icons are the same files the Figma plugin uses
  for (const f of ["chevron-right.svg", "chevron-down.svg", "precomp.svg", "decomp.svg", "eye.svg", "restart.svg", "plus.svg"]) assert.ok(fs.statSync(path.join(ROOT, "ae-extension/img", f)).size > 0, f);
  for (const f of ["alert-error.svg", "crossmark.svg"]) assert.strictEqual(read("ae-extension/img/" + f), read("figma-plugin/assets/" + f), f);
});

test("bridge reports Figma pings through opts.onPing", async () => {
  let pings = 0;
  const bridge = createBridge({ geom: G, templatesDir: "", version: "0.1.0", resolveJobsRoot: async () => "", evalScript: async () => "{}", onPing: () => pings++ });
  const port = await bridge.start(0);
  try {
    await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: "/ping" }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject));
    assert.strictEqual(pings, 1);
  } finally { await bridge.stop(); }
});

const { findChrome, launch } = require("../tools/cdp.js");
const chrome = findChrome();
const { openPanel } = require("../tools/ae-panel-harness.js");

test("panel states and wiring (headless Chrome)", { skip: chrome ? false : "no Chrome/Chromium" }, async (t) => {
  const browser = await launch(chrome);
  t.after(() => browser.close());
  const page = await openPanel(browser, { width: 420, height: 560 });
  const ev = (js) => page.eval(js);
  const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const color = (sel, prop) => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}))[${JSON.stringify(prop || "color")}]`);

  await t.test("listening without Figma -> red Figma Disconnected; meta kept as tooltip + log line", async () => {
    assert.strictEqual(await text("status"), "Figma Disconnected");
    assert.strictEqual(await color(".badge"), "rgb(255, 51, 71)");
    assert.match(await ev("document.getElementById('badge').title"), /Listening on 127\.0\.0\.1:7341/);
    assert.strictEqual(await ev("document.getElementById('meta').title"), "After Effects 25.1 · gradient presets: ae25-6 · port 7341");
    assert.match(await text("meta"), /^Uiscore Bridge - v0\.1\.0$/);
    assert.match(await text("log"), /After Effects 25\.1 · gradient presets: ae25-6 · port 7341/);
    assert.match(await text("log"), /Listening on 127\.0\.0\.1:7341/);
    assert.strictEqual(await ev("document.getElementById('alertWrap').hidden"), true);
  });

  await t.test("a Figma ping -> green Connected", async () => {
    await ev("window.__ae.opts.onPing(); true");
    assert.strictEqual(await text("status"), "Connected");
    assert.strictEqual(await color(".badge"), "rgb(50, 179, 50)");
    assert.strictEqual(await color("#dot", "backgroundColor"), "rgb(50, 179, 50)");
  });

  await t.test("import failure -> error alert with the error text; close hides it; success hides it", async () => {
    await ev("window.__ae.opts.log('error', 'Import failed: Host returned: boom'); true");
    assert.strictEqual(await ev("document.getElementById('alertWrap').hidden"), false);
    assert.strictEqual(await text("alertTitle"), "Import failed.");
    assert.strictEqual(await text("alertDesc"), "Host returned: boom");
    assert.strictEqual(await color(".alert", "backgroundColor"), "rgb(75, 4, 11)");
    assert.match(await ev("document.querySelector('#log .err').textContent"), /Import failed: Host returned: boom/);
    await ev("document.getElementById('alertClose').click(); true");
    assert.strictEqual(await ev("getComputedStyle(document.getElementById('alertWrap')).display"), "none");
    await ev("window.__ae.opts.log('error', 'Import failed: again'); window.__ae.opts.log('info', 'Imported: 1 comp'); true");
    assert.strictEqual(await ev("document.getElementById('alertWrap').hidden"), true);
  });

  await t.test("Clear Log empties the log; Open Folder opens the jobs folder", async () => {
    await ev("document.getElementById('clear').click(); true");
    assert.strictEqual(await ev("document.getElementById('log').childElementCount"), 0);
    await ev("document.getElementById('openJobs').click(); true");
    assert.match((await ev("window.__ae.opened"))[0], /^open ".*Uiscore Bridge"$/);
  });

  await t.test("layout matches the design (accordions 116px open / 68px closed, 3 equal buttons, design fonts)", async () => {
    const r = await ev(`(function(){ var q = function (s) { var b = document.querySelector(s).getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
      return { g: q('#accGroups'), m: q('#accManaging'), btns: [].map.call(document.querySelectorAll('#accGroups .btn'), function (b) { var r = b.getBoundingClientRect(); return [r.left, r.width, r.height]; }),
               code: q('#logBody'), foot: q('.foot'), body: getComputedStyle(document.querySelector('.btn')).fontFamily, mono: getComputedStyle(document.getElementById('log')).fontFamily,
               fonts: document.fonts.check('500 14px "Plus Jakarta Sans"') && document.fonts.check('12px "Geist Mono"') }; })()`);
    assert.strictEqual(r.g[3], 116, "24 + 20 + 16 + 32 + 24"); assert.strictEqual(r.m[1], 116);
    assert.strictEqual(r.btns.length, 3);
    assert.strictEqual(r.btns[0][1], r.btns[2][1]); assert.strictEqual(r.btns[0][2], 32); assert.strictEqual(r.btns[0][0], 24);
    assert.strictEqual(r.code[0], 24); assert.strictEqual(r.code[1], 232 + 24 + 20 + 16); assert.strictEqual(r.code[2], 420 - 48);
    assert.strictEqual(r.foot[3], 68); assert.strictEqual(r.foot[1] + r.foot[3], 560);
    assert.match(r.body, /^"Plus Jakarta Sans", Inter/); assert.match(r.mono, /^"Geist Mono"/);
    assert.ok(r.fonts, "bundled fonts loaded");
  });

  await t.test("accordions: header toggles the body + chevron, state persists for the next panel load", async () => {
    const p2 = await openPanel(browser, { width: 420, height: 560 });
    const open = (id) => p2.eval(`document.getElementById(${JSON.stringify(id)}).className.indexOf('open') >= 0`);
    assert.strictEqual(await open("accGroups"), true, "open by default");
    await p2.eval("document.querySelector('#accGroups .acc-head').click(); true");
    assert.strictEqual(await open("accGroups"), false);
    assert.strictEqual(await p2.eval("getComputedStyle(document.getElementById('groupsBody')).display"), "none");
    assert.strictEqual(await p2.eval("document.querySelector('#accGroups .acc-head').getAttribute('aria-expanded')"), "false");
    assert.strictEqual(await p2.eval("getComputedStyle(document.querySelector('#accGroups .chev-closed')).display"), "block");
    assert.strictEqual(await p2.eval("document.getElementById('accGroups').getBoundingClientRect().height"), 68);
    const p3 = await openPanel(browser, { width: 420, height: 560, keepStorage: true });
    assert.strictEqual(await p3.eval("document.getElementById('accGroups').className.indexOf('open') >= 0"), false, "persisted closed");
    assert.strictEqual(await p3.eval("document.getElementById('accManaging').className.indexOf('open') >= 0"), true);
    await p2.close(); await p3.close();
  });

  await t.test("Precomp / Decomp / Toggle call the host; success -> log, failure -> error alert", async () => {
    await ev("window.__ae.tools.decompose = { ok: true, summary: 'Decomposed \"Card\" (3 layers) into \"Main\" (3 layers).', warnings: ['\"Card\" is no longer used and was kept in the project'] }; document.getElementById('decomp').click(); new Promise(r => setTimeout(r, 50))");
    assert.ok((await ev("window.__ae.evals")).some((x) => /UiscoreBridge\.decompose\(\)/.test(x)));
    assert.match(await text("log"), /Decomposed "Card"/);
    assert.match(await text("log"), /no longer used/);
    assert.strictEqual(await ev("document.getElementById('alertWrap').hidden"), true);
    await ev("window.__ae.tools.precompose = { ok: false, error: 'Select the layers to precompose in \"Main\".', warnings: [] }; document.getElementById('precomp').click(); new Promise(r => setTimeout(r, 50))");
    assert.strictEqual(await ev("document.getElementById('alertWrap').hidden"), false);
    assert.strictEqual(await text("alertTitle"), "Precomp failed.");
    assert.strictEqual(await text("alertDesc"), 'Select the layers to precompose in "Main".');
    await ev("document.getElementById('toggle').click(); new Promise(r => setTimeout(r, 50))");
    assert.ok((await ev("window.__ae.evals")).some((x) => /UiscoreBridge\.toggleVisibility\(\)/.test(x)));
    assert.strictEqual(await ev("document.getElementById('alertWrap').hidden"), true, "a success hides the alert");
    assert.strictEqual(await ev("document.getElementById('toggle').disabled"), false, "re-enabled after the call");
  });

  await t.test("busy port -> Bridge Offline + port alert; Restart retries", async () => {
    const p2 = await openPanel(browser, { width: 420, height: 560, init: "window.__ae.startError = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });" });
    assert.strictEqual(await p2.eval("document.getElementById('status').textContent"), "Bridge Offline");
    assert.strictEqual(await p2.eval("document.getElementById('alertTitle').textContent"), "Port 7341 is busy.");
    await p2.eval("window.__ae.startError = null; document.getElementById('restart').click(); new Promise(r => setTimeout(r, 50))");
    assert.strictEqual(await p2.eval("window.__ae.started"), 2);
    assert.strictEqual(await p2.eval("document.getElementById('status').textContent"), "Figma Disconnected");
    assert.strictEqual(await p2.eval("document.getElementById('alertWrap').hidden"), true);
    await p2.close();
  });
});
