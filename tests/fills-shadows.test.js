/* Builder (mock AE): one shape layer per fill with per-fill blend modes, and drop shadows with spread
 * drawn as their own blurred shape layers below the object. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("../shared/geom.js");
const { writeJobFolder } = require("../ae-extension/js/server.js");
const { createUBSerializer } = require("../figma-plugin/src/serializer.js");
const S = require("./helpers/figma-stub.js");
const { createAE } = require("./helpers/ae-mock.js");
const TPL = path.join(__dirname, "..", "ae-extension", "assets", "gradient-templates");

async function importNodes(kids, frameProps) {
  const frame = S.finalize(S.node("FRAME", Object.assign({ name: "Test frame", width: 300, height: 200, fills: [S.solid(1, 1, 1)] }, frameProps || {}), kids));
  const { job, images } = await createUBSerializer(S.figmaApi, G, {}).serialize([frame], { jobId: "fs" });
  const payload = { job, images: {} };
  images.forEach((i) => { payload.images[i.id] = Buffer.from(i.bytes).toString("base64"); });
  const w = writeJobFolder(payload, { geom: G, jobsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ub-fs-")), aeVersion: "26.3", templatesDir: TPL });
  const ae = createAE();
  const res = JSON.parse(ae.run(`UiscoreBridge.importJob(${JSON.stringify(w.jobFile)})`));
  assert.equal(res.ok, true, res.error);
  const main = ae.items.find((i) => i instanceof ae.CompItem && i.name === "Test frame");
  return { ae, res, main, names: main._layers.map((l) => l.name).reverse() }; // bottom -> top
}
const T = (l, k) => l.property("ADBE Transform Group").property(k).value;
const contents = (l) => l.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").children;
const warnText = (res) => res.warnings.map((w) => w.message || w).join("\n");

test("fills: 2-fill rect -> 2 layers, bottom fill first, blend modes per layer, stroke on top", async () => {
  const r = S.node("RECTANGLE", { name: "Card", width: 100, height: 60, rel: [1, 0, 0, 1, 20, 30],
    fills: [S.solid(0.2, 0.3, 0.9), S.solid(1, 1, 1, 0.5, { blendMode: "SOFT_LIGHT" })],
    strokes: [S.solid(0, 0, 0)], strokeWeight: 1, strokeAlign: "CENTER" });
  const { res, main, names } = await importNodes([r]);
  assert.deepEqual(names.slice(1), ["Card fill 1", "Card fill 2"]);
  const f1 = main._layers.find((l) => l.name === "Card fill 1"), f2 = main._layers.find((l) => l.name === "Card fill 2");
  assert.equal(f1.blendingMode, "NORMAL"); assert.equal(f2.blendingMode, "SOFT_LIGHT");
  assert.deepEqual(JSON.parse(JSON.stringify(T(f1, "ADBE Position"))), [20, 30]); assert.deepEqual(JSON.parse(JSON.stringify(T(f2, "ADBE Position"))), [20, 30]);
  const fillsOf = (l) => contents(l).filter((c) => c.matchName === "ADBE Vector Graphic - Fill");
  assert.equal(fillsOf(f1).length, 1); assert.equal(fillsOf(f2).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fillsOf(f1)[0].property("ADBE Vector Fill Color").value)), [0.2, 0.3, 0.9, 1]);
  assert.ok(!contents(f1).some((c) => c.matchName === "ADBE Vector Graphic - Stroke"), "no stroke on the bottom fill");
  assert.ok(contents(f2).some((c) => c.matchName === "ADBE Vector Graphic - Stroke"), "stroke on the top fill layer");
  assert.doesNotMatch(warnText(res), /blend/i);
});

test("fills: single SOFT_LIGHT fill on an ellipse -> one layer with SOFT_LIGHT, no warning; plain single fill unchanged", async () => {
  const e = S.node("ELLIPSE", { name: "Glow", width: 40, height: 40, fills: [S.solid(1, 0.8, 0.2, 1, { blendMode: "SOFT_LIGHT" })],
    arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 } });
  const p = S.node("RECTANGLE", { name: "Plain", width: 10, height: 10, fills: [S.solid(0, 0, 0)] });
  const d = S.node("RECTANGLE", { name: "Dodge", width: 10, height: 10, fills: [S.solid(0, 0, 0), S.solid(1, 1, 1, 1, { blendMode: "LINEAR_DODGE" })] });
  const { res, main, names } = await importNodes([e, p, d]);
  assert.deepEqual(names.slice(1), ["Glow", "Plain", "Dodge fill 1", "Dodge fill 2"]);
  assert.equal(main._layers.find((l) => l.name === "Glow").blendingMode, "SOFT_LIGHT");
  assert.equal(main._layers.find((l) => l.name === "Plain").blendingMode, "NORMAL");
  assert.equal(main._layers.find((l) => l.name === "Dodge fill 2").blendingMode, "ADD", "LINEAR_DODGE -> ADD");
  assert.doesNotMatch(warnText(res), /blend/i);
});

test("fills: hidden fills don't create layers; frame background with 2 fills is split too", async () => {
  const r = S.node("RECTANGLE", { name: "One", width: 10, height: 10, fills: [S.solid(0, 0, 0), S.solid(1, 0, 0, 1, { visible: false })] });
  const inner = S.node("FRAME", { name: "Panel", width: 80, height: 50, fills: [S.solid(0.1, 0.1, 0.1), S.solid(1, 1, 1, 0.2, { blendMode: "OVERLAY" })] }, [r]);
  const { ae, main } = await importNodes([inner]);
  const panel = ae.items.find((i) => i instanceof ae.CompItem && i.name === "Panel");
  const pn = panel._layers.map((l) => l.name).reverse();
  assert.deepEqual(pn, ["Panel bg fill 1", "Panel bg fill 2", "One"]);
  assert.equal(panel._layers.find((l) => l.name === "Panel bg fill 2").blendingMode, "OVERLAY");
  assert.ok(main);
});

test("shadows: spread -12 -> shadow shape layer right below the object (Offset -12, round join, blur, offset); spread 0 -> Drop Shadow effect", async () => {
  const shadow = (spread, y) => ({ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y }, radius: 24, spread, blendMode: "NORMAL", showShadowBehindNode: false });
  const r = S.node("RECTANGLE", { name: "Btn", width: 120, height: 40, rel: [1, 0, 0, 1, 50, 60], cornerRadius: 8, opacity: 0.8,
    fills: [S.solid(0.2, 0.2, 0.9), S.solid(1, 1, 1, 0.3, { blendMode: "SCREEN" })], effects: [shadow(-12, 16), shadow(4, 2), shadow(0, 1)] });
  const { res, main, names } = await importNodes([r]);
  assert.deepEqual(names.slice(1), ["Btn shadow 1", "Btn shadow 2", "Btn fill 1", "Btn fill 2"], "shadows below the lowest fill, first shadow lowest");
  const s1 = main._layers.find((l) => l.name === "Btn shadow 1");
  const c = contents(s1);
  const off = c.find((x) => x.matchName === "ADBE Vector Filter - Offset");
  assert.equal(off.property("ADBE Vector Offset Amount").value, -12);
  assert.equal(off.property("ADBE Vector Offset Line Join").value, 2);
  assert.ok(c.findIndex((x) => x.matchName === "ADBE Vector Shape - Rect") < c.indexOf(off), "path before Offset Paths");
  const fill = c.find((x) => x.matchName === "ADBE Vector Graphic - Fill");
  assert.ok(c.indexOf(off) < c.indexOf(fill), "Offset Paths before the fill");
  assert.equal(fill.property("ADBE Vector Fill Opacity").value, 30);
  const grp = s1.property("ADBE Root Vectors Group").property(1);
  assert.deepEqual(JSON.parse(JSON.stringify(grp.property("ADBE Vector Transform Group").property("ADBE Vector Position").value)), [0, 16]);
  const blur = s1.property("ADBE Effect Parade").children.find((x) => x.matchName === "ADBE Gaussian Blur 2");
  assert.equal(blur.property("ADBE Gaussian Blur 2-0001").value, 24);
  assert.equal(blur.property("ADBE Gaussian Blur 2-0003").value, 0, "Repeat Edge Pixels off");
  assert.deepEqual(JSON.parse(JSON.stringify(T(s1, "ADBE Position"))), [50, 60]);
  assert.equal(T(s1, "ADBE Opacity"), 80, "inherits the object's opacity");
  // spread 0 -> classic Drop Shadow on the bottom fill layer only
  const f1 = main._layers.find((l) => l.name === "Btn fill 1"), f2 = main._layers.find((l) => l.name === "Btn fill 2");
  assert.equal(f1.property("ADBE Effect Parade").children.filter((x) => x.matchName === "ADBE Drop Shadow").length, 1);
  assert.equal(f2.property("ADBE Effect Parade").children.length, 0);
  assert.doesNotMatch(warnText(res), /spread/i);
});

test("shadows: spread on a text layer falls back to Drop Shadow with a warning", async () => {
  const t = S.textNode({ name: "Title", characters: "Hello", width: 60, height: 32, effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4, spread: 3, blendMode: "NORMAL" }] });
  const { res, names } = await importNodes([t]);
  assert.ok(!names.some((n) => /shadow/.test(n)));
  assert.match(warnText(res), /spread 3 is not supported on this layer type/);
});
