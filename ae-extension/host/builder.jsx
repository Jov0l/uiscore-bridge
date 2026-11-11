/*
 * Uiscore Bridge - After Effects builder (ExtendScript, ES3).
 * Reads a job.json written by the panel's Node bridge and builds comps/layers.
 * Depends on UBJSON (json.jsx) and UBGeom (geom.jsx).
 *
 * Entry points (called by the panel via CSInterface.evalScript):
 *   UiscoreBridge.importJob(jobJsonPath) -> JSON string { ok, summary, warnings, comps }
 *   UiscoreBridge.projectFolder()        -> folder of the saved .aep or ""
 *   UiscoreBridge.ping()                 -> "ok <AE version>"
 */
var UiscoreBridge = (function () {
    var G = UBGeom;
    var B = {};
    var MN = {
        root: "ADBE Root Vectors Group", group: "ADBE Vector Group", vectors: "ADBE Vectors Group",
        rect: "ADBE Vector Shape - Rect", ellipse: "ADBE Vector Shape - Ellipse", pathItem: "ADBE Vector Shape - Group", pathProp: "ADBE Vector Shape",
        fill: "ADBE Vector Graphic - Fill", gfill: "ADBE Vector Graphic - G-Fill", stroke: "ADBE Vector Graphic - Stroke", gstroke: "ADBE Vector Graphic - G-Stroke",
        offset: "ADBE Vector Filter - Offset", merge: "ADBE Vector Filter - Merge",
        transform: "ADBE Transform Group", effects: "ADBE Effect Parade"
    };

    var S; // per-import state

    function warn(node, msg) { S.warnings.push((node && node.name ? node.name + ": " : "") + msg); }
    function has(o, k) { return o !== null && o !== undefined && o[k] !== undefined && o[k] !== null; }

    // ------------------------------------------------------------ project folders
    function findOrMakeFolder(name, parent) {
        var i, it;
        for (i = 1; i <= app.project.numItems; i++) {
            it = app.project.item(i);
            if (it instanceof FolderItem && it.name === name && it.parentFolder && it.parentFolder.id === parent.id) return it;
        }
        var f = app.project.items.addFolder(name);
        f.parentFolder = parent;
        return f;
    }
    function setupFolders(job) {
        var root = findOrMakeFolder("Uiscore Bridge", app.project.rootFolder);
        var jobName = job.comps[0].name + (job.comps.length > 1 ? " +" + (job.comps.length - 1) : "") + " (" + String(job.createdAt || "").substr(0, 16).replace("T", " ") + ")";
        var jf = app.project.items.addFolder(jobName);
        jf.parentFolder = root;
        S.folders = {
            job: jf,
            precomps: null, images: null,
            components: findOrMakeFolder("Components", root)
        };
    }
    function folder(kind) {
        if (!S.folders[kind]) {
            var f = app.project.items.addFolder(kind === "images" ? "Images" : "Precomps");
            f.parentFolder = S.folders.job;
            S.folders[kind] = f;
        }
        return S.folders[kind];
    }

    // ------------------------------------------------------------ comps & layers
    function newComp(name, w, h, parentFolder) {
        var c = app.project.items.addComp(String(name).substr(0, 250) || "Comp", Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), 1, S.duration, S.fps);
        c.parentFolder = parentFolder;
        S.stats.comps++;
        return c;
    }
    function ensureActive(comp) {
        if (app.project.activeItem !== comp) { try { comp.openInViewer(); } catch (e) {} }
    }

    function applyTransform(layer, t, anchor) {
        var tr = layer.property(MN.transform);
        tr.property("ADBE Anchor Point").setValue(anchor || [0, 0]);
        tr.property("ADBE Position").setValue([t.position[0], t.position[1]]);
        tr.property("ADBE Scale").setValue([t.scale[0] * 100, t.scale[1] * 100]);
        tr.property("ADBE Rotate Z").setValue(t.rotation);
    }

    function applyCommon(layer, node, extraOpacity) {
        layer.name = String(node.name || node.type).substr(0, 250);
        var op = (node.opacity === undefined ? 1 : node.opacity) * (extraOpacity === undefined ? 1 : extraOpacity);
        if (op < 0.9999) layer.property(MN.transform).property("ADBE Opacity").setValue(G.round(op * 100, 3));
        if (node.blend && node.blend !== "NORMAL") {
            try { layer.blendingMode = BlendingMode[node.blend]; } catch (e) { warn(node, "Blend mode " + node.blend + " not applied"); }
        }
        if (node.visible === false) layer.enabled = false;
        layer.comment = "figma:" + node.id;
    }

    // Track matte (AE 2023+ setTrackMatte, legacy trackMatteType otherwise). `matte` must be directly above `layer` for legacy.
    function setMatte(layer, matte, luma) {
        if (typeof layer.setTrackMatte === "function") {
            layer.setTrackMatte(matte, luma ? TrackMatteType.LUMA : TrackMatteType.ALPHA);
            matte.enabled = false;
        } else {
            matte.moveBefore(layer);
            layer.trackMatteType = luma ? TrackMatteType.LUMA : TrackMatteType.ALPHA;
        }
        S.stats.mattes++;
    }

    // ------------------------------------------------------------ shape contents
    function makeShape(p) {
        var sh = new Shape();
        sh.vertices = p.vertices; sh.inTangents = p.inTangents; sh.outTangents = p.outTangents; sh.closed = p.closed;
        return sh;
    }
    function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
    function isUniformRadius(r) { return !isArr(r) || (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]); }
    function radiusValue(r) { return isArr(r) ? Math.max(r[0], r[1], r[2], r[3]) : (r || 0); }

    // Adds path items for node geometry into a "Contents" (ADBE Vectors Group). Returns { closed, evenOdd }.
    function addPaths(vectors, node, geomOverride) {
        var g = geomOverride || node.geometry || { primitive: "rect", radius: 0 };
        var w = node.size.w, h = node.size.h, info = { closed: true, evenOdd: false };
        if (g.primitive === "rect") {
            if (isUniformRadius(g.radius)) {
                var r = vectors.addProperty(MN.rect);
                r.property("ADBE Vector Rect Size").setValue([w, h]);
                r.property("ADBE Vector Rect Position").setValue([w / 2, h / 2]);
                if (radiusValue(g.radius) > 0) r.property("ADBE Vector Rect Roundness").setValue(radiusValue(g.radius));
            } else {
                var rp = vectors.addProperty(MN.pathItem);
                rp.property(MN.pathProp).setValue(makeShape(G.roundedRectPath(w, h, g.radius)));
                rp.name = "Rounded Rect";
            }
        } else if (g.primitive === "ellipse") {
            var e = vectors.addProperty(MN.ellipse);
            e.property("ADBE Vector Ellipse Size").setValue([w, h]);
            e.property("ADBE Vector Ellipse Position").setValue([w / 2, h / 2]);
        } else if (g.primitive === "path") {
            var paths = g.paths || [], i;
            info.closed = false;
            for (i = 0; i < paths.length; i++) {
                if (!paths[i].vertices || paths[i].vertices.length < 1) continue;
                var pp = vectors.addProperty(MN.pathItem);
                pp.property(MN.pathProp).setValue(makeShape(paths[i]));
                pp.name = "Path " + (i + 1);
                if (paths[i].closed) info.closed = true;
                if (paths[i].windingRule === "EVENODD") info.evenOdd = true;
            }
            if (!paths.length) warn(node, "No geometry exported");
        }
        return info;
    }

    function setColorProp(prop, rgba) { prop.setValue([rgba[0], rgba[1], rgba[2], 1]); }

    // Record gradient props to colorize after the layer is complete (applyPreset invalidates references).
    function propPath(prop) {
        var path = [], p = prop;
        while (p && p.parentProperty) { path.unshift(p.propertyIndex); p = p.parentProperty; }
        return path;
    }
    function resolvePath(layer, path) {
        var p = layer, i;
        for (i = 0; i < path.length; i++) { p = p.property(path[i]); if (!p) return null; }
        return p;
    }

    function addGradientPaint(vectors, node, paint, isStroke, pending) {
        var gp = vectors.addProperty(isStroke ? MN.gstroke : MN.gfill);
        var hd = paint.handles;
        gp.property("ADBE Vector Grad Type").setValue(G.aeGradientType(paint.kind));
        gp.property("ADBE Vector Grad Start Pt").setValue(hd.start);
        gp.property("ADBE Vector Grad End Pt").setValue(hd.end);
        gp.property(isStroke ? "ADBE Vector Stroke Opacity" : "ADBE Vector Fill Opacity").setValue(G.round(paint.opacity * 100, 3));
        if (paint.visible === false) gp.enabled = false;
        pending.push({ path: propPath(gp), paint: paint, isStroke: isStroke });
        return gp;
    }

    function addSolidFill(vectors, paint, evenOdd) {
        var f = vectors.addProperty(MN.fill);
        setColorProp(f.property("ADBE Vector Fill Color"), paint.color);
        f.property("ADBE Vector Fill Opacity").setValue(G.round(paint.opacity * paint.color[3] * 100, 3));
        if (evenOdd) f.property("ADBE Vector Fill Rule").setValue(2);
        if (paint.visible === false) f.enabled = false;
        return f;
    }

    function styleStroke(sp, st) {
        sp.property("ADBE Vector Stroke Width").setValue(st.weight);
        sp.property("ADBE Vector Stroke Line Cap").setValue(st.aeCap);
        sp.property("ADBE Vector Stroke Line Join").setValue(st.aeJoin);
        try { sp.property("ADBE Vector Stroke Miter Limit").setValue(Math.max(1, st.miterLimit)); } catch (e) {}
        if (st.dash && st.dash.length) {
            var d = sp.property("ADBE Vector Stroke Dashes"), i;
            for (i = 0; i < st.dash.length && i < 6; i++) {
                d.addProperty((i % 2 === 0 ? "ADBE Vector Stroke Dash " : "ADBE Vector Stroke Gap ") + (Math.floor(i / 2) + 1)).setValue(st.dash[i]);
            }
        }
    }

    function addStrokes(vectors, node, st, pending) {
        var i, p;
        // Figma paint order: index 0 = bottom. AE contents: first = front. Iterate top -> bottom.
        for (i = st.paints.length - 1; i >= 0; i--) {
            p = st.paints[i];
            if (p.type === "solid") {
                var sp = vectors.addProperty(MN.stroke);
                setColorProp(sp.property("ADBE Vector Stroke Color"), p.color);
                sp.property("ADBE Vector Stroke Opacity").setValue(G.round(p.opacity * p.color[3] * 100, 3));
                styleStroke(sp, st);
                if (p.visible === false) sp.enabled = false;
            } else if (p.type === "gradient") {
                var gs = addGradientPaint(vectors, node, p, true, pending);
                styleStroke(gs, st);
            } else warn(node, "Stroke paint " + p.type + " skipped");
        }
    }

    function addFills(vectors, node, fills, evenOdd, pending) {
        var i, p;
        for (i = fills.length - 1; i >= 0; i--) {
            p = fills[i];
            if (p.type === "solid") addSolidFill(vectors, p, evenOdd);
            else if (p.type === "gradient") {
                var gf = addGradientPaint(vectors, node, p, false, pending);
                if (evenOdd) gf.property("ADBE Vector Fill Rule").setValue(2);
            } else if (p.type === "image") warn(node, "Image fill on a vector shape is skipped (mark the layer with * to rasterize)");
            if (p.blend && p.blend !== "NORMAL") warn(node, "Per-fill blend mode " + p.blend + " ignored");
        }
    }

    // Native editable gradient colors via .ffx preset applied to the selected Colors property.
    function applyNativeGradient(comp, layer, rec) {
        var gp = resolvePath(layer, rec.path);
        if (!gp) return false;
        var f = new File(rec.paint.ffx);
        if (!f.exists) return false;
        ensureActive(comp);
        var i;
        for (i = 1; i <= comp.numLayers; i++) if (comp.layer(i).selected) comp.layer(i).selected = false;
        var root = layer.property(MN.root);
        var before = root.numProperties;
        layer.selected = true;
        var colors = gp.property("ADBE Vector Grad Colors");
        colors.selected = true;
        try {
            layer.applyPreset(f);
        } catch (e) {
            layer.selected = false;
            return false;
        }
        root = layer.property(MN.root);
        if (root.numProperties > before) {
            // AE appended the preset's group instead of replacing the selected Colors -> undo that, fall back.
            for (i = root.numProperties; i > before; i--) root.property(i).remove();
            layer.selected = false;
            return false;
        }
        layer.selected = false;
        return true;
    }

    // Fallback: Gradient Ramp (2 colors, editable) + Set Matte to keep the layer's own alpha.
    function applyRamp(layer, node, paint, handlesOverride) {
        var hd = handlesOverride || paint.handles;
        var r = G.rampFallback(hd, paint.stops.length ? toFigmaStops(paint.stops) : []);
        var fx = layer.property(MN.effects);
        var ramp = fx.addProperty("ADBE Ramp");
        ramp.property("ADBE Ramp-0001").setValue(r.start);
        ramp.property("ADBE Ramp-0002").setValue(r.startColor);
        ramp.property("ADBE Ramp-0003").setValue(r.end);
        ramp.property("ADBE Ramp-0004").setValue(r.endColor);
        ramp.property("ADBE Ramp-0005").setValue(r.shape);
        try {
            var sm = fx.addProperty("ADBE Set Matte3");
            sm.property("ADBE Set Matte3-0001").setValue(layer.index);
            sm.property("ADBE Set Matte3-0002").setValue(4); // Alpha channel
        } catch (e) { warn(node, "Set Matte for gradient ramp failed: " + e); }
        if (r.lossy) warn(node, "Gradient has " + paint.stops.length + " stops; fallback ramp keeps first and last only");
        S.stats.gradientsRamp++;
    }
    function toFigmaStops(stops) {
        var out = [], i;
        for (i = 0; i < stops.length; i++) out.push({ position: stops[i].position, color: { r: stops[i].color[0], g: stops[i].color[1], b: stops[i].color[2], a: stops[i].color[3] } });
        return out;
    }

    function finishGradients(comp, layer, node, pending) {
        var i, rec, ok;
        for (i = 0; i < pending.length; i++) {
            rec = pending[i];
            var strategy = G.gradientStrategy(rec.paint, node.type, { presetsAvailable: S.presetsOk });
            ok = false;
            if (strategy === "native") {
                try { ok = applyNativeGradient(comp, layer, rec); } catch (e) { ok = false; }
                if (ok) { S.stats.gradientsNative++; continue; }
                warn(node, "Native gradient preset could not be applied" + (rec.paint.ffxError ? " (" + rec.paint.ffxError + ")" : "") + "; using Gradient Ramp fallback");
            } else if (rec.paint.ffxError) {
                warn(node, "Gradient preset missing (" + rec.paint.ffxError + "); using Gradient Ramp fallback");
            }
            // Fallback: turn the gradient paint into a solid of the first stop + ramp effect on the layer.
            var gp = resolvePath(layer, rec.path);
            if (gp) gp.enabled = false;
            applyRamp(layer, node, rec.paint);
        }
    }

    /*
     * Builds a shape layer for any vector node (rect, ellipse, path, polygon, star, line, boolean)
     * and for frame backgrounds. Layer origin = Figma node origin (top-left), anchor [0,0].
     */
    function buildShapeLayer(comp, node, opts) {
        opts = opts || {};
        var layer = comp.layers.addShape();
        var root = layer.property(MN.root);
        var pending = [];
        var st = node.strokes;
        var fills = opts.noFills ? [] : (node.fills || []);
        var strokeSeparate = st && st.weight > 0 && st.align !== "CENTER";

        // Separate stroke group for INSIDE / OUTSIDE strokes (Offset Paths +-weight/2) - added first = in front.
        var info;
        if (strokeSeparate) {
            var sg = root.addProperty(MN.group);
            sg.name = "Stroke (" + st.align.toLowerCase() + ")";
            var sv = sg.property(MN.vectors);
            info = addPaths(sv, node, opts.geometry);
            if (info.closed) {
                var off = sv.addProperty(MN.offset);
                off.property("ADBE Vector Offset Amount").setValue(G.strokeOffset(st.align, st.weight));
                off.property("ADBE Vector Offset Line Join").setValue(st.aeJoin);
            }
            addStrokes(sv, node, st, pending);
        }
        var g = root.addProperty(MN.group);
        g.name = node.name || "Shape";
        var v = g.property(MN.vectors);
        info = addPaths(v, node, opts.geometry);
        if (st && st.weight > 0 && !strokeSeparate) addStrokes(v, node, st, pending);
        addFills(v, node, fills, info.evenOdd, pending);

        applyCommon(layer, node, opts.extraOpacity);
        if (opts.parent) layer.parent = opts.parent;
        applyTransform(layer, opts.transform || node.transform.local);
        finishGradients(comp, layer, node, pending);
        S.stats.shapes++;
        return layer;
    }

    // ------------------------------------------------------------ text
    function resolveFont(seg) {
        var key = seg.font.family + "|" + seg.font.style;
        if (S.fontCache[key]) return S.fontCache[key];
        var ps = null;
        try {
            if (app.fonts && typeof app.fonts.getFontsByFamilyNameAndStyleName === "function") {
                var list = app.fonts.getFontsByFamilyNameAndStyleName(seg.font.family, seg.font.style);
                if (list && list.length) ps = list[0].postScriptName;
            }
        } catch (e) {}
        if (!ps) ps = seg.font.postScript;
        S.fontCache[key] = ps;
        return ps;
    }

    function styleDoc(target, seg, node, isRange) {
        var ps = resolveFont(seg);
        target.font = ps;
        target.fontSize = seg.size;
        target.tracking = seg.tracking || 0;
        if (!isRange) {
            if (seg.leading === null || seg.leading === undefined) target.autoLeading = true;
            else { target.autoLeading = false; target.leading = seg.leading; }
        } else if (seg.leading !== null && seg.leading !== undefined) {
            try { target.autoLeading = false; target.leading = seg.leading; } catch (e) {}
        }
        var fill = null, i;
        for (i = (seg.fills || []).length - 1; i >= 0; i--) if (seg.fills[i].visible !== false) { fill = seg.fills[i]; break; }
        if (fill && fill.type === "solid") { target.applyFill = true; target.fillColor = [fill.color[0], fill.color[1], fill.color[2]]; }
        else if (fill && fill.type === "gradient") { target.applyFill = true; var c = fill.stops[0].color; target.fillColor = [c[0], c[1], c[2]]; }
        else if (!fill) { target.applyFill = false; }
        if (!isRange) target.applyStroke = false;
        if (seg.textCase === "UPPER") { try { target.allCaps = true; } catch (e2) {} }
        if (seg.textCase === "SMALL_CAPS" || seg.textCase === "SMALL_CAPS_FORCED") { try { target.smallCaps = true; } catch (e3) {} }
        return fill;
    }

    function buildTextLayer(comp, node, extraOpacity, parentLayer) {
        var t = node.text;
        var chars = t.characters.replace(/\r\n|\n/g, "\r").replace(/\u2028/g, "\r");
        var isBox = t.autoResize !== "WIDTH_AND_HEIGHT";
        var layer = isBox ? comp.layers.addBoxText([Math.ceil(node.size.w) + 2, Math.ceil(node.size.h + t.size * 2)], chars) : comp.layers.addText(chars);
        var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = prop.value;
        var first = t.segments[0];
        var fill = styleDoc(doc, first, node, false);
        try { doc.justification = ParagraphJustification[t.justification]; } catch (e) {}
        prop.setValue(doc);

        // Mixed styles: per-range styling (CharacterRange API, AE 24.x+). Older AE: first style wins.
        if (t.segments.length > 1) {
            doc = prop.value;
            if (typeof doc.characterRange === "function") {
                try {
                    var i;
                    for (i = 1; i < t.segments.length; i++) {
                        var sg = t.segments[i];
                        styleDoc(doc.characterRange(sg.start, sg.end), sg, node, true);
                    }
                    prop.setValue(doc);
                } catch (e4) { warn(node, "Per-range text styling failed: " + e4); }
            } else warn(node, "Mixed text styles flattened to the first style (needs AE with TextDocument.characterRange)");
        }
        // Verify font
        var got = prop.value.font;
        if (got !== resolveFont(first)) warn(node, "Font '" + first.font.family + " " + first.font.style + "' (" + resolveFont(first) + ") not found, AE used '" + got + "'");

        var fillAlpha = (fill && fill.type === "solid") ? fill.opacity * fill.color[3] : 1;
        applyCommon(layer, node, (extraOpacity === undefined ? 1 : extraOpacity) * fillAlpha);

        var rect = layer.sourceRectAtTime(0, false);
        var boxPos = null;
        try { if (isBox && prop.value.boxTextPos) boxPos = prop.value.boxTextPos; } catch (e5) {}
        var pl = G.textPlacement(t, rect, boxPos, node.size.w, node.size.h);
        var m = node.transform.matrixLocal;
        var pos = G.apply(m, pl.local);
        var tl = node.transform.local;
        if (parentLayer) layer.parent = parentLayer;
        applyTransform(layer, { position: pos, rotation: tl.rotation, scale: tl.scale }, pl.anchor);

        if (fill && fill.type === "gradient") {
            // Ramp points live in text-layer space: shift Figma box-local handles by (anchor - local).
            var dx = pl.anchor[0] - pl.local[0], dy = pl.anchor[1] - pl.local[1], hd = fill.handles;
            applyRamp(layer, node, fill, { kind: hd.kind, start: G.offsetPoint(hd.start, dx, dy), end: G.offsetPoint(hd.end, dx, dy) });
            warn(node, "Text gradient uses Gradient Ramp (2 colors, editable)");
        }
        S.stats.texts++;
        return layer;
    }

    // ------------------------------------------------------------ images
    function buildImageLayer(comp, node, extraOpacity, parentLayer) {
        var a = S.job.assets.images[node.raster.asset];
        if (!a || node.raster.failed) { warn(node, "Raster export missing; skipped"); return null; }
        var footage = S.footage[node.raster.asset];
        if (!footage) {
            var f = new File(a.path || (S.jobDir + "/images/" + a.file));
            if (!f.exists) { warn(node, "Image file not found: " + f.fsName); return null; }
            footage = app.project.importFile(new ImportOptions(f));
            footage.parentFolder = folder("images");
            footage.name = node.name.replace(/^\*\s*/, "") + ".png";
            S.footage[node.raster.asset] = footage;
            S.stats.images++;
        }
        var layer = comp.layers.add(footage);
        applyCommon(layer, node, extraOpacity);
        if (parentLayer) layer.parent = parentLayer;
        applyTransform(layer, node.transform.local);
        return layer;
    }

    // ------------------------------------------------------------ effects
    function addEffects(comp, layer, node) {
        var list = node.effects || [], i, e, fx = layer.property(MN.effects);
        for (i = 0; i < list.length; i++) {
            e = list[i];
            if (e.visible === false || e.bakedIntoRaster) continue;
            try {
                if (e.type === "dropShadow") {
                    var ds = fx.addProperty("ADBE Drop Shadow");
                    ds.property("ADBE Drop Shadow-0001").setValue([e.color[0], e.color[1], e.color[2], 1]);
                    ds.property("ADBE Drop Shadow-0002").setValue(G.round(e.opacity * 255, 3)); // 0..255 internal range
                    ds.property("ADBE Drop Shadow-0003").setValue(e.direction);
                    ds.property("ADBE Drop Shadow-0004").setValue(e.distance);
                    ds.property("ADBE Drop Shadow-0005").setValue(e.softness);
                    S.stats.effects++;
                } else if (e.type === "layerBlur") {
                    var gb = fx.addProperty("ADBE Gaussian Blur 2");
                    gb.property("ADBE Gaussian Blur 2-0001").setValue(e.blurriness);
                    try { gb.property("ADBE Gaussian Blur 2-0003").setValue(1); } catch (e1) {}
                    S.stats.effects++;
                } else if (e.type === "innerShadow") {
                    addInnerShadow(comp, layer, node, e);
                } else if (e.type === "backgroundBlur") {
                    addBackgroundBlur(comp, layer, node, e);
                }
            } catch (err) { warn(node, "Effect " + e.type + " failed: " + err); }
        }
    }

    // Best-effort: Layer Styles > Inner Shadow via menu command (English UI command name), then set values.
    function addInnerShadow(comp, layer, node, e) {
        var id = 0;
        try { id = app.findMenuCommandId("Inner Shadow"); } catch (x) {}
        if (!id) { warn(node, "Inner shadow skipped (Layer Styles menu not found; non-English AE UI?)"); return; }
        ensureActive(comp);
        var i;
        for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
        layer.selected = true;
        app.executeCommand(id);
        layer.selected = false;
        var ls = layer.property("ADBE Layer Styles");
        var isg = ls ? ls.property("innerShadow/enabled") : null;
        if (!isg) { warn(node, "Inner shadow layer style not created"); return; }
        try { isg.property("innerShadow/useGlobalAngle").setValue(0); } catch (a) {}
        try { isg.property("innerShadow/color").setValue([e.color[0], e.color[1], e.color[2], 1]); } catch (b) {}
        try { isg.property("innerShadow/opacity").setValue(G.round(e.opacity * 100, 3)); } catch (c) {}
        try { isg.property("innerShadow/localLightingAngle").setValue(G.innerShadowAngle(e.offset[0], e.offset[1])); } catch (d) {}
        try { isg.property("innerShadow/distance").setValue(e.distance); } catch (f) {}
        try { isg.property("innerShadow/blur").setValue(e.softness); } catch (g) {}
        try { isg.property("innerShadow/mode2").setValue(1); } catch (h) {} // Normal
        S.stats.effects++;
        warn(node, "Inner shadow created as Layer Style (best-effort, verify angle/size)");
    }

    // Best-effort: an adjustment shape layer with the node's outline + Gaussian Blur, placed just below the node.
    function addBackgroundBlur(comp, layer, node, e) {
        var geom = node.geometry;
        if (!geom && (node.type === "frame" || node.type === "component" || node.type === "instance" || node.type === "group")) geom = { primitive: "rect", radius: node.geometry ? node.geometry.radius : 0 };
        if (!geom) { warn(node, "Background blur needs vector geometry; skipped"); return; }
        var solid = { type: "solid", color: [1, 1, 1, 1], opacity: 1, visible: true };
        var proxy = { id: node.id, name: node.name + " (BG blur)", type: "rect", size: node.size, transform: node.transform, geometry: geom, fills: [solid], strokes: null, opacity: 1, blend: "NORMAL", visible: node.visible };
        var adj = buildShapeLayer(comp, proxy, { geometry: geom, parent: layer.parent || null });
        adj.adjustmentLayer = true;
        var gb = adj.property(MN.effects).addProperty("ADBE Gaussian Blur 2");
        gb.property("ADBE Gaussian Blur 2-0001").setValue(e.blurriness);
        try { gb.property("ADBE Gaussian Blur 2-0003").setValue(1); } catch (x) {}
        adj.moveAfter(layer);
        S.stats.effects++;
        warn(node, "Background blur approximated with an adjustment layer (best-effort)");
    }

    // ------------------------------------------------------------ containers
    function frameBackground(comp, node) {
        var hasPaint = false, i;
        for (i = 0; i < (node.fills || []).length; i++) if (node.fills[i].visible !== false && node.fills[i].type !== "image") hasPaint = true;
        var hasStroke = node.strokes && node.strokes.weight > 0;
        if (!hasPaint && !hasStroke) return null;
        var proxy = {
            id: node.id, name: (node.name || "Frame") + " bg", type: "rect", size: node.size,
            geometry: node.geometry || { primitive: "rect", radius: 0 }, fills: node.fills, strokes: node.strokes,
            opacity: 1, blend: "NORMAL", visible: true
        };
        var bg = buildShapeLayer(comp, proxy, { transform: { position: [0, 0], rotation: 0, scale: [1, 1] } });
        return bg;
    }

    function componentKey(node) {
        if (!node.component || !node.component.mainId || node.component.hasOverrides) return null;
        return node.component.mainId + "@" + node.size.w + "x" + node.size.h;
    }

    // Frame / component / instance / group(precomp mode) -> precomp layer.
    function buildPrecompNode(comp, node, extraOpacity, parentLayer) {
        var isGroup = node.type === "group" || node.type === "boolean";
        var key = componentKey(node);
        var sub = key ? S.componentCache[key] : null;
        if (!sub) {
            var isComp = node.type === "component" || node.type === "instance";
            var nm = isComp && node.component && node.component.mainName ? node.component.mainName : node.name;
            sub = newComp(nm, node.size.w, node.size.h, isComp ? S.folders.components : folder("precomps"));
            if (!isGroup) frameBackground(sub, node);
            buildChildren(sub, node.children || [], null, 1);
            if (key) S.componentCache[key] = sub;
        }
        var layer = comp.layers.add(sub);
        applyCommon(layer, node, extraOpacity);
        if (parentLayer) layer.parent = parentLayer;
        applyTransform(layer, node.transform.local);
        // Groups never clip in Figma; frames clip only with clipsContent. Collapse = no clipping, pass-through.
        if (isGroup || !node.clipsContent) {
            try { layer.collapseTransformation = true; } catch (e) {}
        } else if (node.geometry && (radiusValue(node.geometry.radius) > 0 || !isUniformRadius(node.geometry.radius))) {
            // Rounded clipping -> layer mask with the frame's rounded rect (masks apply before effects,
            // so the frame's drop shadow follows the rounded outline).
            var r = node.geometry.radius, path = G.roundedRectPath(node.size.w, node.size.h, r);
            var mask = layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
            mask.name = "Clip";
            mask.property("ADBE Mask Shape").setValue(makeShape(path));
            S.stats.mattes++;
        }
        S.stats.precomps++;
        return layer;
    }

    // Group as parented null (groupsAs = "parent").
    function buildParentedGroup(comp, node, parentLayer, extraOpacity) {
        var nul = comp.layers.addNull();
        nul.name = "\u25B8 " + node.name;
        if (parentLayer) nul.parent = parentLayer;
        applyTransform(nul, node.transform.local);
        nul.enabled = false;
        if (node.visible === false) warn(node, "Hidden group exported as visible children (nulls cannot hide children)");
        var op = (node.opacity === undefined ? 1 : node.opacity) * (extraOpacity === undefined ? 1 : extraOpacity);
        if (node.blend && node.blend !== "NORMAL") warn(node, "Group blend mode needs precomp mode; ignored with parented nulls");
        buildChildren(comp, node.children || [], nul, op);
        return nul;
    }

    function buildLeaf(comp, node, parentLayer, extraOpacity) {
        if (node.type === "image") return buildImageLayer(comp, node, extraOpacity, parentLayer);
        if (node.type === "text") return buildTextLayer(comp, node, extraOpacity, parentLayer);
        if (node.geometry) return buildShapeLayer(comp, node, { extraOpacity: extraOpacity, parent: parentLayer });
        warn(node, "Unsupported node type " + node.figmaType + "; skipped");
        return null;
    }

    function buildNode(comp, node, parentLayer, extraOpacity) {
        S.stats.layers++;
        var layer;
        var isContainer = node.type === "frame" || node.type === "component" || node.type === "instance" || node.type === "group";
        if (node.type === "boolean") {
            layer = buildLeaf(comp, node, parentLayer, extraOpacity);
            if (layer) warn(node, "Boolean '" + node.booleanOp + "' imported as its flattened outline (TODO: editable Merge Paths)");
        } else if (isContainer && node.type === "group" && S.groupsAs === "parent") {
            return buildParentedGroup(comp, node, parentLayer, extraOpacity);
        } else if (isContainer) {
            layer = buildPrecompNode(comp, node, extraOpacity, parentLayer);
        } else {
            layer = buildLeaf(comp, node, parentLayer, extraOpacity);
        }
        if (layer) addEffects(comp, layer, node);
        return layer;
    }

    // Children in Figma order (index 0 = bottom). New AE layers go on top, so order is preserved.
    function buildChildren(comp, children, parentLayer, extraOpacity) {
        var items = G.groupMasks(children), i, j;
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.kind === "node") { buildNode(comp, it.node, parentLayer, extraOpacity); continue; }
            // Masked run -> precomp of the container's size + the mask shape as track matte above it.
            if (!it.content.length) continue;
            var mc = newComp("Masked by " + it.mask.name, comp.width, comp.height, folder("precomps"));
            for (j = 0; j < it.content.length; j++) buildNode(mc, it.content[j], null, 1);
            var pl = comp.layers.add(mc);
            pl.name = "Masked by " + it.mask.name;
            if (parentLayer) pl.parent = parentLayer;
            applyTransform(pl, { position: [0, 0], rotation: 0, scale: [1, 1] });
            try { pl.collapseTransformation = true; } catch (ce) {} // no clipping at precomp bounds
            if (extraOpacity !== undefined && extraOpacity < 1) pl.property(MN.transform).property("ADBE Opacity").setValue(extraOpacity * 100);
            var maskNode = it.mask;
            var matte = maskNode.type === "image" ? buildImageLayer(comp, maskNode, 1, parentLayer) : (maskNode.type === "text" ? buildTextLayer(comp, maskNode, 1, parentLayer) : (maskNode.geometry && maskNode.type !== "frame" && maskNode.type !== "group" && maskNode.type !== "component" && maskNode.type !== "instance" ? buildShapeLayer(comp, maskNode, { parent: parentLayer }) : buildPrecompNode(comp, maskNode, 1, parentLayer)));
            if (!matte) { warn(maskNode, "Mask could not be built; content left unmasked"); continue; }
            matte.enabled = true;
            setMatte(pl, matte, maskNode.maskType === "LUMINANCE");
            if (maskNode.maskType === "VECTOR") warn(maskNode, "Vector mask converted to alpha matte");
        }
    }

    // ------------------------------------------------------------ entry
    function readText(path) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("r")) throw new Error("Cannot open " + path);
        var s = f.read();
        f.close();
        return s;
    }

    B.importJob = function (jobPath) {
        S = { warnings: [], stats: { comps: 0, layers: 0, shapes: 0, texts: 0, images: 0, precomps: 0, mattes: 0, effects: 0, gradientsNative: 0, gradientsRamp: 0 }, fontCache: {}, footage: {}, componentCache: {}, presetsOk: true };
        var result = { ok: false };
        var undoOpen = false;
        try {
            var job = UBJSON.parse(readText(jobPath));
            if (job.schema !== G.SCHEMA_ID) throw new Error("Not a Uiscore Bridge job");
            S.job = job;
            S.jobDir = new File(jobPath).parent.fsName;
            S.fps = (job.options && job.options.fps) || 30;
            S.duration = (job.options && job.options.duration) || 10;
            S.groupsAs = (job.options && job.options.groupsAs) || "precomp";
            var target = (job.options && job.options.compMode === "active" && app.project.activeItem instanceof CompItem) ? app.project.activeItem : null;
            app.beginUndoGroup("Uiscore Bridge: import");
            undoOpen = true;
            setupFolders(job);
            var built = [], i;
            for (i = 0; i < job.comps.length; i++) {
                var c = job.comps[i];
                var comp = newComp(c.name, c.width, c.height, S.folders.job);
                var bgSolid = null, k;
                for (k = 0; k < (c.background || []).length; k++) if (c.background[k].type === "solid" && c.background[k].visible !== false) bgSolid = c.background[k];
                if (bgSolid) comp.bgColor = [bgSolid.color[0], bgSolid.color[1], bgSolid.color[2]];
                ensureActive(comp);
                frameBackground(comp, c.root);
                buildChildren(comp, c.root.children || [], null, 1);
                built.push(comp.name);
                if (target) {
                    var l = target.layers.add(comp);
                    var sc = G.fitScale(c.width, c.height, target.width, target.height);
                    l.property(MN.transform).property("ADBE Scale").setValue([sc, sc]);
                } else if (i === 0) {
                    comp.openInViewer();
                }
            }
            if (target) target.openInViewer();
            result.ok = true;
            result.comps = built;
            var st = S.stats;
            result.summary = st.comps + " comps, " + st.layers + " layers (" + st.shapes + " shapes, " + st.texts + " texts, " + st.images + " images), " +
                (st.gradientsNative + st.gradientsRamp) + " gradients (" + st.gradientsNative + " native, " + st.gradientsRamp + " ramp), " + st.mattes + " mattes, " + st.effects + " effects";
        } catch (e) {
            result.ok = false;
            result.error = String(e) + (e.line ? " (line " + e.line + ")" : "");
        } finally {
            if (undoOpen) app.endUndoGroup();
        }
        result.warnings = S.warnings;
        result.stats = S.stats;
        return UBJSON.stringify(result);
    };

    B.projectFolder = function () {
        try { return app.project && app.project.file ? app.project.file.parent.fsName : ""; } catch (e) { return ""; }
    };
    B.ping = function () { return "ok " + app.version; };
    return B;
})();
