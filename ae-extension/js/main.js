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
  function setStatus(on, text) { $("dot").className = "dot " + (on ? "on" : "off"); $("status").textContent = text; }

  if (!cep || !nodeRequire) {
    setStatus(false, "Node.js is not enabled for this panel (check CSXS/manifest.xml).");
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
    return evalScript("typeof UiscoreBridge").then(function (t) {
      if (t === "object") return true;
      var files = ["json.jsx", "geom.jsx", "builder.jsx"].map(function (f) { return path.join(extDir, "host", f).replace(/\\/g, "/"); });
      var script = files.map(function (f) { return "$.evalFile(" + JSON.stringify(f) + ");"; }).join("") + "typeof UiscoreBridge";
      return evalScript(script).then(function (t2) { if (t2 !== "object") log("ExtendScript host failed to load: " + t2, "err"); return t2 === "object"; });
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
      log: function (level, msg) { log(msg, level === "error" ? "err" : (level === "warn" ? "warn" : "")); }
    });
    bridge.start(PORT).then(function (port) {
      setStatus(true, "Listening on 127.0.0.1:" + port);
      log("Ready. In Figma: Plugins > Development > Uiscore Bridge > Send to After Effects.", "ok");
    }).catch(function (e) {
      setStatus(false, e.code === "EADDRINUSE" ? "Port " + PORT + " is busy (another After Effects / panel instance?)" : ("Server error: " + e.message));
      log(String(e), "err");
    });
  }
  function restart() {
    if (bridge) bridge.stop().then(start, start); else start();
  }

  $("meta").textContent = "After Effects " + aeVersion + " · gradient presets: " + ffx.templateFamily(aeVersion) + " · port " + PORT;
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
        (r.warnings || []).forEach(function (w) { log("⚠ " + w, "warn"); });
      });
    });
    req.on("error", function (e) { log("Sample request failed: " + e.message, "err"); });
    req.end(body);
  };

  ensureHost().then(start);
})();
