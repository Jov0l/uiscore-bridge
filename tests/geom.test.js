const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../shared/geom.js");

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const closeArr = (a, b, eps = 1e-3) => { assert.equal(a.length, b.length); a.forEach((v, i) => close(v, b[i], eps)); };
const rot = (deg, x = 0, y = 0) => { const r = deg * Math.PI / 180; return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), x, y]; };

test("schema constants", () => {
  assert.equal(G.SCHEMA_ID, "uiscore.bridge.job");
  assert.equal(G.SCHEMA_VERSION, 1);
});

test("fromFigma / multiply / invert / relativeTo", () => {
  const m = G.fromFigma([[1, 0, 10], [0, 1, 20]]);
  assert.deepEqual(m, [1, 0, 0, 1, 10, 20]);
  const a = rot(30, 5, 7), b = [2, 0, 0, 3, 1, 1];
  const ab = G.multiply(a, b);
  closeArr(G.apply(ab, [1, 1]), G.apply(a, G.apply(b, [1, 1])));
  closeArr(G.multiply(a, G.invert(a)), [1, 0, 0, 1, 0, 0]);
  const parent = rot(15, 100, 50), child = G.multiply(parent, rot(30, 10, 0));
  const local = G.relativeTo(parent, child);
  closeArr(local, rot(30, 10, 0));
});

test("decompose: translation, rotation, scale, mirror, skew", () => {
  let d = G.decompose([1, 0, 0, 1, 12.5, 7]);
  assert.deepEqual(d.position, [12.5, 7]); assert.equal(d.rotation, 0); assert.deepEqual(d.scale, [1, 1]);
  d = G.decompose(rot(30, 4, 5));
  close(d.rotation, 30); closeArr(d.scale, [1, 1]); close(d.skew, 0);
  d = G.decompose(G.multiply(rot(-45), [2, 0, 0, 0.5, 0, 0]));
  close(d.rotation, -45); closeArr(d.scale, [2, 0.5]);
  d = G.decompose([1, 0, 0, -1, 0, 0]); // vertical flip
  closeArr(d.scale, [1, -1]); close(d.rotation, 0);
  d = G.decompose([-1, 0, 0, 1, 0, 0]); // horizontal flip -> 180deg + negative Y
  close(Math.abs(d.rotation), 180); closeArr(d.scale, [1, -1]);
  d = G.decompose([1, 0, 0.5, 1, 0, 0]);
  assert.ok(Math.abs(d.skew) > 1, "skew detected");
});

test("decompose round-trips through AE layer transform (anchor 0)", () => {
  for (const [deg, sx, sy] of [[0, 1, 1], [37, 1.5, 0.75], [-120, 2, 2], [90, 1, -1]]) {
    const m = G.multiply(rot(deg, 33, -12), [sx, 0, 0, sy, 0, 0]);
    const d = G.decompose(m);
    const back = G.multiply(rot(d.rotation, d.position[0], d.position[1]), [d.scale[0], 0, 0, d.scale[1], 0, 0]);
    closeArr(back, m, 1e-3);
  }
});

test("colors, hex, blend names", () => {
  assert.deepEqual(G.color({ r: 1, g: 0.5, b: 0 }), [1, 0.5, 0, 1]);
  assert.deepEqual(G.color({ r: 1, g: 0.5, b: 0, a: 0.5 }, 0.5), [1, 0.5, 0, 0.25]);
  assert.equal(G.toHex([1, 0.5, 0, 1]), "#ff8000");
  assert.equal(G.aeBlendName("LINEAR_DODGE"), "ADD");
  assert.equal(G.aeBlendName("PASS_THROUGH"), "NORMAL");
  assert.equal(G.aeBlendName("MULTIPLY"), "MULTIPLY");
  assert.equal(G.aeBlendName("WHATEVER"), "NORMAL");
});

test("parseSvgPath: lines, cubic tangents relative, close folds duplicate vertex", () => {
  const p = G.parseSvgPath("M 0 0 L 10 0 L 10 10 Z");
  assert.equal(p.length, 1); assert.equal(p[0].closed, true);
  assert.deepEqual(p[0].vertices, [[0, 0], [10, 0], [10, 10]]);
  const c = G.parseSvgPath("M 0 0 C 5 0 10 5 10 10 L 0 10 L 0 0 Z")[0];
  assert.equal(c.vertices.length, 3, "closing duplicate vertex folded");
  assert.deepEqual(c.outTangents[0], [5, 0]);
  assert.deepEqual(c.inTangents[1], [0, -5]);
  const open = G.parseSvgPath("M 0 7 L 7 14 L 20 0")[0];
  assert.equal(open.closed, false); assert.equal(open.vertices.length, 3);
  const multi = G.parseSvgPath("M0 0L1 0L1 1ZM5 5L6 5L6 6Z");
  assert.equal(multi.length, 2);
  const hv = G.parseSvgPath("M 0 0 H 10 V 10 H 0 Z")[0];
  assert.deepEqual(hv.vertices, [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test("roundedRectPath accepts number and per-corner radii, clamps", () => {
  const a = G.roundedRectPath(100, 40, 8), b = G.roundedRectPath(100, 40, [8, 8, 8, 8]);
  assert.deepEqual(a, b);
  const big = G.roundedRectPath(100, 40, 999);
  assert.deepEqual(big.vertices[0], [20, 0]);
  assert.equal(big.vertices.length, 8); assert.equal(big.closed, true);
});

test("stroke helpers", () => {
  assert.equal(G.lineCap("ROUND"), 2); assert.equal(G.lineCap("NONE"), 1); assert.equal(G.lineCap("SQUARE"), 3);
  assert.equal(G.lineJoin("BEVEL"), 3); assert.equal(G.lineJoin("MITER"), 1);
  assert.equal(G.strokeOffset("INSIDE", 4), -2); assert.equal(G.strokeOffset("OUTSIDE", 4), 2); assert.equal(G.strokeOffset("CENTER", 4), 0);
});

test("shadowToAE: direction clockwise from up, distance, opacity", () => {
  const s = G.shadowToAE({ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 8 }, radius: 16, spread: 0 });
  close(s.direction, 180); close(s.distance, 8); close(s.opacity, 0.25);
  const r = G.shadowToAE({ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 4, y: 0 }, radius: 0 });
  close(r.direction, 90);
  close(G.innerShadowAngle(0, 4), 90); // light from the top -> shadow below
});

test("text helpers", () => {
  close(G.trackingFromLetterSpacing({ unit: "PERCENT", value: -2 }, 24), -20);
  close(G.trackingFromLetterSpacing({ unit: "PIXELS", value: 2.4 }, 24), 100);
  assert.equal(G.leadingFromLineHeight({ unit: "AUTO" }, 24), null);
  close(G.leadingFromLineHeight({ unit: "PIXELS", value: 32 }, 24), 32);
  close(G.leadingFromLineHeight({ unit: "PERCENT", value: 150 }, 20), 30);
  assert.equal(G.justification("CENTER"), "CENTER_JUSTIFY");
  assert.equal(G.postScriptGuess({ family: "Inter", style: "Semi Bold" }), "Inter-SemiBold");
  assert.equal(G.postScriptGuess({ family: "Roboto Mono", style: "Regular" }), "RobotoMono-Regular");
});

test("exportScale: min(cap, 3500/longSide)", () => {
  assert.equal(G.exportScale(100, 50, 3), 3);
  close(G.exportScale(3500, 100, 3), 1);
  close(G.exportScale(7000, 100, 3), 0.5);
  assert.equal(G.exportScale(100, 100, 2), 2);
});

test("groupMasks: mask masks following siblings until next mask", () => {
  const n = (name, isMask) => ({ name, isMask: !!isMask });
  const items = G.groupMasks([n("a"), n("m1", 1), n("b"), n("c"), n("m2", 1), n("d")]);
  assert.deepEqual(items.map((i) => i.kind), ["node", "masked", "masked"]);
  assert.deepEqual(items[1].content.map((x) => x.name), ["b", "c"]);
  assert.equal(items[2].mask.name, "m2");
});

test("fitScale", () => {
  close(G.fitScale(400, 300, 1920, 1080), 360);
  close(G.fitScale(1920, 1080, 1920, 1080), 100);
});

test("textPlacement maps AE source rect to Figma box", () => {
  const t = { autoResize: "WIDTH_AND_HEIGHT", alignH: "LEFT", alignV: "TOP", size: 24, leading: 32 };
  const pl = G.textPlacement(t, { left: 0, top: -18, width: 120, height: 24 }, null, 120, 32);
  assert.equal(pl.anchor.length, 2); assert.equal(pl.local.length, 2);
  close(pl.local[0], 0); // left aligned
});
