const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const G = require("../shared/geom.js");
const { createBridge, hostCall, DEFAULT_PORT, slug } = require("../ae-extension/js/server.js");
const { createUBSerializer } = require("../figma-plugin/src/serializer.js");
const S = require("./helpers/figma-stub.js");
const F = require("./helpers/fixture.js");

const TPL = path.join(__dirname, "..", "ae-extension", "assets", "gradient-templates");

async function makePayload() {
  const { job, images } = await createUBSerializer(S.figmaApi, G, {}).serialize([F.buildCard()], { jobId: "bridge-test" });
  const payload = { job, images: {} };
  images.forEach((i) => { payload.images[i.id] = Buffer.from(i.bytes).toString("base64"); });
  return { payload, images };
}

async function withBridge(fn, over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ub-bridge-"));
  const calls = [];
  const logs = [];
  const bridge = createBridge(Object.assign({
    geom: G, templatesDir: TPL, version: "0.1.0",
    getAeVersion: () => "25.2.1",
    resolveJobsRoot: async () => root,
    evalScript: async (script) => { calls.push(script); return JSON.stringify({ ok: true, summary: "stub", comps: ["Card / Weekly"], warnings: ["host warning"] }); },
    log: (lvl, msg) => logs.push([lvl, msg])
  }, over || {}));
  const port = await bridge.start(0);
  try { await fn({ base: `http://127.0.0.1:${port}`, root, calls, logs, bridge }); } finally { await bridge.stop(); }
}

test("default port is 7341", () => { assert.equal(DEFAULT_PORT, 7341); });

test("GET /ping returns identity + CORS headers", async () => {
  await withBridge(async ({ base }) => {
    const r = await fetch(base + "/ping", { headers: { Origin: "null" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("access-control-allow-private-network"), "true");
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.app, "uiscore-bridge"); assert.equal(j.schema, "uiscore.bridge.job");
    assert.equal(j.host.version, "25.2.1");
  });
});

test("OPTIONS preflight answers 204 with CORS + private network headers", async () => {
  await withBridge(async ({ base }) => {
    const r = await fetch(base + "/import", { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true" } });
    assert.equal(r.status, 204);
    assert.match(r.headers.get("access-control-allow-methods"), /POST/);
    assert.match(r.headers.get("access-control-allow-headers"), /Content-Type/);
    assert.equal(r.headers.get("access-control-allow-private-network"), "true");
  });
});

test("POST /import (text/plain like the Figma UI) writes images, gradients, job.json and calls evalScript with that path", async () => {
  const { payload, images } = await makePayload();
  await withBridge(async ({ base, root, calls }) => {
    const r = await fetch(base + "/import", { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(payload) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.ok, true);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    // job folder layout
    assert.equal(path.dirname(j.jobDir), root);
    assert.match(path.basename(j.jobDir), /^\d{8}-\d{6}-Card-Weekly$/);
    for (const im of images) {
      const f = path.join(j.jobDir, "images", im.id + ".png");
      assert.ok(fs.existsSync(f), f);
      assert.ok(fs.readFileSync(f).equals(Buffer.from(im.bytes)), "png bytes identical");
    }
    const gfiles = fs.readdirSync(path.join(j.jobDir, "gradients"));
    assert.equal(gfiles.length, 6); assert.ok(gfiles.includes("g1_fill.ffx")); assert.ok(gfiles.some((f) => f.endsWith("_stroke.ffx")));
    assert.equal(j.stats.gradients, 6); assert.equal(j.stats.images, 2);
    const job = JSON.parse(fs.readFileSync(j.jobFile, "utf8"));
    assert.equal(job.bridge.jobDir, j.jobDir); assert.equal(job.bridge.aeVersion, "25.2.1");
    assert.equal(job.assets.images.img_1.path, path.join(j.jobDir, "images", "img_1.png"));
    const hero = job.comps[0].root.children.find((c) => c.name === "Hero gradient").fills[0];
    assert.equal(hero.ffxFamily, "ae25-6"); assert.ok(fs.existsSync(hero.ffx));
    const body = job.comps[0].root.children.find((c) => c.name === "Body");
    assert.equal(body.text.fills[0].ffx, undefined, "text gradients get no preset");
    // evalScript called exactly once with the job path
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `UiscoreBridge.importJob(${JSON.stringify(j.jobFile)})`);
    // Figma-side (serializer) warnings are merged in front of host warnings
    assert.equal(j.warnings[j.warnings.length - 1], "host warning");
    assert.ok(j.warnings.slice(0, -1).every((w) => w.startsWith("[Figma] ")));
    assert.ok(j.warnings.some((w) => /Elliptical glow/.test(w)));
  });
});

test("hostCall produces a valid ExtendScript string literal for Windows paths with quotes", () => {
  const p = "C:\\Users\\Бодя\\Documents\\Uiscore Bridge\\20260101-000000-My \"Frame\"\\job.json";
  const script = hostCall(p);
  let got = null;
  vm.runInNewContext(script, { UiscoreBridge: { importJob: (x) => { got = x; } } });
  assert.equal(got, p);
});

test("bad requests: invalid JSON 400, wrong schema 500, unknown route 404, bad image id rejected", async () => {
  await withBridge(async ({ base, calls }) => {
    let r = await fetch(base + "/import", { method: "POST", body: "{nope" });
    assert.equal(r.status, 400);
    r = await fetch(base + "/import", { method: "POST", body: JSON.stringify({ job: { schema: "aeux", comps: [{}] } }) });
    assert.equal(r.status, 500); assert.match((await r.json()).error, /Unknown schema/);
    r = await fetch(base + "/nothing");
    assert.equal(r.status, 404);
    const { payload } = await makePayload();
    payload.images["../evil"] = "AAAA";
    r = await fetch(base + "/import", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(r.status, 500); assert.match((await r.json()).error, /Bad image id/);
    assert.equal(calls.length, 0, "AE never called for rejected jobs");
  });
});

test("host failure is reported as ok:false with the host error", async () => {
  const { payload } = await makePayload();
  await withBridge(async ({ base }) => {
    const r = await fetch(base + "/import", { method: "POST", body: JSON.stringify(payload) });
    const j = await r.json();
    assert.equal(r.status, 500); assert.equal(j.ok, false); assert.match(j.error, /boom/);
  }, { evalScript: async () => JSON.stringify({ ok: false, error: "Error: boom" }) });
});

test("non-JSON host output (e.g. EvalScript error) is surfaced", async () => {
  const { payload } = await makePayload();
  await withBridge(async ({ base }) => {
    const r = await fetch(base + "/import", { method: "POST", body: JSON.stringify(payload) });
    const j = await r.json();
    assert.equal(j.ok, false); assert.match(j.error, /EvalScript error/);
  }, { evalScript: async () => "EvalScript error." });
});

test("imports are queued: concurrent posts run evalScript one at a time", async () => {
  const { payload } = await makePayload();
  let running = 0, maxRunning = 0;
  await withBridge(async ({ base }) => {
    const posts = [1, 2, 3].map(() => fetch(base + "/import", { method: "POST", body: JSON.stringify(payload) }).then((r) => r.json()));
    const res = await Promise.all(posts);
    assert.ok(res.every((r) => r.ok));
    assert.equal(new Set(res.map((r) => r.jobDir)).size, 3, "unique job folders");
    assert.equal(maxRunning, 1);
  }, { evalScript: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 30)); running--; return JSON.stringify({ ok: true }); } });
});

test("slug keeps folder names safe", () => {
  assert.equal(slug("Card / Weekly"), "Card-Weekly");
  assert.equal(slug("../../etc"), "etc");
  assert.equal(slug(""), "frame");
});
