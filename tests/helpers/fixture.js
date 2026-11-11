/* A representative Figma document built with the stub: used by tests and to generate examples/. */
const S = require("./figma-stub.js");
const { node, finalize, rot, solid, stop, gradient, textNode } = S;

// gradientTransform helpers (Figma maps the layer's unit box INTO gradient space)
const GT_LEFT_RIGHT = [[1, 0, 0], [0, 1, 0]];
const GT_TOP_BOTTOM = [[0, 1, 0], [-1, 0, 1]];           // 90deg: top -> bottom
const GT_RADIAL_CENTER = [[1, 0, 0], [0, 1, 0]];          // centre .5,.5, radius .5w/.5h
function GT_DIAGONAL() { // 45deg top-left -> bottom-right in unit space
  return [[0.5, 0.5, 0], [-0.5, 0.5, 0.5]];
}

function buildCard() {
  const bg = node("RECTANGLE", {
    name: "Background", width: 360, height: 240, rel: [1, 0, 0, 1, 0, 0], cornerRadius: 16,
    fills: [solid(1, 1, 1)],
    strokes: [solid(0.85, 0.87, 0.9)], strokeWeight: 1, strokeAlign: "INSIDE",
    effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.18 }, offset: { x: 0, y: 8 }, radius: 24, spread: 0, blendMode: "NORMAL" }]
  });
  const hero = node("RECTANGLE", {
    name: "Hero gradient", width: 328, height: 96, rel: [1, 0, 0, 1, 16, 16], cornerRadius: 12,
    fills: [gradient("GRADIENT_LINEAR", GT_DIAGONAL(), [stop(0, 0.39, 0.4, 0.95), stop(0.55, 0.85, 0.35, 0.85), stop(1, 1, 0.62, 0.3)])]
  });
  const badge = node("RECTANGLE", {
    name: "Rotated badge", width: 80, height: 28, rel: rot(-12, 250, 40), cornerRadius: 14,
    fills: [solid(0.1, 0.1, 0.12, 0.9), gradient("GRADIENT_LINEAR", GT_TOP_BOTTOM, [stop(0, 1, 1, 1, 0.35), stop(1, 1, 1, 1, 0)], { opacity: 0.8 })],
    strokes: [gradient("GRADIENT_LINEAR", GT_LEFT_RIGHT, [stop(0, 1, 0.8, 0.2), stop(1, 1, 0.3, 0.5)])], strokeWeight: 2, strokeAlign: "OUTSIDE"
  });
  const orb = node("ELLIPSE", {
    name: "Orb", width: 64, height: 64, rel: [1, 0, 0, 1, 24, 136],
    fills: [gradient("GRADIENT_RADIAL", GT_RADIAL_CENTER, [stop(0, 1, 1, 1), stop(0.6, 0.55, 0.75, 1), stop(1, 0.2, 0.3, 0.9, 0)])],
    arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 }
  });
  const glow = node("ELLIPSE", {
    name: "Elliptical glow", width: 120, height: 40, rel: [1, 0, 0, 1, 220, 180],
    fills: [gradient("GRADIENT_RADIAL", GT_RADIAL_CENTER, [stop(0, 1, 0.9, 0.5, 0.9), stop(1, 1, 0.9, 0.5, 0)])], blendMode: "SCREEN"
  });
  const check = node("VECTOR", {
    name: "Check", width: 20, height: 14, rel: [1, 0, 0, 1, 46, 210],
    vectorPaths: [{ windingRule: "NONE", data: "M 0 7 L 7 14 L 20 0" }],
    strokes: [solid(0.2, 0.7, 0.4)], strokeWeight: 2.5, strokeCap: "ROUND", strokeJoin: "ROUND", strokeAlign: "CENTER"
  });
  const blob = node("VECTOR", {
    name: "Blob", width: 40, height: 40, rel: [1, 0, 0, 1, 300, 120],
    vectorPaths: [{ windingRule: "NONZERO", data: "M 20 0 C 31.0457 0 40 8.9543 40 20 C 40 31.0457 31.0457 40 20 40 C 8.9543 40 0 31.0457 0 20 C 0 8.9543 8.9543 0 20 0 Z" }],
    fills: [solid(0.95, 0.4, 0.4)], opacity: 0.7
  });
  const title = textNode({
    name: "Title", characters: "Weekly report", width: 160, height: 32, rel: [1, 0, 0, 1, 104, 132],
    segments: [
      { start: 0, end: 7, fontName: { family: "Inter", style: "Bold" }, fontSize: 24, fills: [solid(0.08, 0.08, 0.1)], letterSpacing: { unit: "PERCENT", value: -2 }, lineHeight: { unit: "PIXELS", value: 32 }, textCase: "ORIGINAL", textDecoration: "NONE" },
      { start: 7, end: 13, fontName: { family: "Inter", style: "Regular" }, fontSize: 24, fills: [solid(0.4, 0.4, 0.45)], letterSpacing: { unit: "PERCENT", value: -2 }, lineHeight: { unit: "PIXELS", value: 32 }, textCase: "ORIGINAL", textDecoration: "NONE" }
    ]
  });
  const body = textNode({
    name: "Body", characters: "Revenue grew 12% week over week.", width: 220, height: 40, rel: [1, 0, 0, 1, 104, 168],
    textAutoResize: "HEIGHT", textAlignHorizontal: "LEFT",
    segments: [{ start: 0, end: 32, fontName: { family: "Inter", style: "Medium" }, fontSize: 14, fills: [gradient("GRADIENT_LINEAR", GT_LEFT_RIGHT, [stop(0, 0.3, 0.3, 0.9), stop(1, 0.8, 0.3, 0.6)])], letterSpacing: { unit: "PIXELS", value: 0 }, lineHeight: { unit: "AUTO" }, textCase: "ORIGINAL", textDecoration: "NONE" }]
  });
  const avatar = node("RECTANGLE", {
    name: "Avatar photo", width: 40, height: 40, rel: [1, 0, 0, 1, 300, 184], cornerRadius: 20,
    fills: [{ type: "IMAGE", visible: true, opacity: 1, blendMode: "NORMAL", scaleMode: "FILL", imageHash: "abc123" }],
    effects: [
      { type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 6, spread: 0, blendMode: "NORMAL" },
      { type: "INNER_SHADOW", visible: true, color: { r: 1, g: 1, b: 1, a: 0.3 }, offset: { x: 0, y: 1 }, radius: 0, spread: 0, blendMode: "NORMAL" }
    ]
  });
  const dotA = node("ELLIPSE", { name: "Dot A", width: 8, height: 8, rel: [1, 0, 0, 1, 0, 0], fills: [solid(0.3, 0.8, 0.5)] });
  const dotB = node("ELLIPSE", { name: "Dot B", width: 8, height: 8, rel: [1, 0, 0, 1, 12, 0], fills: [solid(0.95, 0.75, 0.2)] });
  const dots = node("GROUP", { name: "Dots", width: 20, height: 8, rel: [1, 0, 0, 1, 320, 24] }, [dotA, dotB]);
  dots.rel = [1, 0, 0, 1, 320, 24];
  // children of a GROUP are positioned in the group's parent space
  dotA.rel = [1, 0, 0, 1, 320, 24]; dotB.rel = [1, 0, 0, 1, 332, 24];

  const maskShape = node("ELLIPSE", { name: "Mask circle", width: 48, height: 48, rel: [1, 0, 0, 1, 0, 0], isMask: true, maskType: "ALPHA", fills: [solid(0, 0, 0)] });
  const masked = node("RECTANGLE", { name: "Masked stripes", width: 48, height: 48, rel: [1, 0, 0, 1, 0, 0], fills: [gradient("GRADIENT_LINEAR", GT_LEFT_RIGHT, [stop(0, 0.2, 0.6, 1), stop(1, 0.6, 0.2, 1)])] });
  const maskGroup = node("FRAME", { name: "Masked icon", width: 48, height: 48, rel: [1, 0, 0, 1, 40, 60], clipsContent: false, fills: [] }, [maskShape, masked]);

  const marked = node("RECTANGLE", {
    name: "*Noise texture", width: 60, height: 20, rel: [1, 0, 0, 1, 16, 120], fills: [solid(0.5, 0.5, 0.5)], opacity: 0.5,
    effects: [{ type: "LAYER_BLUR", visible: true, radius: 4, blurType: "NORMAL" }]
  });

  const card = node("FRAME", {
    name: "Card / Weekly", width: 360, height: 240, rel: [1, 0, 0, 1, 100, 50], clipsContent: true, cornerRadius: 16, fills: [solid(0.96, 0.96, 0.98)]
  }, [bg, hero, badge, orb, glow, check, blob, title, body, avatar, dots, maskGroup, marked]);
  return finalize(card);
}

module.exports = { buildCard, GT_LEFT_RIGHT, GT_TOP_BOTTOM, GT_DIAGONAL, GT_RADIAL_CENTER };
