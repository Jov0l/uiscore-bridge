const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const acorn = require("acorn");
const G = require("../shared/geom.js");
const { writeJobFolder } = require("../ae-extension/js/server.js");
const { createUBSerializer } = require("../figma-plugin/src/serializer.js");
const S = require("./helpers/figma-stub.js");
const F = require("./helpers/fixture.js");
const { createAE, describe } = require("./helpers/ae-mock.js");

const HOST = path.join(__dirname, "..", "ae-extension", "host");
const TPL = path.join(__dirname, "..", "ae-extension", "assets", "gradient-templates");

for (const f of ["builder.jsx", "json.jsx", "geom.jsx", "index.jsx"]) {
  test(`ES3 parse: host/${f}`, () => {
    const src = fs.readFileSync(path.join(HOST, f), "utf8").replace(/^#include .*$/gm, "");
    acorn.parse(src, { ecmaVersion: 3, sourceType: "script" });
  });
}

test("ES3 parse catches ES5+ syntax (sanity of the check itself)", () => {
  assert.throws(() => acorn.parse("var o = { a: 1, };", { ecmaVersion: 3 }));
  assert.throws(() => acorn.parse("let x = 1;", { ecmaVersion: 3 }));
});

test("host/geom.jsx is the build copy of shared/geom.js", () => {
  const built = fs.readFileSync(path.join(HOST, "geom.jsx"), "utf8").replace(/^\/\* GENERATED[^\n]*\n/, "");
  assert.equal(built, fs.readFileSync(path.join(__dirname, "..", "shared", "geom.js"), "utf8"), "run `npm run build`");
});

test("index.jsx includes json, geom, builder in order", () => {
  const inc = fs.readFileSync(path.join(HOST, "index.jsx"), "utf8").match(/#include\s+"([^"]+)"/g).map((s) => s.split('"')[1]);
  assert.deepEqual(inc, ["json.jsx", "geom.jsx", "builder.jsx"]);
});

test("UBJSON: parse / stringify round trip incl. unicode, escapes, numbers, nesting", () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(HOST, "json.jsx"), "utf8"), ctx);
  const sample = { a: [1, -2.5, 3e-7, 1e21, true, false, null], s: "Бодя \"q\" \\ \n\t\u2028 😀", o: { nested: { deep: [] } }, empty: {} };
  const parsed = vm.runInContext(`UBJSON.parse(${JSON.stringify(JSON.stringify(sample))})`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), sample);
  const str = vm.runInContext(`UBJSON.stringify(UBJSON.parse(${JSON.stringify(JSON.stringify(sample))}))`, ctx);
  assert.deepEqual(JSON.parse(str), sample);
  assert.throws(() => vm.runInContext("UBJSON.parse('{\"a\": alert(1)}')", ctx));
  assert.throws(() => vm.runInContext("UBJSON.parse('[1,2')", ctx));
});

async function jobOnDisk(opts, mutate) {
  const { job, images } = await createUBSerializer(S.figmaApi, G, opts || {}).serialize([F.buildCard()], { jobId: "host-test" });
  const payload = { job, images: {} };
  images.forEach((i) => { payload.images[i.id] = Buffer.from(i.bytes).toString("base64"); });
  if (mutate) mutate(payload);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ub-host-"));
  return writeJobFolder(payload, { geom: G, jobsRoot: root, aeVersion: "26.3", templatesDir: (opts && opts.templatesDir) || TPL });
}
function importInMock(jobFile, aeOpts) {
  const ae = createAE(aeOpts);
  const res = JSON.parse(ae.run(`UiscoreBridge.importJob(${JSON.stringify(jobFile)})`));
  const main = ae.items.find((i) => i instanceof ae.CompItem && i.name === "Card / Weekly");
  return { ae, res, main };
}
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm realm arrays -> this realm
const flat = (comp) => { const out = []; const w = (c) => c._layers.forEach((l) => { out.push(l); if (l.kind === "precomp") w(l.source); }); w(comp); return out; };

test("builder (mock AE): full sample imports without errors, every gradient native", async () => {
  const w = await jobOnDisk();
  const { ae, res, main } = importInMock(w.jobFile, { characterRange: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stats.gradientsNative, 6); assert.equal(res.stats.gradientsRamp, 1, "text gradient -> ramp");
  assert.equal(ae.log.presets.length, 6);
  assert.ok(ae.log.presets.every((p) => p.prop === "ADBE Vector Grad Colors" && /gradients\/g\d+_(fill|stroke)\.ffx$/.test(p.file.replace(/\\/g, "/"))));
  assert.deepEqual([...ae.log.unknownNames], [], "only ADBE matchnames used");
  assert.equal(ae.app._undo, 0, "undo group closed");
  // Layer order: Figma bottom->top == AE bottom->top
  const names = main._layers.map((l) => l.name).reverse();
  assert.deepEqual(names.slice(0, 4), ["Card / Weekly bg", "Background", "Hero gradient", "Rotated badge"]);
  assert.equal(names[names.length - 1], "*Noise texture");
  // rotation + position applied
  const badge = main._layers.find((l) => l.name === "Rotated badge");
  const tr = badge.property("ADBE Transform Group");
  assert.deepEqual(plain(tr.property("ADBE Position").value), [250, 40]);
  assert.ok(Math.abs(tr.property("ADBE Rotate Z").value + 12) < 1e-3);
  // outside gradient stroke -> separate group with Offset Paths
  const root = badge.property("ADBE Root Vectors Group");
  assert.match(root.property(1).name, /Stroke \(outside\)/);
  // G-Fill configured
  const hero = main._layers.find((l) => l.name === "Hero gradient");
  const gfill = hero.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").children.find((c) => c.matchName === "ADBE Vector Graphic - G-Fill");
  assert.equal(gfill.property("ADBE Vector Grad Type").value, 1);
  assert.ok(String(gfill.property("ADBE Vector Grad Colors").value).startsWith("preset:"));
  const orb = main._layers.find((l) => l.name === "Orb");
  const og = orb.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").children.find((c) => c.matchName === "ADBE Vector Graphic - G-Fill");
  assert.equal(og.property("ADBE Vector Grad Type").value, 2);
  assert.deepEqual(plain(og.property("ADBE Vector Grad Start Pt").value), [32, 32]);
  // mask -> track matte, effects, images
  const all = flat(main);
  const masked = all.find((l) => l.name === "Masked by Mask circle");
  assert.equal(masked.trackMatte.layer.name, "Mask circle"); assert.equal(masked.trackMatte.type, "ALPHA");
  assert.ok(main._layers.find((l) => l.name === "Background").property("ADBE Effect Parade").children.some((c) => c.matchName === "ADBE Drop Shadow"));
  assert.equal(main._layers.find((l) => l.name === "Avatar photo").kind, "footage");
  assert.match(res.summary, /6 native/);
});

test("builder: missing preset files -> Gradient Ramp fallback with warnings, never raster", async () => {
  const w = await jobOnDisk();
  for (const f of fs.readdirSync(path.join(w.jobDir, "gradients"))) fs.unlinkSync(path.join(w.jobDir, "gradients", f));
  const { res, main } = importInMock(w.jobFile, { characterRange: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stats.gradientsNative, 0); assert.equal(res.stats.gradientsRamp, 7);
  assert.ok(res.warnings.some((x) => /Gradient Ramp fallback/.test(x)));
  const hero = main._layers.find((l) => l.name === "Hero gradient");
  const fx = hero.property("ADBE Effect Parade").children.map((c) => c.matchName);
  assert.deepEqual(fx, ["ADBE Ramp", "ADBE Set Matte3"]);
  assert.equal(res.stats.images, 2, "only the two real rasters are images");
});

test("builder: preset writer failure (ffxError) -> ramp with reason in warning", async () => {
  const w = await jobOnDisk({}, null);
  const job = JSON.parse(fs.readFileSync(w.jobFile, "utf8"));
  const hero = job.comps[0].root.children.find((c) => c.name === "Hero gradient");
  delete hero.fills[0].ffx; hero.fills[0].ffxError = "template missing";
  fs.writeFileSync(w.jobFile, JSON.stringify(job));
  const { res } = importInMock(w.jobFile, { characterRange: true });
  assert.equal(res.stats.gradientsNative, 5);
  assert.ok(res.warnings.some((x) => /template missing/.test(x)));
});

test("builder: legacy track matte path (AE < 23) and no characterRange", async () => {
  const w = await jobOnDisk();
  const { res, main } = importInMock(w.jobFile, { legacyMatte: true, characterRange: false });
  assert.equal(res.ok, true, res.error);
  const all = flat(main);
  const masked = all.find((l) => l.name === "Masked by Mask circle");
  assert.equal(masked.trackMatteType, "ALPHA");
  const idx = masked.comp._layers.indexOf(masked);
  assert.equal(masked.comp._layers[idx - 1].name, "Mask circle", "matte directly above");
  assert.ok(res.warnings.some((x) => /Mixed text styles flattened/.test(x)));
});

test("builder: groupsAs=parent builds a null with parented children", async () => {
  const w = await jobOnDisk({ groupsAs: "parent" });
  const { res, main } = importInMock(w.jobFile, { characterRange: true });
  assert.equal(res.ok, true, res.error);
  const nul = main._layers.find((l) => l.kind === "null");
  assert.ok(nul && /Dots/.test(nul.name));
  const kids = main._layers.filter((l) => l.parent === nul).map((l) => l.name).sort();
  assert.deepEqual(kids, ["Dot A", "Dot B"]);
  const a = main._layers.find((l) => l.name === "Dot A");
  assert.deepEqual(plain(a.property("ADBE Transform Group").property("ADBE Position").value), [0, 0]);
});

test("builder: compMode=active nests the comp scaled to fit", async () => {
  const w = await jobOnDisk({ compMode: "active" });
  const ae = createAE({ characterRange: true });
  const target = ae.project.items.addComp("Main 1920", 1920, 1080, 1, 10, 30);
  ae.project.activeItem = target;
  const res = JSON.parse(ae.run(`UiscoreBridge.importJob(${JSON.stringify(w.jobFile)})`));
  assert.equal(res.ok, true, res.error);
  assert.equal(target._layers.length, 1);
  assert.deepEqual(plain(target._layers[0].property("ADBE Transform Group").property("ADBE Scale").value), [450, 450]);
});

test("builder: clipping rounded frame gets a layer mask; non-clipping frame collapses", async () => {
  const inner = S.node("RECTANGLE", { name: "Fill", width: 50, height: 50, fills: [S.solid(1, 0, 0)] });
  const clip = S.node("FRAME", { name: "Clip", width: 50, height: 50, rel: [1, 0, 0, 1, 10, 10], clipsContent: true, cornerRadius: 12, fills: [] }, [inner]);
  const free = S.node("FRAME", { name: "Free", width: 50, height: 50, rel: [1, 0, 0, 1, 80, 10], clipsContent: false, fills: [] }, [S.node("RECTANGLE", { name: "R2", width: 10, height: 10 })]);
  const frame = S.finalize(S.node("FRAME", { name: "Card / Weekly", width: 200, height: 100, fills: [] }, [clip, free]));
  const { job } = await createUBSerializer(S.figmaApi, G, {}).serialize([frame], {});
  const w = writeJobFolder({ job, images: {} }, { geom: G, jobsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ub-")), aeVersion: "26.3", templatesDir: TPL });
  const { res, main } = importInMock(w.jobFile, {});
  assert.equal(res.ok, true, res.error);
  const c = main._layers.find((l) => l.name === "Clip");
  assert.equal(c.collapseTransformation, false);
  assert.equal(c.property("ADBE Mask Parade").numProperties, 1);
  assert.equal(main._layers.find((l) => l.name === "Free").collapseTransformation, true);
});

test("builder: reports errors as ok:false JSON instead of throwing", () => {
  const ae = createAE({});
  const res = JSON.parse(ae.run(`UiscoreBridge.importJob("/definitely/missing/job.json")`));
  assert.equal(res.ok, false); assert.match(res.error, /Cannot open|missing/);
});
