const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../shared/geom.js");
const { createUBSerializer } = require("../figma-plugin/src/serializer.js");
const S = require("./helpers/figma-stub.js");
const F = require("./helpers/fixture.js");

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const byName = (root, name) => { let hit = null; const w = (n) => { if (n.name === name) hit = n; (n.children || []).forEach(w); }; w(root); return hit; };
async function run(roots, opts) { return createUBSerializer(S.figmaApi, G, opts || {}).serialize(roots, { jobId: "test-job" }); }

test("job envelope: schema, options, one comp per frame, assets", async () => {
  const { job, images } = await run([F.buildCard()], { rasterScaleCap: 2, groupsAs: "parent" });
  assert.equal(job.schema, "uiscore.bridge.job"); assert.equal(job.version, 1); assert.equal(job.id, "test-job");
  assert.equal(job.options.rasterScaleCap, 2); assert.equal(job.options.groupsAs, "parent");
  assert.equal(job.comps.length, 1);
  const c = job.comps[0];
  assert.equal(c.name, "Card / Weekly"); assert.equal(c.width, 360); assert.equal(c.height, 240);
  assert.equal(c.background[0].type, "solid");
  assert.equal(images.length, 2);
  assert.deepEqual(Object.keys(job.assets.images).sort(), ["img_1", "img_2"]);
  assert.ok(JSON.parse(JSON.stringify(job)), "JSON-serializable");
});

test("frame children: types, local transforms relative to the frame, order kept", async () => {
  const { job } = await run([F.buildCard()]);
  const root = job.comps[0].root;
  assert.deepEqual(root.children.map((c) => c.type), ["rect", "rect", "rect", "ellipse", "ellipse", "path", "path", "text", "text", "image", "group", "frame", "image"]);
  const hero = byName(root, "Hero gradient");
  assert.deepEqual(hero.transform.local.position, [16, 16]);
  assert.deepEqual(hero.transform.comp.position, [16, 16]);
  assert.equal(hero.geometry.primitive, "rect"); assert.equal(hero.geometry.radius, 12);
  assert.equal(byName(root, "Blob").opacity, 0.7);
  assert.equal(byName(root, "Elliptical glow").blend, "SCREEN");
});

test("rotated rect: rotation decomposed, comp transform matches", async () => {
  const { job } = await run([F.buildCard()]);
  const b = byName(job.comps[0].root, "Rotated badge");
  close(b.transform.local.rotation, -12); assert.deepEqual(b.transform.local.position, [250, 40]);
  close(b.transform.local.scale[0], 1);
  assert.equal(b.strokes.align, "OUTSIDE"); assert.equal(b.strokes.weight, 2);
  assert.equal(b.strokes.paints[0].type, "gradient");
  assert.equal(b.fills.length, 2, "multiple fills kept in order");
  assert.equal(b.fills[0].type, "solid"); assert.equal(b.fills[1].type, "gradient"); assert.equal(b.fills[1].opacity, 0.8);
});

test("nested groups: group children local to group, comp coords absolute in frame", async () => {
  const dotA = S.node("ELLIPSE", { name: "A", width: 4, height: 4, rel: [1, 0, 0, 1, 30, 40] });
  const inner = S.node("GROUP", { name: "Inner", width: 4, height: 4, rel: [1, 0, 0, 1, 30, 40] }, [dotA]);
  const outer = S.node("GROUP", { name: "Outer", width: 4, height: 4, rel: [1, 0, 0, 1, 30, 40] }, [inner]);
  const frame = S.finalize(S.node("FRAME", { name: "F", width: 100, height: 100, rel: [1, 0, 0, 1, 500, 500] }, [outer]));
  const { job } = await run([frame]);
  const o = job.comps[0].root.children[0];
  assert.equal(o.type, "group"); assert.deepEqual(o.transform.local.position, [30, 40]);
  const i = o.children[0];
  assert.deepEqual(i.transform.local.position, [0, 0]);
  assert.deepEqual(i.children[0].transform.local.position, [0, 0]);
  assert.deepEqual(i.children[0].transform.comp.position, [30, 40]);
});

test("rotated nested frame: child local transform is relative, comp transform composes", async () => {
  const child = S.node("RECTANGLE", { name: "R", width: 10, height: 10, rel: S.rot(15, 5, 5) });
  const inner = S.node("FRAME", { name: "Inner", width: 50, height: 50, rel: S.rot(30, 20, 10) }, [child]);
  const frame = S.finalize(S.node("FRAME", { name: "F", width: 200, height: 200, rel: [1, 0, 0, 1, 0, 0] }, [inner]));
  const { job } = await run([frame]);
  const r = job.comps[0].root.children[0].children[0];
  close(r.transform.local.rotation, 15); close(r.transform.comp.rotation, 45);
  const expected = G.apply(G.fromFigma(inner.absoluteTransform), [5, 5]);
  close(r.transform.comp.position[0], expected[0]); close(r.transform.comp.position[1], expected[1]);
});

test("text: styled segments, fonts, tracking, leading, gradient text fill", async () => {
  const { job } = await run([F.buildCard()]);
  const t = byName(job.comps[0].root, "Title");
  assert.equal(t.text.characters, "Weekly report"); assert.equal(t.text.segments.length, 2);
  assert.equal(t.text.segments[0].font.postScript, "Inter-Bold"); assert.equal(t.text.segments[1].font.style, "Regular");
  close(t.text.tracking, -20); assert.equal(t.text.leading, 32);
  assert.equal(t.text.autoResize, "WIDTH_AND_HEIGHT");
  const b = byName(job.comps[0].root, "Body");
  assert.equal(b.text.fills[0].type, "gradient"); assert.equal(b.text.leading, null);
});

test("gradients: kinds, stops, split, local + comp handles", async () => {
  const { job } = await run([F.buildCard()]);
  const root = job.comps[0].root;
  const hero = byName(root, "Hero gradient").fills[0];
  assert.equal(hero.type, "gradient"); assert.equal(hero.kind, "linear"); assert.equal(hero.stops.length, 3);
  assert.equal(hero.split.colorStops.length, 3);
  assert.ok(hero.handles.start && hero.handles.end && hero.handlesComp.start);
  const orb = byName(root, "Orb").fills[0];
  assert.equal(orb.kind, "radial"); assert.deepEqual(orb.handles.center, [32, 32]); assert.deepEqual(orb.handles.end, [64, 32]);
  assert.deepEqual(orb.handlesComp.center, [56, 168]);
  assert.equal(orb.split.alphaStops[2].alpha, 0);
  const glow = byName(root, "Elliptical glow").fills[0];
  close(glow.handles.aspect, 0.3333);
  assert.ok(job.warnings.some((w) => /Elliptical radial/.test(w.message)));
});

test("vector paths, strokes caps/joins, line/dash", async () => {
  const { job } = await run([F.buildCard()]);
  const chk = byName(job.comps[0].root, "Check");
  assert.equal(chk.geometry.primitive, "path"); assert.equal(chk.geometry.paths[0].closed, false);
  assert.equal(chk.strokes.aeCap, 2); assert.equal(chk.strokes.aeJoin, 2); assert.equal(chk.strokes.align, "CENTER");
  const blob = byName(job.comps[0].root, "Blob");
  assert.equal(blob.geometry.paths[0].closed, true); assert.equal(blob.geometry.paths[0].vertices.length, 4);
});

test("images: IMAGE fill and '*' marked node exported as PNG with placement", async () => {
  const card = F.buildCard();
  const { job, images } = await run([card]);
  const av = byName(job.comps[0].root, "Avatar photo");
  assert.equal(av.type, "image"); assert.equal(av.raster.reason, "imageFill");
  assert.equal(av.raster.scale, 3); assert.deepEqual(av.raster.pixelSize, { w: 120, h: 120 });
  close(av.transform.local.scale[0], 1 / 3); assert.deepEqual(av.transform.local.position, [300, 184]);
  assert.equal(av.effects.find((e) => e.type === "innerShadow").bakedIntoRaster, true);
  assert.ok(!av.effects.find((e) => e.type === "dropShadow").bakedIntoRaster);
  const mk = byName(job.comps[0].root, "*Noise texture");
  assert.equal(mk.raster.reason, "marked");
  assert.ok(images.every((i) => i.bytes instanceof Uint8Array && i.bytes[1] === 0x50)); // PNG signature
});

test("raster export hides DROP_SHADOW + LAYER_BLUR and neutral opacity during export, restores after", async () => {
  const card = F.buildCard();
  const avatar = card.children.find((n) => n.name === "Avatar photo");
  const noise = card.children.find((n) => n.name === "*Noise texture");
  const before = avatar.effects;
  await run([card]);
  const during = avatar.effectsDuringExport;
  assert.equal(during.find((e) => e.type === "DROP_SHADOW").visible, false);
  assert.equal(during.find((e) => e.type === "INNER_SHADOW").visible, true, "inner shadow stays baked");
  assert.equal(avatar.effects, before, "original effects array restored");
  assert.equal(noise.effectsDuringExport[0].visible, false);
  assert.equal(noise.opacityDuringExport, 1); assert.equal(noise.opacity, 0.5);
  assert.equal(avatar.lastExportSettings.format, "PNG");
});

test("effects restored even when exportAsync throws; job still produced with warning", async () => {
  const card = F.buildCard();
  const noise = card.children.find((n) => n.name === "*Noise texture");
  noise.failExport = true;
  noise.effectStyleId = "S:style123";
  const styleCalls = [];
  noise.setEffectStyleIdAsync = async (id) => { styleCalls.push(id); };
  const originalEffects = noise.effects;
  const { job, images } = await run([card]);
  assert.equal(noise.effects, originalEffects);
  assert.equal(noise.effects[0].visible, true);
  assert.equal(noise.opacity, 0.5);
  assert.deepEqual(styleCalls, ["S:style123"], "effect style re-attached");
  assert.equal(noise.effectsHistory.length, 2, "set hidden, then restored");
  assert.ok(job.warnings.some((w) => /PNG export failed/.test(w.message)));
  assert.equal(byName(job.comps[0].root, "*Noise texture").raster.failed, true);
  assert.equal(images.length, 1);
});

test("_exportRaster rethrows but still restores (direct)", async () => {
  const n = S.finalize(S.node("RECTANGLE", { name: "x", width: 10, height: 10, opacity: 0.3, visible: false, failExport: true, effects: [{ type: "LAYER_BLUR", visible: true, radius: 3 }] }));
  const ser = createUBSerializer(S.figmaApi, G, {});
  await assert.rejects(() => ser._exportRaster(n, 3), /export exploded/);
  assert.equal(n.effects[0].visible, true); assert.equal(n.opacity, 0.3); assert.equal(n.visible, false);
});

test("masks, clipsContent, components and instances", async () => {
  const main = S.node("COMPONENT", { name: "Button", width: 80, height: 32, rel: [1, 0, 0, 1, 0, 0] });
  const inst = S.node("INSTANCE", { name: "Button 1", width: 80, height: 32, rel: [1, 0, 0, 1, 10, 10], getMainComponentAsync: async () => main, overrides: [] });
  const frame = S.finalize(S.node("FRAME", { name: "F", width: 200, height: 100, rel: [1, 0, 0, 1, 0, 0], clipsContent: true }, [inst]));
  const { job } = await run([frame]);
  const i = job.comps[0].root.children[0];
  assert.equal(i.type, "instance"); assert.equal(i.component.mainId, main.id); assert.equal(i.component.hasOverrides, false);
  assert.equal(job.comps[0].root.clipsContent, true);
  const card = await run([F.buildCard()]);
  const mg = byName(card.job.comps[0].root, "Masked icon");
  assert.equal(mg.children[0].isMask, true); assert.equal(mg.children[0].maskType, "ALPHA");
});

test("effects: drop shadow mapped to AE units; spread warns", async () => {
  const n = S.node("RECTANGLE", { name: "s", width: 10, height: 10, effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 3, y: 4 }, radius: 10, spread: 2 }] });
  const { job } = await run([S.finalize(S.node("FRAME", { name: "F", width: 50, height: 50 }, [n]))]);
  const e = job.comps[0].root.children[0].effects[0];
  assert.equal(e.type, "dropShadow"); close(e.distance, 5); close(e.opacity, 0.5);
  assert.ok(job.warnings.some((w) => /spread/.test(w.message)));
});
