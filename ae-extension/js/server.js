/*
 * Uiscore Bridge - local HTTP bridge (runs in the CEP panel's Node context; plain Node for tests).
 *   GET  /ping    -> status JSON
 *   POST /import  -> { job, images: { assetId: base64Png } }  => writes job folder, builds .ffx gradients,
 *                    calls ExtendScript UiscoreBridge.importJob(<job.json path>) and returns its result.
 * Listens on 127.0.0.1 only. CORS is open because the Figma plugin iframe has a "null" origin.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const ffx = require("./ffx.js");

const DEFAULT_PORT = 7341;
const MAX_BODY = 1024 * 1024 * 1024; // 1 GB
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
}

function sendJson(req, res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) }, corsHeaders(req)));
  res.end(body);
}

function slug(s) {
  return String(s || "frame").normalize("NFKD").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "frame";
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** Walk every node of every comp. */
function eachNode(job, fn) {
  const walk = (n) => { fn(n); (n.children || []).forEach(walk); };
  (job.comps || []).forEach((c) => walk(c.root));
}

function validateJob(job, schemaId, schemaVersion) {
  if (!job || typeof job !== "object") throw new Error("Missing job");
  if (job.schema !== schemaId) throw new Error("Unknown schema '" + job.schema + "' (expected " + schemaId + ")");
  if (job.version > schemaVersion) throw new Error("Job schema v" + job.version + " is newer than this panel (v" + schemaVersion + "). Update the AE extension.");
  if (!Array.isArray(job.comps) || !job.comps.length) throw new Error("Job has no frames");
}

/**
 * Write job folder: images/*.png, gradients/*.ffx, job.json. Returns { jobDir, jobFile, stats }.
 * Pure filesystem + data; does not talk to AE.
 */
function writeJobFolder(payload, opts) {
  const G = opts.geom;
  const job = payload.job;
  validateJob(job, G.SCHEMA_ID, G.SCHEMA_VERSION);
  const name = stamp(opts.now || new Date()) + "-" + slug(job.comps[0].name);
  let jobDir = path.join(opts.jobsRoot, name);
  let n = 2;
  while (fs.existsSync(jobDir)) jobDir = path.join(opts.jobsRoot, name + "-" + n++);
  fs.mkdirSync(path.join(jobDir, "images"), { recursive: true });

  const stats = { images: 0, gradients: 0, gradientErrors: [] };
  const images = payload.images || {};
  job.assets = job.assets || { images: {} };
  for (const id of Object.keys(images)) {
    if (!SAFE_ID.test(id)) throw new Error("Bad image id: " + id);
    const file = path.join(jobDir, "images", id + ".png");
    fs.writeFileSync(file, Buffer.from(images[id], "base64"));
    job.assets.images[id] = Object.assign({}, job.assets.images[id] || {}, { file: id + ".png", path: file });
    stats.images++;
  }

  // Native editable gradients: one preset per gradient paint (fills + strokes; text uses Gradient Ramp).
  let g = 0;
  eachNode(job, (node) => {
    const lists = [["fill", node.fills || []], ["stroke", (node.strokes && node.strokes.paints) || []]];
    if (node.type === "text") return;
    for (const [kind, paints] of lists) {
      for (const paint of paints) {
        if (paint.type !== "gradient" || !paint.split) continue;
        if (!g) fs.mkdirSync(path.join(jobDir, "gradients"), { recursive: true });
        const outFile = path.join(jobDir, "gradients", "g" + (++g) + "_" + kind + ".ffx");
        try {
          const r = ffx.writeGradientFfx({ geom: G, split: paint.split, kind, aeVersion: opts.aeVersion, templatesDir: opts.templatesDir, outFile });
          paint.ffx = outFile;
          paint.ffxFamily = r.family;
          stats.gradients++;
        } catch (e) {
          paint.ffxError = String(e.message || e);
          stats.gradientErrors.push(node.name + ": " + paint.ffxError);
        }
      }
    }
  });

  job.bridge = { jobDir, writtenAt: new Date().toISOString(), aeVersion: opts.aeVersion || null };
  const jobFile = path.join(jobDir, "job.json");
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 1));
  return { jobDir, jobFile, stats };
}

/** ExtendScript call for a job file. JSON.stringify yields a valid ES3 string literal (escapes \ and "). */
function hostCall(jobFile) {
  return "UiscoreBridge.importJob(" + JSON.stringify(jobFile) + ")";
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on("data", (c) => {
      len += c.length;
      if (len > limit) { reject(new Error("Payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * opts: { port, host, geom, templatesDir, getAeVersion(), resolveJobsRoot(): Promise<string>,
 *         evalScript(script): Promise<string>, log(level, msg), version, onPing() (optional, called on every GET /ping) }
 */
function createBridge(opts) {
  const log = opts.log || (() => {});
  let queue = Promise.resolve();
  let lastResult = null;

  async function handleImport(req, res) {
    const raw = await readBody(req, opts.maxBody || MAX_BODY);
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); } catch (e) { return sendJson(req, res, 400, { ok: false, error: "Invalid JSON: " + e.message }); }
    const run = async () => {
      const jobsRoot = await opts.resolveJobsRoot();
      const written = writeJobFolder(payload, { geom: opts.geom, jobsRoot, aeVersion: opts.getAeVersion ? opts.getAeVersion() : null, templatesDir: opts.templatesDir });
      log("info", "Job written: " + written.jobDir + " (" + written.stats.images + " images, " + written.stats.gradients + " gradients)");
      const raw = await opts.evalScript(hostCall(written.jobFile));
      let host;
      try { host = JSON.parse(raw); } catch (e) { host = { ok: false, error: "Host returned: " + String(raw).slice(0, 500) }; }
      const figmaWarnings = ((payload.job && payload.job.warnings) || []).map((w) => "[Figma] " + (w.name ? w.name + ": " : "") + w.message);
      const warnings = [].concat(figmaWarnings, written.stats.gradientErrors.map((m) => "Gradient preset not written (" + m + ")"), host.warnings || []);
      return Object.assign({}, host, { ok: host.ok !== false, jobDir: written.jobDir, jobFile: written.jobFile, stats: written.stats, warnings });
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    try {
      const result = await p;
      lastResult = result;
      log(result.ok ? "info" : "error", result.ok ? ("Imported: " + (result.summary || "")) : ("Import failed: " + result.error));
      (result.warnings || []).forEach((w) => log("warn", w));
      sendJson(req, res, result.ok ? 200 : 500, result);
    } catch (e) {
      lastResult = { ok: false, error: String(e.message || e) };
      log("error", "Import failed: " + lastResult.error);
      sendJson(req, res, 500, lastResult);
    }
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); return res.end(); }
    if (req.method === "GET" && url === "/ping") {
      if (opts.onPing) { try { opts.onPing(); } catch (e) {} }
      return sendJson(req, res, 200, { ok: true, app: "uiscore-bridge", version: opts.version || "0.1.0", schema: opts.geom.SCHEMA_ID, schemaVersion: opts.geom.SCHEMA_VERSION, host: { app: "AEFT", version: opts.getAeVersion ? opts.getAeVersion() : null } });
    }
    if (req.method === "POST" && url === "/import") {
      return handleImport(req, res).catch((e) => sendJson(req, res, 500, { ok: false, error: String(e.message || e) }));
    }
    sendJson(req, res, 404, { ok: false, error: "Not found" });
  });

  let server6 = null;
  return {
    server,
    lastResult: () => lastResult,
    start: (port) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port === undefined ? (opts.port || DEFAULT_PORT) : port, opts.host || "127.0.0.1", () => {
        server.removeListener("error", reject);
        const bound = server.address().port;
        // Figma only allows "localhost" in manifest networkAccess; on Windows localhost may resolve to ::1 first,
        // so also listen on IPv6 loopback (best-effort, ignored if IPv6 is unavailable).
        if (!opts.host) {
          try {
            server6 = http.createServer(server.listeners("request")[0]);
            server6.on("error", () => { server6 = null; });
            server6.listen(bound, "::1");
          } catch (e) { server6 = null; }
        }
        resolve(bound);
      });
    }),
    stop: () => new Promise((resolve) => { if (server6) { try { server6.close(); } catch (e) {} server6 = null; } server.close(() => resolve()); })
  };
}

module.exports = { createBridge, writeJobFolder, hostCall, corsHeaders, DEFAULT_PORT, slug };
