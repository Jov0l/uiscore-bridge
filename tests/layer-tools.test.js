/* Panel "Groups" tools in host/builder.jsx (Precomp / Decomp / Toggle), run against the AE mock.
 * Decomp is checked by mapping points through the layer/parent/precomp transform chain before and after:
 * every layer must land on the same comp pixels with the same effective opacity. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAE } = require("./helpers/ae-mock.js");

const T = "ADBE Transform Group";
const P = (l, k) => l.property(T).property(k);
function setT(l, t) {
  P(l, "ADBE Anchor Point").setValue(t.anchor || [0, 0]);
  P(l, "ADBE Position").setValue(t.position || [0, 0]);
  P(l, "ADBE Scale").setValue(t.scale || [100, 100]);
  P(l, "ADBE Rotate Z").setValue(t.rotation || 0);
  P(l, "ADBE Opacity").setValue(t.opacity === undefined ? 100 : t.opacity);
  return l;
}
const val = (prop, def) => (prop.value === undefined ? def : prop.value);
// layer space -> owning comp space (follows parents)
function toComp(l, pt) {
  const a = val(P(l, "ADBE Anchor Point"), [0, 0]), p = val(P(l, "ADBE Position"), [0, 0]), s = val(P(l, "ADBE Scale"), [100, 100]), r = val(P(l, "ADBE Rotate Z"), 0) * Math.PI / 180;
  const x = (pt[0] - a[0]) * s[0] / 100, y = (pt[1] - a[1]) * s[1] / 100;
  const out = [p[0] + x * Math.cos(r) - y * Math.sin(r), p[1] + x * Math.sin(r) + y * Math.cos(r)];
  return l.parent ? toComp(l.parent, out) : out;
}
const near = (a, b, msg) => { assert.ok(Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6, msg + ": " + a + " vs " + b); };
const res = (ae, fn) => JSON.parse(ae.run(`UiscoreBridge.${fn}()`));

function scene(opts) {
  opts = opts || {};
  const ae = createAE();
  const main = ae.project.items.addComp("Main", 1920, 1080, 1, 10, 30);
  const inner = ae.project.items.addComp("Card", 400, 300, 1, 10, 30);
  // inner layers (top -> bottom): Label (parented to Box), Box, Shadow (matte'd by Box? no: Glow uses Box as matte)
  const shadow = setT(inner.layers.addShape(), { position: [200, 160], opacity: 50 }); shadow.name = "Shadow";
  const box = setT(inner.layers.addShape(), { anchor: [10, 5], position: [120, 80], scale: [150, 80], rotation: 30 }); box.name = "Box";
  const label = setT(inner.layers.addText("Label"), { position: [20, 10], rotation: -15, opacity: 80 }); label.parent = box;
  shadow.setTrackMatte(box, "ALPHA");
  label.inPoint = 0; label.outPoint = 3; // ends before the precomp layer starts showing it all
  const bg = setT(main.layers.addShape(), { position: [960, 540] }); bg.name = "BG";
  const rig = setT(main.layers.addNull(), { position: [300, 200], rotation: 10, scale: [90, 90] }); rig.name = "Rig";
  const pl = setT(main.layers.add(inner), { anchor: [200, 150], position: [700, 400], scale: [120, 60], rotation: 45, opacity: opts.opacity === undefined ? 100 : opts.opacity });
  pl.parent = rig;
  if (opts.offset) pl.startTime = opts.offset;
  if (opts.animOpacity) { P(pl, "ADBE Opacity")._value = undefined; P(pl, "ADBE Opacity").setValueAtTime(0, 0); P(pl, "ADBE Opacity").setValueAtTime(1, 100); }
  ae.project.activeItem = main;
  return { ae, main, inner, pl, rig, box, label, shadow, bg };
}

test("Decomp: every layer keeps its on-screen geometry (anchor/scale/rotation, parented precomp layer, nested parenting)", () => {
  const s = scene();
  const probes = [[0, 0], [37, -12], [250, 90]];
  const before = {};
  for (const l of [s.box, s.label, s.shadow]) before[l.name] = probes.map((pt) => toComp(s.pl, toComp(l, pt)));
  s.pl.selected = true;
  const r = res(s.ae, "decompose");
  assert.equal(r.ok, true, r.error);
  assert.match(r.summary, /Decomposed "Card" \(3 layers\) into "Main"/);
  assert.equal(s.ae.app._undo, 0, "undo group closed");
  const names = s.main._layers.map((l) => l.name);
  assert.deepEqual(names, ["Card", "Label", "Box", "Shadow", "Rig", "BG"], "null on top of the copied block, block where the precomp layer was");
  assert.ok(!s.main._layers.some((l) => l.source === s.inner), "precomp layer removed");
  const get = (n) => s.main._layers.find((l) => l.name === n);
  const nul = get("Card");
  assert.equal(nul.kind, "null"); assert.equal(nul.parent, s.rig, "null inherits the precomp layer's parent");
  assert.equal(get("Label").parent, get("Box"), "internal parenting restored");
  assert.equal(get("Box").parent, nul); assert.equal(get("Shadow").parent, nul);
  assert.equal(get("Shadow").trackMatte.layer, get("Box"), "track matte restored to the copy");
  for (const n of ["Box", "Label", "Shadow"]) probes.forEach((pt, i) => near(toComp(get(n), pt), before[n][i], n));
  assert.equal(val(P(get("Label"), "ADBE Opacity")), 80); assert.equal(val(P(get("Shadow"), "ADBE Opacity")), 50);
  assert.ok(get("Box").selected && get("Label").selected, "decomposed layers selected");
  assert.ok(r.warnings.some((w) => /no longer used and was kept/.test(w)), "unused source comp kept + reported");
  assert.ok(s.ae.items.includes(s.inner));
});

test("Decomp: time offset shifts the layers, trims to the precomp layer, drops layers outside its range", () => {
  const s = scene({ offset: 4 });
  s.pl.outPoint = 9;
  s.pl.selected = true;
  let r = res(s.ae, "decompose");
  assert.equal(r.ok, true, r.error);
  const box = s.main._layers.find((l) => l.name === "Box");
  assert.equal(box.startTime, 4); assert.equal(box.inPoint, 4); assert.equal(box.outPoint, 9);
  const label = s.main._layers.find((l) => l.name === "Label"); // 0-3 inside -> 4-7
  assert.equal(label.inPoint, 4); assert.equal(label.outPoint, 7);

  const t = scene({ offset: 4 });
  t.pl.inPoint = 7.5; t.pl.selected = true;
  r = res(t.ae, "decompose");
  assert.equal(r.ok, true, r.error);
  assert.ok(!t.main._layers.some((l) => l.name === "Label"), "Label (4-7) is outside 7.5-14 -> dropped");
  assert.ok(r.warnings.some((w) => /1 layer outside the precomp layer's time range were dropped/.test(w)));
  assert.equal(t.main._layers.find((l) => l.name === "Box").inPoint, 7.5);
  s.ae.project.activeItem = s.main;
});

test("Decomp: static precomp opacity is baked into every layer; animated opacity drives them via a Group Opacity slider", () => {
  let s = scene({ opacity: 50 });
  s.pl.selected = true;
  let r = res(s.ae, "decompose");
  assert.equal(r.ok, true, r.error);
  const op = (n) => val(P(s.main._layers.find((l) => l.name === n), "ADBE Opacity"));
  assert.equal(op("Box"), 50); assert.equal(op("Label"), 40); assert.equal(op("Shadow"), 25);
  assert.ok(r.warnings.some((w) => /applied per layer/.test(w)));

  s = scene({ animOpacity: true });
  s.pl.selected = true;
  r = res(s.ae, "decompose");
  assert.equal(r.ok, true, r.error);
  const nul = s.main._layers.find((l) => l.kind === "null" && l.name === "Card");
  const slider = nul.property("ADBE Effect Parade").children.find((c) => c.name === "Group Opacity");
  assert.ok(slider, "slider added");
  assert.deepEqual(slider.property("ADBE Slider Control-0001")._keys.map((k) => [k.t, k.v]), [[0, 0], [1, 100]]);
  const box = s.main._layers.find((l) => l.name === "Box");
  assert.equal(P(box, "ADBE Opacity").expression, 'value * thisComp.layer("Card").effect("Group Opacity")("Slider") / 100');
});

test("Decomp: errors for no selection / non-precomp selection / time remap; nothing changes", () => {
  const s = scene();
  let r = res(s.ae, "decompose");
  assert.equal(r.ok, false); assert.match(r.error, /Select a precomp layer/);
  s.bg.selected = true;
  r = res(s.ae, "decompose");
  assert.equal(r.ok, false); assert.match(r.error, /Select a precomp layer/);
  s.bg.selected = false; s.pl.selected = true; s.pl.timeRemapEnabled = true;
  const n = s.main._layers.length;
  r = res(s.ae, "decompose");
  assert.equal(r.ok, false); assert.match(r.error, /Time Remap/);
  assert.equal(s.main._layers.length, n, "nothing added before the check");
  assert.equal(s.ae.app._undo, 0);
  s.ae.project.activeItem = null;
  r = res(s.ae, "decompose");
  assert.equal(r.ok, false); assert.match(r.error, /Open a composition/);
});

test("Precomp: selected layers move into a new comp named after them; Decomp brings them back", () => {
  const s = scene();
  s.bg.selected = true; s.rig.selected = true;
  let r = res(s.ae, "precompose");
  assert.equal(r.ok, true, r.error);
  assert.match(r.summary, /Precomposed 2 layers into "Pre-comp 1"/);
  const pc = s.ae.items.find((i) => i.name === "Pre-comp 1");
  assert.deepEqual(pc._layers.map((l) => l.name), ["Rig", "BG"]);
  assert.equal(s.main._layers.find((l) => l.source === pc).selected, true, "new precomp layer selected");
  // single layer -> "<name> Comp", unique names
  for (const l of s.main._layers) l.selected = false;
  s.main._layers.find((l) => l.source === pc).selected = true;
  r = res(s.ae, "precompose");
  assert.match(r.summary, /into "Pre-comp 1 Comp"/);
  r = res(s.ae, "precompose");
  assert.equal(r.ok, true);
  assert.match(r.summary, /into "Pre-comp 1 Comp Comp"/);
  for (const l of s.main._layers) l.selected = false;
  r = res(s.ae, "precompose");
  assert.equal(r.ok, false); assert.match(r.error, /Select the layers to precompose/);
});

test("Toggle: hides the selection if any layer is visible, otherwise shows all", () => {
  const s = scene();
  s.bg.selected = true; s.rig.selected = true; s.rig.enabled = false;
  let r = res(s.ae, "toggleVisibility");
  assert.equal(r.ok, true); assert.match(r.summary, /^Hid 1 layer/);
  assert.equal(s.bg.enabled, false); assert.equal(s.rig.enabled, false);
  r = res(s.ae, "toggleVisibility");
  assert.match(r.summary, /^Showed 2 layers/);
  assert.equal(s.bg.enabled, true); assert.equal(s.rig.enabled, true);
  for (const l of s.main._layers) l.selected = false;
  r = res(s.ae, "toggleVisibility");
  assert.equal(r.ok, false); assert.match(r.error, /Select the layers to show or hide/);
});
