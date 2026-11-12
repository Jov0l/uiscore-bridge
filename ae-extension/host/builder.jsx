/*
 * Uiscore Bridge - After Effects builder (ExtendScript, ES3).
 * Reads a job.json written by the panel's Node bridge and builds comps/layers.
 * Depends on UBJSON (json.jsx) and UBGeom (geom.jsx).
 *
 * Entry points (called by the panel via CSInterface.evalScript):
 *   UiscoreBridge.importJob(jobJsonPath) -> JSON string { ok, summary, warnings, comps }
 *   UiscoreBridge.projectFolder()        -> folder of the saved .aep or ""
 *   UiscoreBridge.ping()                 -> "ok <AE version>"
 *   UiscoreBridge.precompose()           -> JSON { ok, summary, warnings, error }  (panel "Groups > Precomp")
 *   UiscoreBridge.decompose()            -> JSON { ok, summary, warnings, error }  (panel "Groups > Decomp")
 *   UiscoreBridge.toggleVisibility()     -> JSON { ok, summary, warnings, error }  (panel "Groups > Toggle")
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
        var c = app.project.items.addComp(String(name).substr(0, 250) || "Comp", Math.min(30000, Math.max(4, Math.round(w))), Math.min(30000, Math.max(4, Math.round(h))), 1, S.duration, S.fps);
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
            }
            if (p.blend && p.blend !== "NORMAL" && fills.length > 1) warn(node, "Per-fill blend mode " + p.blend + " ignored (fills kept on one layer)");
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
        var all = opts.noFills ? [] : (node.fills || []), vis = [], i;
        for (i = 0; i < all.length; i++) {
            if (all[i].type === "image") { warn(node, "Image fill on a vector shape is skipped (mark the layer with * to rasterize)"); continue; }
            if (all[i].visible !== false) vis.push(all[i]);
        }
        if (opts.noSplit || vis.length <= 1) {
            var one = buildShapeLayerPart(comp, node, opts, all, node.strokes, null, vis.length === 1 ? vis[0].blend : null);
            S.lastShape = { node: node, layers: [one] };
            return one;
        }
        // Several visible fills: one shape layer per fill (Figma index 0 = bottom = created first, AE adds on top),
        // each with the fill's blend mode as the layer blend mode; strokes ride on the topmost fill layer.
        var layers = [], base = String(node.name || "Shape").substr(0, 230);
        for (i = 0; i < vis.length; i++) {
            layers.push(buildShapeLayerPart(comp, node, opts, [vis[i]], i === vis.length - 1 ? node.strokes : null, base + " fill " + (i + 1), vis[i].blend));
        }
        S.lastShape = { node: node, layers: layers };
        return layers[0];
    }

    // AE blend mode for a Figma paint/layer blend name (already mapped by UBGeom.aeBlendName, e.g. LINEAR_DODGE -> ADD).
    function setLayerBlend(layer, node, blend) {
        if (!blend || blend === "NORMAL") return;
        var bm = (typeof BlendingMode !== "undefined") ? BlendingMode[blend] : undefined;
        if (bm === undefined) { warn(node, "Blend mode " + blend + " has no After Effects equivalent; left Normal"); return; }
        if (node.blend && node.blend !== "NORMAL" && node.blend !== blend) warn(node, "Layer blend " + node.blend + " replaced by the fill's blend " + blend);
        layer.blendingMode = bm;
    }

    function buildShapeLayerPart(comp, node, opts, fills, st, nameOverride, paintBlend) {
        var layer = comp.layers.addShape();
        var root = layer.property(MN.root);
        var pending = [];
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
        var shapeFills = [], fi;
        for (fi = 0; fi < fills.length; fi++) if (fills[fi].type !== "image") shapeFills.push(fills[fi]);
        addFills(v, node, shapeFills, info.evenOdd, pending);

        applyCommon(layer, node, opts.extraOpacity);
        if (nameOverride) layer.name = nameOverride;
        if (shapeFills.length === 1) setLayerBlend(layer, node, paintBlend);
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
    // Split shapes (one layer per fill): drop shadows / background blur on the bottom layer (render once),
    // inner shadow on the top layer (above every fill), layer blur on every layer.
    function addEffects(comp, layer, node) {
        var list = node.effects || [], i, j, e, fx = layer.property(MN.effects);
        var parts = (S.lastShape && S.lastShape.node === node && S.lastShape.layers[0] === layer) ? S.lastShape.layers : [layer];
        var top = parts[parts.length - 1], spreadN = 0;
        for (i = 0; i < list.length; i++) {
            e = list[i];
            if (e.visible === false || e.bakedIntoRaster) continue;
            try {
                if (e.type === "dropShadow" && e.spread && spreadShadowGeometry(node)) {
                    buildSpreadShadow(comp, node, layer, e, ++spreadN);
                } else if (e.type === "dropShadow") {
                    if (e.spread) warn(node, "Shadow spread " + e.spread + " is not supported on this layer type; Drop Shadow without spread");
                    var ds = fx.addProperty("ADBE Drop Shadow");
                    ds.property("ADBE Drop Shadow-0001").setValue([e.color[0], e.color[1], e.color[2], 1]);
                    ds.property("ADBE Drop Shadow-0002").setValue(G.round(e.opacity * 255, 3)); // 0..255 internal range
                    ds.property("ADBE Drop Shadow-0003").setValue(e.direction);
                    ds.property("ADBE Drop Shadow-0004").setValue(e.distance);
                    ds.property("ADBE Drop Shadow-0005").setValue(e.softness);
                    S.stats.effects++;
                } else if (e.type === "layerBlur") {
                    for (j = 0; j < parts.length; j++) {
                        var gb = parts[j].property(MN.effects).addProperty("ADBE Gaussian Blur 2");
                        gb.property("ADBE Gaussian Blur 2-0001").setValue(e.blurriness);
                        try { gb.property("ADBE Gaussian Blur 2-0003").setValue(1); } catch (e1) {}
                    }
                    S.stats.effects++;
                } else if (e.type === "innerShadow") {
                    addInnerShadow(comp, top, node, e);
                } else if (e.type === "backgroundBlur") {
                    addBackgroundBlur(comp, layer, node, e);
                }
            } catch (err) { warn(node, "Effect " + e.type + " failed: " + err); }
        }
    }

    var INNER_SHADOW_CMD = 9001; // Layer > Layer Styles > Inner Shadow (same id in every UI language)
    // Best-effort: Layer Styles > Inner Shadow via menu command, then set values.
    // Geometry for a spread shadow: vector shapes and frames (their background rect); null for text, images, groups.
    function spreadShadowGeometry(node) {
        if (node.type === "text" || node.type === "image" || node.type === "group") return null;
        if (node.geometry) return node.geometry;
        if (node.type === "frame" || node.type === "component" || node.type === "instance") return { primitive: "rect", radius: 0 };
        return null;
    }
    /*
     * Figma DROP_SHADOW with spread != 0 (AE Drop Shadow has no spread): its own shape layer directly below the
     * object - same path grown/shrunk by Offset Paths (Amount = spread, round join), a solid fill with the shadow
     * color/alpha, moved by the shadow offset (shape group position, i.e. in the object's local space like Figma),
     * and Gaussian Blur. Blur conversion: Figma's shadow radius is a CSS-style blur radius (~2 sigma); AE Gaussian
     * Blur "Blurriness" also spans ~2 sigma, so Blurriness = radius (same 1:1 rule as layer blur / Drop Shadow softness).
     * Repeat Edge Pixels off so the blur fades out past the layer bounds. Several shadows: Figma order, first lowest.
     */
    function buildSpreadShadow(comp, node, objLayer, e, n) {
        var geom = spreadShadowGeometry(node);
        var layer = comp.layers.addShape();
        layer.name = String(node.name || "Shape").substr(0, 230) + " shadow " + n;
        var g = layer.property(MN.root).addProperty(MN.group);
        g.name = "Shadow";
        var v = g.property(MN.vectors);
        addPaths(v, node, geom);
        var off = v.addProperty(MN.offset);
        off.property("ADBE Vector Offset Amount").setValue(e.spread);
        off.property("ADBE Vector Offset Line Join").setValue(2); // round
        var f = v.addProperty(MN.fill);
        f.property("ADBE Vector Fill Color").setValue([e.color[0], e.color[1], e.color[2], 1]);
        f.property("ADBE Vector Fill Opacity").setValue(G.round((e.opacity === undefined ? 1 : e.opacity) * 100, 3));
        var ofs = e.offset || [0, 0];
        g.property("ADBE Vector Transform Group").property("ADBE Vector Position").setValue([ofs[0], ofs[1]]);
        var gb = layer.property(MN.effects).addProperty("ADBE Gaussian Blur 2");
        gb.property("ADBE Gaussian Blur 2-0001").setValue(G.round(e.radius || 0, 3));
        try { gb.property("ADBE Gaussian Blur 2-0003").setValue(0); } catch (x) {}
        // same parent (set before the values so AE doesn't compensate) / transform / opacity / visibility as the object
        if (objLayer.parent) layer.parent = objLayer.parent;
        var tsrc = objLayer.property(MN.transform), tdst = layer.property(MN.transform), k;
        var props = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"];
        for (k = 0; k < props.length; k++) { var val = tsrc.property(props[k]).value; if (val !== undefined && val !== null) tdst.property(props[k]).setValue(val); }
        if (node.visible === false) layer.enabled = false;
        layer.comment = "figma:" + node.id + " shadow";
        layer.moveAfter(objLayer); // directly below the object; later shadows push earlier ones down (first = lowest)
        S.stats.effects++;
        return layer;
    }

    function addInnerShadow(comp, layer, node, e) {
        var id = 0;
        try { id = app.findMenuCommandId("Inner Shadow"); } catch (x) {}
        // Localized AE UI: the menu name differs, fall back to the stable Layer Styles command id.
        if (!id) id = INNER_SHADOW_CMD;
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
        var adj = buildShapeLayer(comp, proxy, { geometry: geom, parent: layer.parent || null, noSplit: true });
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
        var fills = node.fills || [], i, first = -1, last = -1;
        for (i = 0; i < fills.length; i++) if (fills[i].type === "image" && fills[i].visible !== false) { if (first < 0) first = i; last = i; }
        var hasStroke = node.strokes && node.strokes.weight > 0;
        var bgProxy = function (suffix, paints, strokes) {
            var vis = false, k;
            for (k = 0; k < paints.length; k++) if (paints[k].visible !== false) vis = true;
            if (!vis && !(strokes && strokes.weight > 0)) return null;
            return buildShapeLayer(comp, {
                id: node.id, name: (node.name || "Frame") + suffix, type: "rect", size: node.size,
                geometry: node.geometry || { primitive: "rect", radius: 0 }, fills: paints, strokes: strokes,
                opacity: 1, blend: "NORMAL", visible: true
            }, { transform: { position: [0, 0], rotation: 0, scale: [1, 1] } });
        };
        var nonImage = function (list) { var o = [], k; for (k = 0; k < list.length; k++) if (list[k].type !== "image") o.push(list[k]); return o; };
        if (first < 0) return bgProxy(" bg", nonImage(fills), node.strokes);
        // Image fill: paints below it -> shape, the image itself -> PNG layer, paints above + stroke -> shape on top.
        var bottom = bgProxy(" bg", nonImage(fills.slice(0, first)), null);
        if (node.bgRaster && !node.bgRaster.failed && node.bgRaster.transform) {
            buildImageLayer(comp, {
                id: node.id, name: (node.name || "Frame") + " image", raster: node.bgRaster,
                transform: { local: node.bgRaster.transform.local }, opacity: 1, blend: "NORMAL", visible: true
            }, 1, null);
        } else warn(node, "Image fill export missing; skipped");
        var top = bgProxy(" overlay", nonImage(fills.slice(first + 1)), hasStroke ? node.strokes : null);
        return top || bottom;
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
            var matte = maskNode.type === "image" ? buildImageLayer(comp, maskNode, 1, parentLayer) : (maskNode.type === "text" ? buildTextLayer(comp, maskNode, 1, parentLayer) : (maskNode.geometry && maskNode.type !== "frame" && maskNode.type !== "group" && maskNode.type !== "component" && maskNode.type !== "instance" ? buildShapeLayer(comp, maskNode, { parent: parentLayer, noSplit: true }) : buildPrecompNode(comp, maskNode, 1, parentLayer)));
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

    // ------------------------------------------------------------ layer tools (panel "Groups": Precomp / Decomp / Toggle)
    // All three work on the selected layers of the active comp, each in one undo group, and return JSON for the panel log.
    var TR = { anchor: "ADBE Anchor Point", position: "ADBE Position", scale: "ADBE Scale", rotation: "ADBE Rotate Z", opacity: "ADBE Opacity",
        orientation: "ADBE Orientation", rx: "ADBE Rotate X", ry: "ADBE Rotate Y", px: "ADBE Position_0", py: "ADBE Position_1", pz: "ADBE Position_2" };

    function activeComp() {
        var c = app.project ? app.project.activeItem : null;
        if (!(c instanceof CompItem)) throw new Error("Open a composition and select layers first.");
        return c;
    }
    function selectedLayers(comp) {
        var s = comp.selectedLayers || [], out = [], i;
        for (i = 0; i < s.length; i++) out.push(s[i]);
        out.sort(function (a, b) { return a.index - b.index; });
        return out;
    }
    function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
    function runTool(undoName, fn) {
        var res = { ok: false, warnings: [] }, undoOpen = false;
        try {
            var comp = activeComp();
            app.beginUndoGroup("Uiscore Bridge: " + undoName);
            undoOpen = true;
            res.summary = fn(comp, res.warnings);
            res.ok = true;
        } catch (e) {
            res.error = (e && e.message) ? String(e.message) : String(e);
        } finally {
            if (undoOpen) app.endUndoGroup();
        }
        return UBJSON.stringify(res);
    }
    function compNameTaken(n) {
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.name === n) return true; }
        return false;
    }
    function freeCompName(base, numbered) {
        base = String(base).substr(0, 240);
        if (!numbered && !compNameTaken(base)) return base;
        for (var k = numbered ? 1 : 2; ; k++) if (!compNameTaken(base + " " + k)) return base + " " + k;
    }
    function layerNameTaken(comp, n, except) {
        for (var i = 1; i <= comp.numLayers; i++) { var l = comp.layer(i); if (l !== except && l.name === n) return true; }
        return false;
    }
    function isPrecompLayer(l) { try { return l.source instanceof CompItem; } catch (e) { return false; } }
    function isCamOrLight(l) {
        return (typeof CameraLayer !== "undefined" && l instanceof CameraLayer) || (typeof LightLayer !== "undefined" && l instanceof LightLayer);
    }
    function tr(l, k) { return l.property(MN.transform).property(TR[k]); }
    function numProps(p) { try { return p ? p.numProperties : 0; } catch (e) { return 0; } }
    function keyCount(p) { try { return p.numKeys || 0; } catch (e) { return 0; } }
    function scaleOpacityValue(p, f) {
        var n = keyCount(p), k;
        if (n) { for (k = 1; k <= n; k++) p.setValueAtKey(k, p.keyValue(k) * f); } else p.setValue(p.value * f);
    }

    // Copy value or keyframes (+ interpolation, eases, spatial tangents) and the expression of one property.
    function copyProp(src, dst) {
        var n = keyCount(src), k;
        if (n) {
            for (k = 1; k <= n; k++) dst.setValueAtTime(src.keyTime(k), src.keyValue(k));
            for (k = 1; k <= n; k++) {
                try { dst.setInterpolationTypeAtKey(k, src.keyInInterpolationType(k), src.keyOutInterpolationType(k)); } catch (e1) {}
                try { dst.setTemporalEaseAtKey(k, src.keyInTemporalEase(k), src.keyOutTemporalEase(k)); } catch (e2) {}
                try { dst.setSpatialTangentsAtKey(k, src.keyInSpatialTangent(k), src.keyOutSpatialTangent(k)); } catch (e3) {}
            }
        } else {
            dst.setValue(src.value);
        }
        try { if (src.expression) { dst.expression = src.expression; dst.expressionEnabled = src.expressionEnabled; } } catch (e4) {}
    }

    B.precompose = function () {
        return runTool("Precomp", function (comp, warnings) {
            var sel = selectedLayers(comp), idx = [], i;
            if (!sel.length) throw new Error("Select the layers to precompose in \"" + comp.name + "\".");
            for (i = 0; i < sel.length; i++) idx.push(sel[i].index);
            var name = sel.length === 1 ? freeCompName(sel[0].name + " Comp", false) : freeCompName("Pre-comp", true);
            // moveAllAttributes = true: transforms, effects, masks and keyframes go inside; the new comp has the parent comp's size/duration
            var pc = comp.layers.precompose(idx, name, true);
            try { pc.parentFolder = comp.parentFolder; } catch (e) {}
            try {
                for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
                comp.layer(idx[0]).selected = true;
            } catch (e2) {}
            return "Precomposed " + plural(sel.length, "layer") + " into \"" + pc.name + "\".";
        });
    };

    // Replace one precomp layer with its contents. The precomp layer's transform moves onto a null that parents the
    // former top-level layers (child positions are in the parent's layer space = the precomp's comp space), so every
    // layer keeps its on-screen result. Time offset/trim, opacity, internal parenting and track mattes are carried over.
    function decomposeLayer(comp, P, warnings) {
        var S = P.source, n = S.numLayers, i, j;
        var label = "\"" + P.name + "\"";
        if (P.timeRemapEnabled) throw new Error(label + " uses Time Remap; disable it before Decomp.");
        if (P.stretch !== undefined && P.stretch !== 100) throw new Error(label + " is time-stretched (" + P.stretch + "%); reset Stretch to 100% before Decomp.");
        if (!n) throw new Error(label + " is an empty precomp.");
        if (numProps(P.property(MN.effects))) warnings.push(label + ": effects on the precomp layer were not carried over.");
        if (numProps(P.property("ADBE Mask Parade"))) warnings.push(label + ": masks on the precomp layer were not carried over.");
        try { if (P.blendingMode !== BlendingMode.NORMAL) warnings.push(label + ": blend mode of the precomp layer was not carried over."); } catch (e0) {}
        try { if (P.trackMatteLayer || (P.hasTrackMatte && P.trackMatteType !== TrackMatteType.NO_TRACK_MATTE)) warnings.push(label + ": track matte of the precomp layer was not carried over."); } catch (e1) {}

        // 1) the null that takes over the precomp layer's transform
        var nul = comp.layers.addNull();
        var nulName = String(P.name).substr(0, 240);
        if (layerNameTaken(comp, nulName, P)) nulName = nulName.substr(0, 235) + " Null";
        nul.name = nulName;
        try { nul.label = P.label; } catch (e2) {}
        try { if (P.threeDLayer) nul.threeDLayer = true; } catch (e3) {}
        copyProp(tr(P, "anchor"), tr(nul, "anchor"));
        var sep = false;
        try { sep = tr(P, "position").dimensionsSeparated === true; } catch (e4) {}
        if (sep) {
            tr(nul, "position").dimensionsSeparated = true;
            copyProp(tr(P, "px"), tr(nul, "px")); copyProp(tr(P, "py"), tr(nul, "py"));
            if (P.threeDLayer) copyProp(tr(P, "pz"), tr(nul, "pz"));
        } else {
            copyProp(tr(P, "position"), tr(nul, "position"));
        }
        copyProp(tr(P, "scale"), tr(nul, "scale"));
        copyProp(tr(P, "rotation"), tr(nul, "rotation"));
        if (P.threeDLayer) { copyProp(tr(P, "orientation"), tr(nul, "orientation")); copyProp(tr(P, "rx"), tr(nul, "rx")); copyProp(tr(P, "ry"), tr(nul, "ry")); }
        if (P.parent) nul.setParentWithJump(P.parent);

        // 2) copy the precomp's layers into this comp, bottom first, so copies[i] mirrors S.layer(i)
        var copies = [], skipped = 0, has3D = false;
        for (i = n; i >= 1; i--) {
            var src = S.layer(i);
            if (isCamOrLight(src)) { copies[i] = null; skipped++; continue; }
            src.copyToComp(comp);
            copies[i] = comp.layer(1);
        }
        if (skipped) warnings.push(label + ": " + plural(skipped, "camera/light layer") + " inside the precomp were not copied (they would change this comp's view).");
        for (i = 1; i <= n; i++) if (copies[i]) copies[i].moveBefore(P);
        nul.moveBefore(firstCopy(copies, n) || P);

        // 3) parenting, mattes, time
        var offset = P.startTime || 0, usedAsParent = [];
        for (i = 1; i <= n; i++) {
            if (!copies[i]) continue;
            var sl = S.layer(i), c = copies[i], target = nul;
            if (sl.parent) { j = sl.parent.index; if (copies[j]) { target = copies[j]; usedAsParent[j] = true; } }
            c.setParentWithJump(target);
            var tm = null;
            try { tm = sl.trackMatteLayer; } catch (e5) {}
            if (tm && copies[tm.index] && typeof c.setTrackMatte === "function") { try { c.setTrackMatte(copies[tm.index], sl.trackMatteType); } catch (e6) {} }
            try { if (sl.threeDLayer) has3D = true; } catch (e7) {}
        }
        if (has3D && !P.collapseTransformation) warnings.push(label + ": 3D layers inside a non-collapsed precomp now render with this comp's camera.");
        var removed = 0;
        for (i = n; i >= 1; i--) {
            c = copies[i];
            if (!c) continue;
            if (offset) c.startTime = c.startTime + offset;
            var a = Math.max(c.inPoint, P.inPoint), b = Math.min(c.outPoint, P.outPoint);
            if (a >= b) {
                if (usedAsParent[i]) { c.enabled = false; } else { c.remove(); copies[i] = null; removed++; }
                continue;
            }
            if (a !== c.inPoint) c.inPoint = a;
            if (b !== c.outPoint) c.outPoint = b;
            if (!P.enabled) c.enabled = false;
        }
        try { nul.inPoint = P.inPoint; nul.outPoint = P.outPoint; } catch (e8) {}

        // 4) opacity does not inherit through parenting: bake it into every copied layer
        var po = tr(P, "opacity"), count = 0, exprSkipped = 0;
        for (i = 1; i <= n; i++) if (copies[i]) count++;
        if (keyCount(po) || (po.expression && po.expressionEnabled)) {
            var fx = nul.property(MN.effects).addProperty("ADBE Slider Control");
            fx.name = "Group Opacity";
            copyProp(po, fx.property("ADBE Slider Control-0001"));
            var ref = "thisComp.layer(" + UBJSON.stringify(nul.name) + ").effect(\"Group Opacity\")(\"Slider\") / 100";
            for (i = 1; i <= n; i++) {
                if (!copies[i]) continue;
                var op = tr(copies[i], "opacity");
                if (op.expression) { exprSkipped++; continue; }
                op.expression = "value * " + ref;
            }
        } else if (po.value < 100) {
            for (i = 1; i <= n; i++) {
                if (!copies[i]) continue;
                var op2 = tr(copies[i], "opacity");
                if (op2.expression) exprSkipped++;
                scaleOpacityValue(op2, po.value / 100);
            }
            if (count > 1) warnings.push(label + ": opacity " + po.value + "% is now applied per layer (overlapping layers blend slightly differently).");
        }
        if (exprSkipped) warnings.push(label + ": " + plural(exprSkipped, "layer") + " with an opacity expression may need the group opacity added by hand.");

        // 5) remove the precomp layer; the source comp stays in the project (also when no longer used)
        P.remove();
        try { for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false; } catch (e9) {}
        for (i = 1; i <= n; i++) if (copies[i]) { try { copies[i].selected = true; } catch (e10) {} }
        var unused = false;
        try { unused = S.usedIn && S.usedIn.length === 0; } catch (e11) {}
        return { layers: count - removed, removed: removed, unused: unused, name: S.name };
    }
    function firstCopy(copies, n) { for (var i = 1; i <= n; i++) if (copies[i]) return copies[i]; return null; }

    B.decompose = function () {
        return runTool("Decomp", function (comp, warnings) {
            var sel = selectedLayers(comp), pre = [], i, notPre = 0;
            for (i = 0; i < sel.length; i++) { if (isPrecompLayer(sel[i])) pre.push(sel[i]); else notPre++; }
            if (!pre.length) throw new Error("Select a precomp layer in \"" + comp.name + "\" to decompose.");
            if (notPre) warnings.push(plural(notPre, "selected layer") + " that are not precomps were left as they are.");
            var parts = [], total = 0;
            // bottom-most first so the indices of the remaining selected precomps stay valid
            for (i = pre.length - 1; i >= 0; i--) {
                var r = decomposeLayer(comp, pre[i], warnings);
                total += r.layers;
                parts.unshift("\"" + r.name + "\" (" + plural(r.layers, "layer") + ")");
                if (r.removed) warnings.push("\"" + r.name + "\": " + plural(r.removed, "layer") + " outside the precomp layer's time range were dropped.");
                if (r.unused) warnings.push("\"" + r.name + "\" is no longer used and was kept in the project; delete it from the Project panel if you don't need it.");
            }
            return "Decomposed " + parts.join(", ") + " into \"" + comp.name + "\" (" + plural(total, "layer") + ").";
        });
    };

    // Eye toggle: if any selected layer is visible, hide all of them; otherwise show all of them.
    B.toggleVisibility = function () {
        return runTool("Toggle visibility", function (comp, warnings) {
            var sel = selectedLayers(comp), anyOn = false, i, changed = 0;
            if (!sel.length) throw new Error("Select the layers to show or hide in \"" + comp.name + "\".");
            for (i = 0; i < sel.length; i++) if (sel[i].enabled) anyOn = true;
            for (i = 0; i < sel.length; i++) {
                try { if (sel[i].enabled !== !anyOn) { sel[i].enabled = !anyOn; changed++; } } catch (e) { warnings.push("\"" + sel[i].name + "\": visibility can't be changed."); }
            }
            return (anyOn ? "Hid " : "Showed ") + plural(changed, "layer") + " in \"" + comp.name + "\".";
        });
    };

    B.projectFolder = function () {
        try { return app.project && app.project.file ? app.project.file.parent.fsName : ""; } catch (e) { return ""; }
    };
    B.ping = function () { return "ok " + app.version; };
    return B;
})();
