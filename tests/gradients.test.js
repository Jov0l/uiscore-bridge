const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("../shared/geom.js");
const ffx = require("../ae-extension/js/ffx.js");

const TPL = path.join(__dirname, "..", "ae-extension", "assets", "gradient-templates");
const close = (a, b, eps = 0.02) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const closePt = (a, b, eps = 0.02) => { close(a[0], b[0], eps); close(a[1], b[1], eps); };
const st = (position, r, g, b, a = 1) => ({ position, color: { r, g, b, a } });
const T = (m) => [[m[0], m[2], m[4]], [m[1], m[3], m[5]]]; // flat -> Figma Transform

// Parse stops back out of an AE prop.map XML (independent of the writer).
function parseXmlStops(xml) {
  const block = (kind) => {
    const re = new RegExp("<key>Stops " + kind + "</key>\\s*<array>\\s*<array.type><float/></array.type>([\\s\\S]*?)</array>", "g");
    const out = []; let m;
    while ((m = re.exec(xml))) out.push([...m[1].matchAll(/<float>([^<]+)<\/float>/g)].map((x) => Number(x[1])));
    return out;
  };
  return {
    alphaStops: block("Alpha").map((v) => ({ offset: v[0], midpoint: v[1], alpha: v[2] })),
    colorStops: block("Color").map((v) => ({ offset: v[0], midpoint: v[1], rgb: [v[2], v[3], v[4]] }))
  };
}

test("linear handles: identity transform = left-middle -> right-middle", () => {
  const h = G.gradientHandles([[1, 0, 0], [0, 1, 0]], 200, 100, "GRADIENT_LINEAR");
  assert.equal(h.kind, "linear");
  assert.deepEqual(h.start, [0, 50]); assert.deepEqual(h.end, [200, 50]);
  close(h.angle, 0); close(h.length, 200);
});

test("linear handles: 90deg gradientTransform (top -> bottom)", () => {
  const h = G.gradientHandles([[0, 1, 0], [-1, 0, 1]], 200, 100, "GRADIENT_LINEAR");
  closePt(h.start, [100, 0]); closePt(h.end, [100, 100]); close(h.angle, 90);
});

test("linear handles: Figma default diagonal via inverse transform", () => {
  // Build the transform the way Figma does: unit-space handles p0 -> (0,.5), p1 -> (1,.5)
  const p0 = [0.1, 0.2], p1 = [0.9, 0.7];
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  // inverse transform (gradient space -> unit): x along p0->p1, y perpendicular
  const inv = [dx, dy, -dy, dx, p0[0] + 0.5 * dy, p0[1] - 0.5 * dx];
  const m = G.invert(inv);
  const h = G.gradientHandles(T(m), 300, 200, "GRADIENT_LINEAR");
  closePt(h.start, [p0[0] * 300, p0[1] * 200], 0.05); closePt(h.figmaEnd, [p1[0] * 300, p1[1] * 200], 0.05);
  // Non-square box: AE end handle is corrected so that the projection t matches Figma for every pixel.
  const mf = G.fromFigma(T(m));
  const dx2 = h.end[0] - h.start[0], dy2 = h.end[1] - h.start[1], L2 = dx2 * dx2 + dy2 * dy2;
  for (const pt of [[0, 0], [300, 0], [0, 200], [300, 200], [77, 133], [150, 100]]) {
    const tFigma = G.apply(mf, [pt[0] / 300, pt[1] / 200])[0];
    const tAE = ((pt[0] - h.start[0]) * dx2 + (pt[1] - h.start[1]) * dy2) / L2;
    close(tAE, tFigma, 0.002);
  }
});

test("linear handles: square box keeps Figma's end handle unchanged", () => {
  const p0 = [0.2, 0.1], p1 = [0.8, 0.9], dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const m = G.invert([dx, dy, -dy, dx, p0[0] + 0.5 * dy, p0[1] - 0.5 * dx]);
  const h = G.gradientHandles(T(m), 100, 100, "GRADIENT_LINEAR");
  closePt(h.end, h.figmaEnd, 0.01);
});

test("handles on a rotated + scaled layer map consistently into comp space", () => {
  const h = G.gradientHandles([[1, 0, 0], [0, 1, 0]], 100, 40, "GRADIENT_LINEAR");
  const r = 30 * Math.PI / 180;
  const layerToComp = G.multiply([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 50, 60], [2, 0, 0, 0.5, 0, 0]);
  const hc = G.mapHandles(h, layerToComp);
  closePt(hc.start, G.apply(layerToComp, [0, 20]));
  closePt(hc.end, G.apply(layerToComp, [100, 20]));
  close(hc.angle, 30, 0.01);
  // Layer-local handles stay unrotated: AE applies the layer transform itself.
  close(h.angle, 0);
});

test("radial handles: center, radii, aspect for elliptical", () => {
  const h = G.gradientHandles([[1, 0, 0], [0, 1, 0]], 120, 40, "GRADIENT_RADIAL");
  assert.equal(h.kind, "radial");
  closePt(h.center, [60, 20]); closePt(h.end, [120, 20]); closePt(h.minorEnd, [60, 40]);
  assert.deepEqual(h.radii, [60, 20]); close(h.aspect, 0.3333, 0.001);
  assert.deepEqual(h.start, h.center);
  const sq = G.gradientHandles([[1, 0, 0], [0, 1, 0]], 64, 64, "GRADIENT_RADIAL");
  close(sq.aspect, 1);
});

test("angular / diamond fall back to radial kind info", () => {
  assert.equal(G.gradientHandles([[1, 0, 0], [0, 1, 0]], 10, 10, "GRADIENT_ANGULAR").kind, "angular");
  assert.equal(G.gradientHandles([[1, 0, 0], [0, 1, 0]], 10, 10, "GRADIENT_DIAMOND").kind, "diamond");
  assert.equal(G.aeGradientType("linear"), 1);
  assert.equal(G.aeGradientType("radial"), 2);
  assert.equal(G.aeGradientType("angular"), 2);
});

test("splitStops: sorted, stable for equal positions, clamped, alpha split", () => {
  const s = G.splitStops([st(1, 0, 0, 1), st(0.5, 0, 1, 0, 0.5), st(0, 1, 0, 0), st(0.5, 1, 1, 0), st(1.2, 1, 1, 1)]);
  assert.deepEqual(s.colorStops.map((c) => c.offset), [0, 0.5, 0.5, 1, 1]);
  assert.deepEqual(s.colorStops[1].rgb, [0, 1, 0], "first of equal positions keeps input order");
  assert.deepEqual(s.colorStops[2].rgb, [1, 1, 0]);
  assert.deepEqual(s.alphaStops.map((a) => a.alpha), [1, 0.5, 1, 1, 1]);
  assert.ok(s.colorStops.every((c) => c.midpoint === 0.5));
});

test("sampleStops interpolates color and alpha separately", () => {
  const s = G.splitStops([st(0, 1, 0, 0, 1), st(1, 0, 0, 1, 0)]);
  const m = G.sampleStops(s, 0.5);
  close(m[0], 0.5); close(m[2], 0.5); close(m[3], 0.5);
  assert.deepEqual(G.sampleStops(s, -1), [1, 0, 0, 1]);
});

test("golden: gradientXml reproduces every template's own XML byte-for-byte", () => {
  for (const f of fs.readdirSync(TPL).filter((x) => x.endsWith(".ffx"))) {
    const xml = ffx.readGradientXml(fs.readFileSync(path.join(TPL, f)));
    const parsed = parseXmlStops(xml);
    assert.ok(parsed.colorStops.length >= 2, f);
    assert.equal(G.gradientXml(parsed), xml, f + " XML mismatch");
  }
});

test("golden: stop encoding for a 3-stop gradient with alpha", () => {
  const xml = G.gradientXml(G.splitStops([st(0, 1, 0, 0), st(0.25, 0, 1, 0, 0.5), st(1, 0, 0, 1)]));
  const golden = fs.readFileSync(path.join(__dirname, "golden", "three-stop.xml"), "utf8");
  assert.equal(xml, golden);
  assert.match(xml, /<key>Stops Size<\/key>\n<int type='unsigned' size='32'>3<\/int>/);
  assert.match(xml, /<key>Stops Alpha<\/key>\n<array>\n<array.type><float\/><\/array.type>\n<float>0.25<\/float>\n<float>0.5<\/float>\n<float>0.5<\/float>\n<\/array>/);
  assert.match(xml, /<float>0<\/float>\n<float>0.5<\/float>\n<float>1<\/float>\n<float>0<\/float>\n<float>0<\/float>\n<float>1<\/float>/);
});

test("formatFloat never emits exponent notation", () => {
  assert.equal(G.formatFloat(1e-7), "0");
  assert.equal(G.formatFloat(0.000123), "0.000123");
  assert.equal(G.formatFloat(0.5), "0.5");
});

test("ffx: parse/serialize round trip is byte-identical for all templates", () => {
  for (const f of fs.readdirSync(TPL).filter((x) => x.endsWith(".ffx"))) {
    const buf = fs.readFileSync(path.join(TPL, f));
    assert.ok(ffx.serializeRifx(ffx.parseRifx(buf)).equals(buf), f);
  }
});

for (const n of [2, 3, 8]) {
  test(`ffx: rebuild with ${n} stops keeps RIFX valid and payload readable`, () => {
    const stops = Array.from({ length: n }, (_, i) => st(i / (n - 1), i / (n - 1), 1 - i / (n - 1), 0.5, i % 2 ? 0.5 : 1));
    const split = G.splitStops(stops);
    for (const fam of ["ae22-6", "ae25-6", "ae26-3"]) {
      for (const kind of ["fill", "stroke"]) {
        const tpl = fs.readFileSync(path.join(TPL, `${fam}-${kind}.ffx`));
        const out = ffx.buildGradientFfx(tpl, G.gradientXml(split));
        assert.equal(out.toString("latin1", 0, 4), "RIFX");
        // RIFX size header covers the chunk tree; the XMP block after it must keep its length.
        const tplTrailer = tpl.length - (tpl.readUInt32BE(4) + 8);
        assert.ok(tplTrailer >= 0);
        assert.equal(out.length - (out.readUInt32BE(4) + 8), tplTrailer, "RIFX size header consistent");
        const back = parseXmlStops(ffx.readGradientXml(out));
        assert.equal(back.colorStops.length, n); assert.equal(back.alphaStops.length, n);
        assert.deepEqual(back, JSON.parse(JSON.stringify(split)));
        // the bytes outside the payload are untouched (XMP block etc.)
        const tail = tpl.subarray(tpl.length - 64);
        assert.ok(out.subarray(out.length - 64).equals(tail), "trailing bytes preserved");
      }
    }
  });
}

test("ffx: templateFamily by AE version", () => {
  assert.equal(ffx.templateFamily("22.6.0"), "ae22-6");
  assert.equal(ffx.templateFamily("24.6"), "ae22-6");
  assert.equal(ffx.templateFamily("25.0.1"), "ae25-6");
  assert.equal(ffx.templateFamily("25.6"), "ae25-6");
  assert.equal(ffx.templateFamily("26.3x10"), "ae26-3");
  assert.equal(ffx.templateFamily("27.0"), "ae26-3");
  assert.equal(ffx.templateFamily(""), "ae26-3");
});

test("ffx: writeGradientFfx writes a file and rejects broken stops", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ub-ffx-"));
  const outFile = path.join(dir, "g.ffx");
  const r = ffx.writeGradientFfx({ geom: G, split: G.splitStops([st(0, 1, 1, 1), st(1, 0, 0, 0)]), kind: "fill", aeVersion: "25.2", templatesDir: TPL, outFile });
  assert.equal(r.family, "ae25-6"); assert.ok(fs.existsSync(outFile));
  assert.throws(() => ffx.writeGradientFfx({ geom: G, split: { colorStops: [], alphaStops: [] }, kind: "fill", aeVersion: "25.2", templatesDir: TPL, outFile }));
});

test("gradientStrategy: native when preset exists, ramp for text / missing preset", () => {
  assert.equal(G.gradientStrategy({ type: "gradient", ffx: "/x.ffx" }, "rect", { presetsAvailable: true }), "native");
  assert.equal(G.gradientStrategy({ type: "gradient", ffx: "/x.ffx" }, "ellipse"), "native");
  assert.equal(G.gradientStrategy({ type: "gradient" }, "rect", { presetsAvailable: true }), "ramp");
  assert.equal(G.gradientStrategy({ type: "gradient", ffx: "/x.ffx" }, "rect", { presetsAvailable: false }), "ramp");
  assert.equal(G.gradientStrategy({ type: "gradient", ffx: "/x.ffx" }, "text"), "ramp");
});

test("rampFallback keeps first/last colors and flags lossy", () => {
  const h = G.gradientHandles([[1, 0, 0], [0, 1, 0]], 100, 10, "GRADIENT_LINEAR");
  const r = G.rampFallback(h, [st(1, 0, 0, 1), st(0, 1, 0, 0), st(0.5, 0, 1, 0)]);
  assert.deepEqual(r.startColor, [1, 0, 0, 1]); assert.deepEqual(r.endColor, [0, 0, 1, 1]);
  assert.equal(r.shape, 1); assert.equal(r.lossy, true);
  assert.deepEqual(r.start, [0, 5]); assert.deepEqual(r.end, [100, 5]);
});
