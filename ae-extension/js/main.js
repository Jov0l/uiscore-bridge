/* Uiscore Bridge - CEP panel bootstrap (mixed context: DOM + Node). */
(function () {
  "use strict";
  var PORT = 7341;
  var cep = window.__adobe_cep__;
  var nodeRequire = (window.cep_node && window.cep_node.require) || (typeof require === "function" ? require : null);
  var $ = function (id) { return document.getElementById(id); };

  function log(text, cls) {
    var d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = new Date().toLocaleTimeString() + "  " + text;
    $("log").appendChild(d); $("log").scrollTop = 1e9;
  }
  function setStatus(on, text) {
    var cls = on === null ? "" : (on ? "on" : "off");
    $("dot").className = "dot " + cls; $("badge").className = "badge " + cls; $("status").textContent = text;
  }
  // Error alert (Figma "Error" state): import / server failures, closed with the cross or by the next successful import.
  function showAlert(title, desc) { $("alertTitle").textContent = title; $("alertDesc").textContent = desc || ""; $("alertWrap").hidden = false; try { $("alertWrap").scrollIntoView(false); } catch (e) {} }
  function hideAlert() { $("alertWrap").hidden = true; }
  $("alertClose").onclick = hideAlert;

  // Footer badge: server state + whether the Figma plugin is polling GET /ping (every 4 s while its window is open).
  var FIGMA_TIMEOUT = 10000;
  var server = { up: false, port: PORT, lastPing: 0 };
  function renderBadge() {
    if (!server.up) return;
    var connected = Date.now() - server.lastPing < FIGMA_TIMEOUT;
    setStatus(connected, connected ? "Connected" : "Figma Disconnected");
    $("badge").title = "Listening on 127.0.0.1:" + server.port + (connected ? " · Figma plugin connected" : " · waiting for the Figma plugin");
  }

  // Accordions (Groups / Managing / Audit Log): click the header to open/close; state persists per section.
  var ACC_KEY = "uiscoreBridge.accordions";
  var accState = {};
  try { accState = JSON.parse(window.localStorage.getItem(ACC_KEY) || "{}") || {}; } catch (e) { accState = {}; }
  function setAcc(sec, open) {
    sec.className = sec.className.replace(/\s*\bopen\b/g, "") + (open ? " open" : "");
    sec.querySelector(".acc-head").setAttribute("aria-expanded", open ? "true" : "false");
  }
  [].forEach.call(document.querySelectorAll(".acc"), function (sec) {
    var key = sec.getAttribute("data-acc");
    if (accState[key] !== undefined) setAcc(sec, !!accState[key]);
    sec.querySelector(".acc-head").onclick = function () {
      var open = !/\bopen\b/.test(sec.className);
      setAcc(sec, open); accState[key] = open;
      try { window.localStorage.setItem(ACC_KEY, JSON.stringify(accState)); } catch (e) {}
      if (open && key === "log") $("log").scrollTop = 1e9;
    };
  });

  if (!cep || !nodeRequire) {
    setStatus(false, "Bridge Offline");
    showAlert("Node.js is not enabled for this panel.", "Check --enable-nodejs and --mixed-context in CSXS/manifest.xml, then restart After Effects.");
    return;
  }
  var path = nodeRequire("path");
  var os = nodeRequire("os");
  var fs = nodeRequire("fs");

  function systemPath(kind) {
    var raw = decodeURIComponent(cep.getSystemPath(kind));
    if (/^file:\/\/\/[A-Za-z]:/.test(raw)) return raw.substr(8);
    return raw.replace(/^file:\/\//, "");
  }
  var extDir = path.normalize(systemPath("extension"));
  var env = {};
  try { env = JSON.parse(cep.getHostEnvironment()); } catch (e) {}
  var aeVersion = env.appVersion || "";

  function evalScript(script) {
    return new Promise(function (resolve) { cep.evalScript(script, function (res) { resolve(res); }); });
  }

  var G = nodeRequire(path.join(extDir, "host", "geom.jsx"));
  var bridgeLib = nodeRequire(path.join(extDir, "js", "server.js"));
  var ffx = nodeRequire(path.join(extDir, "js", "ffx.js"));
  var templatesDir = path.join(extDir, "assets", "gradient-templates");
  var defaultJobsRoot = path.join(os.homedir(), "Documents", "Uiscore Bridge");
  var lastJobsRoot = defaultJobsRoot;

  function ensureHost() {
    // "stale" = an older host without the layer tools is loaded in this AE session -> reload the files
    return evalScript('typeof UiscoreBridge === "object" && typeof UiscoreBridge.decompose === "function" ? "object" : "stale"').then(function (t) {
      if (t === "object") return true;
      var files = ["json.jsx", "geom.jsx", "builder.jsx"].map(function (f) { return path.join(extDir, "host", f).replace(/\\/g, "/"); });
      var script = files.map(function (f) { return "$.evalFile(" + JSON.stringify(f) + ");"; }).join("") + "typeof UiscoreBridge";
      return evalScript(script).then(function (t2) { if (t2 !== "object") { log("ExtendScript host failed to load: " + t2, "err"); showAlert("ExtendScript host failed to load.", String(t2)); } return t2 === "object"; });
    });
  }

  function resolveJobsRoot() {
    return evalScript("UiscoreBridge.projectFolder()").then(function (dir) {
      var root = dir && dir !== "undefined" && dir.indexOf("Error") !== 0 ? path.join(dir, "Uiscore Bridge") : defaultJobsRoot;
      fs.mkdirSync(root, { recursive: true });
      lastJobsRoot = root;
      return root;
    });
  }

  var bridge = null;
  function start() {
    bridge = bridgeLib.createBridge({
      port: PORT, geom: G, templatesDir: templatesDir, version: "0.1.0",
      getAeVersion: function () { return aeVersion; },
      resolveJobsRoot: resolveJobsRoot,
      evalScript: function (s) { return ensureHost().then(function () { return evalScript(s); }); },
      onPing: function () { var was = Date.now() - server.lastPing < FIGMA_TIMEOUT; server.lastPing = Date.now(); if (!was) { renderBadge(); log("Figma plugin connected."); } },
      log: function (level, msg) {
        log(msg, level === "error" ? "err" : (level === "warn" ? "warn" : ""));
        if (level === "error" && msg.indexOf("Import failed: ") === 0) showAlert("Import failed.", msg.substr(15));
        else if (level === "error") showAlert("Bridge error.", msg);
        else if (msg.indexOf("Imported: ") === 0) hideAlert();
      }
    });
    bridge.start(PORT).then(function (port) {
      server.up = true; server.port = port; renderBadge();
      log("Listening on 127.0.0.1:" + port, "ok");
      log("Ready. In Figma: Plugins > Development > Uiscore Bridge > Send to After Effects.", "ok");
    }).catch(function (e) {
      server.up = false;
      setStatus(false, "Bridge Offline");
      $("badge").title = e.code === "EADDRINUSE" ? "Port " + PORT + " is busy" : ("Server error: " + e.message);
      if (e.code === "EADDRINUSE") showAlert("Port " + PORT + " is busy.", "Another After Effects or Uiscore Bridge panel is already listening. Close it, then press Restart.");
      else showAlert("Bridge server failed to start.", String(e.message || e));
      log(String(e), "err");
    });
  }
  function restart() {
    server.up = false; setStatus(null, "Starting…"); hideAlert();
    if (bridge) bridge.stop().then(start, start); else start();
  }

  // The design has no meta line: keep it as the footer label's tooltip and as the first log line.
  var meta = "After Effects " + aeVersion + " · gradient presets: " + ffx.templateFamily(aeVersion) + " · port " + PORT;
  $("meta").title = meta;
  log(meta);
  setInterval(renderBadge, 2000);
  $("restart").onclick = restart;
  $("clear").onclick = function () { $("log").innerHTML = ""; };
  $("openJobs").onclick = function () {
    fs.mkdirSync(lastJobsRoot, { recursive: true });
    var cp = nodeRequire("child_process");
    if (process.platform === "win32") cp.exec('explorer "' + lastJobsRoot + '"'); else cp.exec('open "' + lastJobsRoot + '"');
  };
  $("sample").onclick = function () {
    var file = path.join(extDir, "examples", "sample-payload.json");
    var body = fs.readFileSync(file, "utf8");
    log("Posting bundled sample job to the bridge…");
    var http = nodeRequire("http");
    var req = http.request({ host: "127.0.0.1", port: PORT, path: "/import", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, function (res) {
      var chunks = []; res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var r = {}; try { r = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { r = { ok: false, error: "bad response" }; }
        log(r.ok ? ("Sample imported: " + r.summary) : ("Sample failed: " + r.error), r.ok ? "ok" : "err");
        if (r.ok) hideAlert(); else showAlert("Sample import failed.", r.error);
        (r.warnings || []).forEach(function (w) { log("⚠ " + w, "warn"); });
      });
    });
    req.on("error", function (e) { log("Sample request failed: " + e.message, "err"); showAlert("Sample import failed.", e.message); });
    req.end(body);
  };

  // Groups: Precomp / Decomp / Toggle run on the active comp's selected layers (host/builder.jsx, one undo group each).
  var TOOLS = { precomp: ["precompose", "Precomp"], decomp: ["decompose", "Decomp"], toggle: ["toggleVisibility", "Toggle"] };
  function runTool(id) {
    var fn = TOOLS[id][0], label = TOOLS[id][1], btn = $(id);
    if (btn.disabled) return;
    btn.disabled = true;
    ensureHost().then(function (ok) {
      if (!ok) throw new Error("ExtendScript host is not loaded.");
      return evalScript("UiscoreBridge." + fn + "()");
    }).then(function (raw) {
      var r;
      try { r = JSON.parse(raw); } catch (e) { r = { ok: false, error: "After Effects returned: " + String(raw).slice(0, 300) }; }
      (r.warnings || []).forEach(function (w) { log("⚠ " + w, "warn"); });
      if (r.ok) { log(r.summary, "ok"); hideAlert(); }
      else { log(label + " failed: " + r.error, "err"); showAlert(label + " failed.", r.error); }
    }).catch(function (e) {
      log(label + " failed: " + (e.message || e), "err"); showAlert(label + " failed.", String(e.message || e));
    }).then(function () { btn.disabled = false; });
  }
  Object.keys(TOOLS).forEach(function (id) { $(id).onclick = function () { runTool(id); }; });

  ensureHost().then(start);
})();
