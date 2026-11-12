/*
 * Uiscore Bridge - Figma serializer (main thread, no DOM).
 * Pure with respect to the outside world: everything it needs from Figma is passed in
 * (`figmaApi` for figma.mixed etc., and the nodes themselves), so tests can run it with a stub.
 * Requires UBGeom (shared/geom.js) in scope or passed explicitly.
 */
function createUBSerializer(figmaApi, G, userOptions) {
  var opts = Object.assign({
    rasterScaleCap: 3,
    groupsAs: "precomp",       // "precomp" | "parent"
    compMode: "new",           // "new" | "active"
    fps: 30,
    duration: 10,
    pluginVersion: "0.1.0"
  }, userOptions || {});

  var MIXED = figmaApi.mixed;
  var warnings = [];
  var rasterTasks = [];
  var imageCounter = 0;

  function isMixed(v) { return v === MIXED || (typeof v === "symbol"); }
  function warn(node, msg) { warnings.push({ id: node ? node.id : null, name: node ? node.name : null, message: msg }); }

  var CONTAINERS = { FRAME: 1, GROUP: 1, COMPONENT: 1, COMPONENT_SET: 1, INSTANCE: 1, SECTION: 1, BOOLEAN_OPERATION: 1 };
  var TYPE_MAP = {
    FRAME: "frame", SECTION: "frame", GROUP: "group", COMPONENT: "component", COMPONENT_SET: "frame",
    INSTANCE: "instance", RECTANGLE: "rect", ELLIPSE: "ellipse", POLYGON: "polygon", STAR: "star",
    VECTOR: "path", LINE: "line", BOOLEAN_OPERATION: "boolean", TEXT: "text"
  };

  // -------------------------------------------------------------- paints
  function serializePaint(p, node, w, h, compMatrix) {
    var base = { visible: p.visible !== false, opacity: p.opacity === undefined ? 1 : G.round(p.opacity, 4), blend: G.aeBlendName(p.blendMode || "NORMAL") };
    if (p.type === "SOLID") {
      return Object.assign(base, { type: "solid", color: G.color(p.color) });
    }
    if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_ANGULAR" || p.type === "GRADIENT_DIAMOND") {
      var stops = [];
      for (var i = 0; i < p.gradientStops.length; i++) {
        var s = p.gradientStops[i];
        stops.push({ position: G.round(s.position, 6), color: G.color(s.color) });
      }
      var rawStops = p.gradientStops.map(function (s) { return { position: s.position, color: s.color }; });
      var handles = G.gradientHandles(p.gradientTransform, w, h, p.type);
      var out = Object.assign(base, {
        type: "gradient",
        kind: handles.kind,
        stops: stops,
        split: G.splitStops(rawStops),
        handles: handles,                                   // layer-local px
        handlesComp: G.mapHandles(handles, compMatrix),     // comp px
        gradientTransform: G.fromFigma(p.gradientTransform)
      });
      if (handles.kind === "radial" && Math.abs(handles.aspect - 1) > 0.02) warn(node, "Elliptical radial gradient (aspect " + handles.aspect + "): AE gradients are circular, using major axis.");
      if (handles.kind === "angular" || handles.kind === "diamond") warn(node, "Gradient type " + p.type + " has no native AE equivalent; exported as radial.");
      return out;
    }
    if (p.type === "IMAGE" || p.type === "VIDEO") {
      return Object.assign(base, { type: "image", scaleMode: p.scaleMode || "FILL", imageHash: p.imageHash || null });
    }
    warn(node, "Unsupported paint type " + p.type);
    return Object.assign(base, { type: "unsupported", figmaType: p.type });
  }

  function serializePaints(paints, node, w, h, compMatrix) {
    if (!paints || isMixed(paints)) return [];
    var out = [];
    for (var i = 0; i < paints.length; i++) out.push(serializePaint(paints[i], node, w, h, compMatrix));
    return out; // order = Figma order (index 0 = bottom-most)
  }

  function hasImagePaint(paints) {
    if (!paints || isMixed(paints)) return false;
    for (var i = 0; i < paints.length; i++) if (paints[i].visible !== false && (paints[i].type === "IMAGE" || paints[i].type === "VIDEO")) return true;
    return false;
  }

  // ------------------------------------------------------------ strokes
  function serializeStrokes(node, w, h, compMatrix) {
    var paints = serializePaints(node.strokes, node, w, h, compMatrix);
    if (!paints.length) return null;
    var weight = node.strokeWeight;
    var individual = null;
    if (isMixed(weight) || (node.strokeTopWeight !== undefined && (node.strokeTopWeight !== node.strokeBottomWeight || node.strokeLeftWeight !== node.strokeRightWeight || node.strokeTopWeight !== node.strokeLeftWeight))) {
      individual = [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight];
      weight = Math.max.apply(null, individual.map(function (x) { return x || 0; }));
      warn(node, "Individual stroke weights are not supported in AE; using max weight " + weight + ".");
    }
    var cap = isMixed(node.strokeCap) ? "NONE" : (node.strokeCap || "NONE");
    var join = isMixed(node.strokeJoin) ? "MITER" : (node.strokeJoin || "MITER");
    return {
      paints: paints,
      weight: G.round(weight || 0, 3),
      individualWeights: individual,
      align: node.strokeAlign || "CENTER",
      dash: (node.dashPattern && node.dashPattern.length) ? node.dashPattern.slice(0) : [],
      cap: cap, aeCap: G.lineCap(cap),
      join: join, aeJoin: G.lineJoin(join),
      miterLimit: node.strokeMiterLimit || 4
    };
  }

  // ------------------------------------------------------------ effects
  function serializeEffects(node) {
    if (!node.effects || !node.effects.length) return [];
    var out = [];
    for (var i = 0; i < node.effects.length; i++) {
      var e = node.effects[i];
      var visible = e.visible !== false;
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        var s = G.shadowToAE(e);
        out.push(Object.assign({ type: e.type === "DROP_SHADOW" ? "dropShadow" : "innerShadow", visible: visible, offset: [e.offset.x, e.offset.y], radius: e.radius || 0, colorRGBA: G.color(e.color), showBehindNode: e.showShadowBehindNode === true }, s));
        // spread != 0: the AE builder draws it as its own blurred shape layer (shapes/frames) or warns (text/images/groups)
      } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
        out.push({ type: e.type === "LAYER_BLUR" ? "layerBlur" : "backgroundBlur", visible: visible, radius: e.radius || 0, blurriness: G.blurToAE(e.radius) });
        if (e.blurType === "PROGRESSIVE") warn(node, "Progressive blur exported as uniform blur.");
      } else {
        warn(node, "Unsupported effect " + e.type);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ geometry
  function pathsFromGeometry(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      var sub = G.parseSvgPath(list[i].data);
      for (var k = 0; k < sub.length; k++) { sub[k].windingRule = list[i].windingRule || "NONZERO"; out.push(sub[k]); }
    }
    return out;
  }

  function radiusOf(node) {
    if (node.cornerRadius === undefined) return 0;
    if (isMixed(node.cornerRadius)) return [node.topLeftRadius || 0, node.topRightRadius || 0, node.bottomRightRadius || 0, node.bottomLeftRadius || 0];
    return node.cornerRadius || 0;
  }

  function geometryFor(node, type) {
    var w = node.width, h = node.height;
    if (type === "rect" || type === "frame" || type === "component" || type === "instance") {
      var r = radiusOf(node);
      if (node.cornerSmoothing) warn(node, "Corner smoothing (squircle) is approximated with regular rounded corners.");
      return { primitive: "rect", radius: r };
    }
    if (type === "ellipse") {
      var arc = node.arcData;
      if (arc && (Math.abs(arc.endingAngle - arc.startingAngle - Math.PI * 2) > 1e-4 || arc.innerRadius > 0)) {
        return { primitive: "path", paths: pathsFromGeometry(node.fillGeometry), note: "arc" };
      }
      return { primitive: "ellipse" };
    }
    if (type === "line") {
      return { primitive: "path", paths: [{ closed: false, vertices: [[0, 0], [G.round(w), 0]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], windingRule: "NONZERO" }] };
    }
    if (type === "path") {
      var vp = node.vectorPaths;
      return { primitive: "path", paths: pathsFromGeometry(vp && vp.length ? vp : node.fillGeometry) };
    }
    if (type === "polygon" || type === "star") {
      return { primitive: "path", paths: pathsFromGeometry(node.fillGeometry), pointCount: node.pointCount, innerRadius: node.innerRadius };
    }
    if (type === "boolean") {
      return { primitive: "path", paths: pathsFromGeometry(node.fillGeometry), booleanOp: node.booleanOperation };
    }
    return null;
  }

  // ----------------------------------------------------------------- text
  async function serializeText(node, w, h, compMatrix) {
    var fields = ["fontName", "fontSize", "fills", "letterSpacing", "lineHeight", "textCase", "textDecoration"];
    var segs = [];
    var raw = typeof node.getStyledTextSegments === "function" ? node.getStyledTextSegments(fields) : null;
    if (raw && raw.length) {
      for (var i = 0; i < raw.length; i++) {
        var s = raw[i];
        segs.push({
          start: s.start, end: s.end, characters: s.characters,
          font: { family: s.fontName.family, style: s.fontName.style, postScript: G.postScriptGuess(s.fontName) },
          size: s.fontSize,
          fills: serializePaints(s.fills, node, w, h, compMatrix),
          tracking: G.trackingFromLetterSpacing(s.letterSpacing, s.fontSize),
          leading: G.leadingFromLineHeight(s.lineHeight, s.fontSize),
          letterSpacing: s.letterSpacing, lineHeight: s.lineHeight,
          textCase: s.textCase, textDecoration: s.textDecoration
        });
      }
    } else {
      var fn = isMixed(node.fontName) ? { family: "Arial", style: "Regular" } : node.fontName;
      var fs = isMixed(node.fontSize) ? 16 : node.fontSize;
      segs.push({
        start: 0, end: node.characters.length, characters: node.characters,
        font: { family: fn.family, style: fn.style, postScript: G.postScriptGuess(fn) }, size: fs,
        fills: serializePaints(node.fills, node, w, h, compMatrix),
        tracking: G.trackingFromLetterSpacing(isMixed(node.letterSpacing) ? null : node.letterSpacing, fs),
        leading: G.leadingFromLineHeight(isMixed(node.lineHeight) ? null : node.lineHeight, fs),
        textCase: isMixed(node.textCase) ? "ORIGINAL" : node.textCase, textDecoration: isMixed(node.textDecoration) ? "NONE" : node.textDecoration
      });
    }
    var first = segs[0];
    return {
      characters: node.characters,
      autoResize: node.textAutoResize || "NONE",
      alignH: node.textAlignHorizontal || "LEFT",
      alignV: node.textAlignVertical || "TOP",
      justification: G.justification(node.textAlignHorizontal),
      paragraphSpacing: node.paragraphSpacing || 0,
      truncation: node.textTruncation || "DISABLED",
      segments: segs,
      // convenience copies of the first segment for simple builders
      font: first.font, size: first.size, tracking: first.tracking, leading: first.leading, fills: first.fills
    };
  }

  // --------------------------------------------------------------- raster
  function isFillContainer(node) {
    return !!CONTAINERS[node.type] && node.type !== "BOOLEAN_OPERATION" && node.type !== "GROUP";
  }

  /*
   * Export only the image paints of a container (frame / component / instance) as PNG:
   * a temporary rectangle with the same size, transform and corner radii, removed in `finally`.
   */
  async function exportImageFill(node, cap) {
    var rect = figmaApi.createRectangle();
    try {
      rect.name = "uiscore-bridge-tmp";
      rect.resize(Math.max(0.01, node.width || 0), Math.max(0.01, node.height || 0));
      rect.relativeTransform = node.absoluteTransform;
      var paints = [];
      for (var i = 0; i < node.fills.length; i++) if (node.fills[i].type === "IMAGE" || node.fills[i].type === "VIDEO") paints.push(node.fills[i]);
      rect.fills = paints;
      rect.strokes = [];
      if (node.cornerRadius !== undefined && node.cornerRadius !== figmaApi.mixed) rect.cornerRadius = node.cornerRadius;
      else if (node.topLeftRadius !== undefined) {
        rect.topLeftRadius = node.topLeftRadius; rect.topRightRadius = node.topRightRadius;
        rect.bottomRightRadius = node.bottomRightRadius; rect.bottomLeftRadius = node.bottomLeftRadius;
      }
      if (node.cornerSmoothing) rect.cornerSmoothing = node.cornerSmoothing;
      var rb = rect.absoluteRenderBounds || rect.absoluteBoundingBox || { x: 0, y: 0, width: rect.width, height: rect.height };
      var scale = G.exportScale(rb.width, rb.height, cap);
      var bytes = await rect.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
      return { bytes: bytes, bounds: { x: rb.x, y: rb.y, width: rb.width, height: rb.height }, scale: scale };
    } finally {
      try { rect.remove(); } catch (e) {}
    }
  }

  function shouldRaster(node) {
    if (node.name && node.name.charAt(0) === "*") return "marked";
    // Containers keep their children editable: only their image fill becomes a PNG (see bgRaster).
    if (hasImagePaint(node.fills) && !isFillContainer(node)) return "imageFill";
    if (!TYPE_MAP[node.type]) return "unsupportedType";
    return null;
  }

  /*
   * Export a node as PNG. DROP_SHADOW and LAYER_BLUR are rebuilt natively in AE, so they are
   * hidden for the export and ALWAYS restored in `finally` (also when exportAsync throws).
   * Opacity and visibility are neutralised the same way (AE applies them on the layer).
   */
  async function exportRaster(node, cap) {
    var originalEffects = node.effects;
    var originalStyleId = node.effectStyleId || "";
    var originalOpacity = node.opacity;
    var originalVisible = node.visible;
    var changedEffects = false;
    try {
      if (originalEffects && originalEffects.length) {
        var tmp = [];
        for (var i = 0; i < originalEffects.length; i++) {
          var e = originalEffects[i];
          if (e.type === "DROP_SHADOW" || e.type === "LAYER_BLUR") { tmp.push(Object.assign({}, e, { visible: false })); changedEffects = true; }
          else tmp.push(e);
        }
        if (changedEffects) node.effects = tmp;
      }
      if (originalOpacity !== 1) node.opacity = 1;
      if (originalVisible === false) node.visible = true;
      var rb = node.absoluteRenderBounds || node.absoluteBoundingBox || { x: 0, y: 0, width: node.width, height: node.height };
      var scale = G.exportScale(rb.width, rb.height, cap);
      var bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
      return { bytes: bytes, bounds: { x: rb.x, y: rb.y, width: rb.width, height: rb.height }, scale: scale };
    } finally {
      if (changedEffects) {
        node.effects = originalEffects;
        if (originalStyleId && typeof node.setEffectStyleIdAsync === "function") {
          try { await node.setEffectStyleIdAsync(originalStyleId); } catch (styleErr) { warn(node, "Could not re-attach effect style: " + styleErr); }
        }
      }
      if (node.opacity !== originalOpacity) node.opacity = originalOpacity;
      if (node.visible !== originalVisible) node.visible = originalVisible;
    }
  }

  // ---------------------------------------------------------------- nodes
  async function serializeNode(node, ctx) {
    var abs = G.fromFigma(node.absoluteTransform);
    var local = G.relativeTo(ctx.parentAbs, abs);
    var comp = G.relativeTo(ctx.rootAbs, abs);
    var w = node.width || 0, h = node.height || 0;
    var rasterReason = shouldRaster(node);
    var type = rasterReason ? "image" : TYPE_MAP[node.type];

    var out = {
      id: node.id,
      name: node.name,
      figmaType: node.type,
      type: type,
      visible: node.visible !== false,
      opacity: node.opacity === undefined ? 1 : G.round(node.opacity, 4),
      blend: G.aeBlendName(node.blendMode || "PASS_THROUGH"),
      figmaBlend: node.blendMode || "PASS_THROUGH",
      size: { w: G.round(w), h: G.round(h) },
      transform: { local: G.decompose(local), comp: G.decompose(comp), matrixLocal: local.map(function (v) { return G.round(v, 6); }), matrixComp: comp.map(function (v) { return G.round(v, 6); }) },
      isMask: node.isMask === true,
      maskType: node.isMask ? (node.maskType || "ALPHA") : null,
      clipsContent: node.clipsContent === true,
      fills: serializePaints(node.fills, node, w, h, comp),
      strokes: serializeStrokes(node, w, h, comp),
      effects: serializeEffects(node),
      children: []
    };
    if (out.transform.local.skew) warn(node, "Skew " + out.transform.local.skew + "deg cannot be represented on an AE layer; ignored.");

    if (node.layoutMode && node.layoutMode !== "NONE") {
      out.autolayout = { mode: node.layoutMode, itemSpacing: node.itemSpacing, padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft], primaryAlign: node.primaryAxisAlignItems, counterAlign: node.counterAxisAlignItems, wrap: node.layoutWrap || "NO_WRAP" };
    }
    if (node.type === "INSTANCE") {
      var main = typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : null;
      out.component = { kind: "instance", mainId: main ? main.id : null, mainName: main ? main.name : null, hasOverrides: !!(node.overrides && node.overrides.length) };
    } else if (node.type === "COMPONENT") {
      out.component = { kind: "component", mainId: node.id, mainName: node.name, hasOverrides: false };
    }

    if (rasterReason) {
      var assetId = "img_" + (++imageCounter);
      out.raster = { asset: assetId, reason: rasterReason };
      rasterTasks.push({ node: node, out: out, ctx: ctx, assetId: assetId });
      // images keep their effects list: dropShadow/layerBlur were hidden for export and get rebuilt in AE,
      // innerShadow/backgroundBlur stay baked into the PNG.
      for (var e = 0; e < out.effects.length; e++) {
        if (out.effects[e].type === "innerShadow" || out.effects[e].type === "backgroundBlur") out.effects[e].bakedIntoRaster = true;
      }
      return out;
    }

    if (isFillContainer(node) && hasImagePaint(node.fills)) {
      var bgAsset = "img_" + (++imageCounter);
      out.bgRaster = { asset: bgAsset, reason: "imageFill" };
      rasterTasks.push({ node: node, out: out, ctx: { rootAbs: abs, parentAbs: abs }, assetId: bgAsset, bg: true });
    }

    if (type === "text") out.text = await serializeText(node, w, h, comp);
    var geom = geometryFor(node, type);
    if (geom) out.geometry = geom;

    if (CONTAINERS[node.type] && node.children) {
      if (type === "boolean") out.booleanOp = node.booleanOperation;
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        if (child.type === "SLICE") continue;
        out.children.push(await serializeNode(child, { rootAbs: ctx.rootAbs, parentAbs: abs, depth: ctx.depth + 1 }));
      }
    }
    return out;
  }

  async function runRasterTasks(images) {
    for (var i = 0; i < rasterTasks.length; i++) {
      var t = rasterTasks[i];
      try {
        var r = t.bg ? await exportImageFill(t.node, opts.rasterScaleCap) : await exportRaster(t.node, opts.rasterScaleCap);
        // Image placement: PNG pixel grid scaled by 1/scale, top-left at the absolute render bounds.
        var imgAbs = [1 / r.scale, 0, 0, 1 / r.scale, r.bounds.x, r.bounds.y];
        var local = G.relativeTo(t.ctx.parentAbs, imgAbs);
        var comp = G.relativeTo(t.ctx.rootAbs, imgAbs);
        var rec = t.bg ? t.out.bgRaster : t.out.raster;
        if (t.bg) rec.transform = { local: G.decompose(local), matrixLocal: local, rasterPlacement: true };
        else t.out.transform = { local: G.decompose(local), comp: G.decompose(comp), matrixLocal: local, matrixComp: comp, rasterPlacement: true };
        rec.scale = r.scale;
        rec.pixelSize = { w: Math.round(r.bounds.width * r.scale), h: Math.round(r.bounds.height * r.scale) };
        rec.bounds = { x: G.round(r.bounds.x), y: G.round(r.bounds.y), w: G.round(r.bounds.width), h: G.round(r.bounds.height) };
        images.push({ id: t.assetId, bytes: r.bytes, nodeId: t.node.id });
      } catch (err) {
        warn(t.node, "PNG export failed: " + (err && err.message ? err.message : err));
        (t.bg ? t.out.bgRaster : t.out.raster).failed = true;
      }
    }
  }

  async function serialize(roots, meta) {
    warnings = []; rasterTasks = []; imageCounter = 0;
    var comps = [];
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      var rootAbs = G.fromFigma(root.absoluteTransform);
      var node = await serializeNode(root, { rootAbs: rootAbs, parentAbs: rootAbs, depth: 0 });
      comps.push({ id: root.id, name: root.name, width: Math.max(1, Math.round(root.width)), height: Math.max(1, Math.round(root.height)), background: node.fills, root: node });
    }
    var images = [];
    await runRasterTasks(images);
    var assets = { images: {} };
    for (var k = 0; k < images.length; k++) assets.images[images[k].id] = { file: images[k].id + ".png", nodeId: images[k].nodeId };
    var job = {
      schema: G.SCHEMA_ID,
      version: G.SCHEMA_VERSION,
      id: (meta && meta.jobId) || ("job-" + Date.now()),
      createdAt: new Date().toISOString(),
      source: Object.assign({ app: "figma", plugin: "uiscore-bridge-figma " + opts.pluginVersion }, (meta && meta.source) || {}),
      options: { compMode: opts.compMode, groupsAs: opts.groupsAs, rasterScaleCap: opts.rasterScaleCap, fps: opts.fps, duration: opts.duration },
      comps: comps,
      assets: assets,
      warnings: warnings
    };
    return { job: job, images: images };
  }

  return { serialize: serialize, _exportRaster: exportRaster };
}

if (typeof module !== "undefined" && module.exports) { module.exports = { createUBSerializer: createUBSerializer }; }
