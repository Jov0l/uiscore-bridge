/*
 * Tiny Figma API stub: enough of the node model for the serializer.
 * absoluteTransform is computed from parent chain like Figma does
 * (GROUP / BOOLEAN_OPERATION children are positioned in the group's parent space).
 */
const G = require("../../shared/geom.js");
const { encodePng } = require("./png.js");

const MIXED = Symbol("figma.mixed");

function toFigmaT(m) { return [[m[0], m[2], m[4]], [m[1], m[3], m[5]]]; }
function rot(deg, x, y) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, x, y]; }

let idc = 0;
function node(type, props, children) {
  const n = Object.assign({
    id: "1:" + (++idc), type, name: type.toLowerCase(), visible: true, opacity: 1, blendMode: "PASS_THROUGH",
    width: 100, height: 100, fills: [], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", effects: [], effectStyleId: "",
    rel: [1, 0, 0, 1, 0, 0], isMask: false, exportCalls: 0, effectsHistory: []
  }, props || {});
  n.children = children || (["FRAME", "GROUP", "COMPONENT", "INSTANCE", "BOOLEAN_OPERATION"].includes(type) ? [] : undefined);
  // effects with history so tests can see temporary changes
  let effects = n.effects;
  Object.defineProperty(n, "effects", { get: () => effects, set: (v) => { n.effectsHistory.push(v); effects = v; }, enumerable: true });
  (n.children || []).forEach((c) => { c.parent = n; });
  return n;
}

function finalize(root, pageAbs) {
  const walk = (n, containerAbs) => {
    n.abs = G.multiply(containerAbs, n.rel);
    n.absoluteTransform = toFigmaT(n.abs);
    n.relativeTransform = toFigmaT(n.rel);
    const childSpace = (n.type === "GROUP" || n.type === "BOOLEAN_OPERATION") ? containerAbs : n.abs;
    (n.children || []).forEach((c) => walk(c, childSpace));
    // bounding boxes: axis-aligned bounds of the transformed box
    const pts = [[0, 0], [n.width, 0], [n.width, n.height], [0, n.height]].map((p) => G.apply(n.abs, p));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    n.absoluteBoundingBox = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    n.absoluteRenderBounds = Object.assign({}, n.absoluteBoundingBox);
    if (!n.exportAsync) {
      n.exportAsync = async (settings) => {
        n.exportCalls++;
        n.lastExportSettings = settings;
        n.effectsDuringExport = n.effects;
        n.opacityDuringExport = n.opacity;
        if (n.failExport) throw new Error("export exploded");
        const s = settings.constraint.value;
        const w = Math.max(1, Math.round(n.absoluteRenderBounds.width * s)), h = Math.max(1, Math.round(n.absoluteRenderBounds.height * s));
        return new Uint8Array(encodePng(Math.min(w, 64), Math.min(h, 64), (x, y) => [x * 4 & 255, y * 4 & 255, 160, 255]));
      };
    }
  };
  walk(root, pageAbs || [1, 0, 0, 1, 0, 0]);
  return root;
}

const solid = (r, g, b, a, extra) => Object.assign({ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r, g, b }, }, a !== undefined ? { opacity: a } : {}, extra || {});
const stop = (position, r, g, b, a) => ({ position, color: { r, g, b, a: a === undefined ? 1 : a } });
const gradient = (type, transform, stops, extra) => Object.assign({ type, visible: true, opacity: 1, blendMode: "NORMAL", gradientTransform: transform, gradientStops: stops }, extra || {});

function textNode(props) {
  const chars = props.characters;
  const seg = (start, end, extra) => Object.assign({ start, end, characters: chars.slice(start, end), fontName: { family: "Inter", style: "Regular" }, fontSize: 24, fills: [solid(0.1, 0.1, 0.1)], letterSpacing: { unit: "PERCENT", value: -2 }, lineHeight: { unit: "PIXELS", value: 32 }, textCase: "ORIGINAL", textDecoration: "NONE" }, extra || {});
  const segments = props.segments || [seg(0, chars.length)];
  return node("TEXT", Object.assign({
    fontName: segments.length > 1 ? MIXED : segments[0].fontName, fontSize: 24, textAutoResize: "WIDTH_AND_HEIGHT", textAlignHorizontal: "LEFT", textAlignVertical: "TOP",
    getStyledTextSegments: () => segments.map((s) => Object.assign({}, s, { characters: chars.slice(s.start, s.end) }))
  }, props, { segments: undefined }));
}

module.exports = { MIXED, figmaApi: { mixed: MIXED }, node, finalize, rot, solid, stop, gradient, textNode, toFigmaT, seg: null };
