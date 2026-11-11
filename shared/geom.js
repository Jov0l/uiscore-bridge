/*
 * Uiscore Bridge - shared pure math (color, transform, gradient, path, text).
 *
 * IMPORTANT: this file must stay ES3-safe because it is loaded three ways:
 *   1. Node (tests, AE panel Node side)   -> module.exports
 *   2. Figma plugin main thread           -> concatenated into code.js by scripts/build.js
 *   3. After Effects ExtendScript         -> copied to ae-extension/host/geom.jsx and #include'd
 * Rules: only `var`, no arrow functions, no Array.prototype.map/forEach/indexOf,
 * no trailing commas, no reserved words as property names, no JSON global.
 */
var UBGeom = (function () {
    var G = {};
    var DEG = 180 / Math.PI;

    G.SCHEMA_ID = "uiscore.bridge.job";
    G.SCHEMA_VERSION = 1;

    // ------------------------------------------------------------------ numbers
    G.round = function (v, digits) {
        var p = Math.pow(10, digits === undefined ? 4 : digits);
        var r = Math.round(v * p) / p;
        return r === 0 ? 0 : r; // kill -0
    };
    G.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
    G.approx = function (a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps); };

    // ----------------------------------------------------------------- matrices
    // Matrix layout: [a, b, c, d, tx, ty]  ->  x' = a*x + c*y + tx ; y' = b*x + d*y + ty
    G.IDENTITY = [1, 0, 0, 1, 0, 0];
    // Figma Transform [[a, c, tx], [b, d, ty]] -> flat matrix
    G.fromFigma = function (t) {
        if (!t) return [1, 0, 0, 1, 0, 0];
        return [t[0][0], t[1][0], t[0][1], t[1][1], t[0][2], t[1][2]];
    };
    G.multiply = function (m1, m2) { // m1 * m2 (apply m2 first)
        return [
            m1[0] * m2[0] + m1[2] * m2[1],
            m1[1] * m2[0] + m1[3] * m2[1],
            m1[0] * m2[2] + m1[2] * m2[3],
            m1[1] * m2[2] + m1[3] * m2[3],
            m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
            m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
        ];
    };
    G.invert = function (m) {
        var det = m[0] * m[3] - m[1] * m[2];
        if (Math.abs(det) < 1e-12) return null;
        var ia = m[3] / det, ib = -m[1] / det, ic = -m[2] / det, id = m[0] / det;
        return [ia, ib, ic, id, -(ia * m[4] + ic * m[5]), -(ib * m[4] + id * m[5])];
    };
    G.apply = function (m, p) {
        return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
    };
    // Node matrix relative to an ancestor whose absolute matrix is `parentAbs`.
    G.relativeTo = function (parentAbs, nodeAbs) {
        var inv = G.invert(parentAbs);
        if (!inv) return nodeAbs.slice(0);
        return G.multiply(inv, nodeAbs);
    };
    /*
     * Decompose into an After Effects layer transform with anchor [0,0]:
     *   M = T(position) * R(rotation) * Scale(sx, sy) * Skew(k)
     * AE rotation is clockwise-positive in a y-down space, same as atan2(b, a) here.
     * Mirroring (det < 0) goes to a negative Y scale.
     */
    G.decompose = function (m) {
        var a = m[0], b = m[1], c = m[2], d = m[3];
        var sx = Math.sqrt(a * a + b * b);
        var det = a * d - b * c;
        var rot = sx > 1e-12 ? Math.atan2(b, a) : 0;
        var sy = sx > 1e-12 ? det / sx : Math.sqrt(c * c + d * d);
        var skew = sx > 1e-12 && Math.abs(det) > 1e-12 ? (a * c + b * d) / det : 0;
        return {
            position: [G.round(m[4]), G.round(m[5])],
            rotation: G.round(rot * DEG),
            scale: [G.round(sx, 6), G.round(sy, 6)],
            skew: G.round(Math.atan(skew) * DEG),
            anchor: [0, 0]
        };
    };

    // ------------------------------------------------------------------- colors
    G.color = function (c, opacity) {
        // Figma RGB(A) 0..1 -> [r, g, b, a] 0..1
        var a = (c && c.a !== undefined) ? c.a : 1;
        if (opacity !== undefined) a = a * opacity;
        return [G.round(c.r, 6), G.round(c.g, 6), G.round(c.b, 6), G.round(a, 6)];
    };
    G.toHex = function (rgba) {
        var s = "#", i, v;
        for (i = 0; i < 3; i++) {
            v = Math.round(G.clamp(rgba[i], 0, 1) * 255).toString(16);
            s += v.length < 2 ? "0" + v : v;
        }
        return s;
    };

    // -------------------------------------------------------------- blend modes
    var BLEND = {
        PASS_THROUGH: "NORMAL", NORMAL: "NORMAL",
        DARKEN: "DARKEN", MULTIPLY: "MULTIPLY", LINEAR_BURN: "LINEAR_BURN", COLOR_BURN: "COLOR_BURN",
        LIGHTEN: "LIGHTEN", SCREEN: "SCREEN", LINEAR_DODGE: "ADD", COLOR_DODGE: "COLOR_DODGE",
        OVERLAY: "OVERLAY", SOFT_LIGHT: "SOFT_LIGHT", HARD_LIGHT: "HARD_LIGHT",
        DIFFERENCE: "DIFFERENCE", EXCLUSION: "EXCLUSION",
        HUE: "HUE", SATURATION: "SATURATION", COLOR: "COLOR", LUMINOSITY: "LUMINOSITY"
    };
    G.aeBlendName = function (figmaBlend) {
        return BLEND[figmaBlend] || "NORMAL";
    };

    // ---------------------------------------------------------------- gradients
    /*
     * Figma's gradientTransform maps the layer's normalized box (0..1) INTO gradient space.
     * Handle positions in normalized space are therefore inverse(T) * gradientPoint:
     *   linear : start (0, .5), end (1, .5)
     *   radial / diamond / angular : center (.5, .5), axis-1 end (1, .5), axis-2 end (.5, 1)
     * Result is in layer-local pixels (multiply by w,h).
     */
    G.gradientHandles = function (gradientTransform, w, h, figmaType) {
        var m = G.fromFigma(gradientTransform);
        var inv = G.invert(m) || [1, 0, 0, 1, 0, 0];
        function px(p) { var q = G.apply(inv, p); return [G.round(q[0] * w), G.round(q[1] * h)]; }
        var out = { kind: "linear", source: figmaType || "GRADIENT_LINEAR" };
        if (figmaType === "GRADIENT_RADIAL" || figmaType === "GRADIENT_DIAMOND" || figmaType === "GRADIENT_ANGULAR") {
            out.kind = figmaType === "GRADIENT_RADIAL" ? "radial" : (figmaType === "GRADIENT_DIAMOND" ? "diamond" : "angular");
            out.center = px([0.5, 0.5]);
            out.start = out.center;
            out.end = px([1, 0.5]);
            out.minorEnd = px([0.5, 1]);
            var rx = Math.sqrt(Math.pow(out.end[0] - out.center[0], 2) + Math.pow(out.end[1] - out.center[1], 2));
            var ry = Math.sqrt(Math.pow(out.minorEnd[0] - out.center[0], 2) + Math.pow(out.minorEnd[1] - out.center[1], 2));
            out.radii = [G.round(rx), G.round(ry)];
            out.aspect = rx > 1e-9 ? G.round(ry / rx, 4) : 1;
        } else {
            // Figma interpolates t = row0(gradientTransform) . (x/w, y/h, 1), i.e. the iso-lines are
            // perpendicular in *unit-box* space. AE's G-Fill iso-lines are perpendicular in layer px.
            // On non-square boxes those differ, so we keep Figma's start handle (t = 0 there) and
            // place the end at start + g/|g|^2, where g = (a/w, c/h) is the true px-space gradient of t.
            // Result: identical t for every pixel. figmaEnd keeps the handle as drawn in Figma's UI.
            out.start = px([0, 0.5]);
            out.figmaEnd = px([1, 0.5]);
            var ga = m[0] / (w || 1), gc = m[2] / (h || 1), g2 = ga * ga + gc * gc;
            if (g2 > 1e-12) {
                var q0 = G.apply(inv, [0, 0.5]);
                out.end = [G.round(q0[0] * w + ga / g2), G.round(q0[1] * h + gc / g2)];
            } else {
                out.end = out.figmaEnd;
            }
        }
        var dx = out.end[0] - out.start[0], dy = out.end[1] - out.start[1];
        out.angle = G.round(Math.atan2(dy, dx) * DEG, 3);          // degrees, clockwise from +X (y-down)
        out.length = G.round(Math.sqrt(dx * dx + dy * dy));
        return out;
    };
    G.offsetPoint = function (p, dx, dy) { return [G.round(p[0] + dx), G.round(p[1] + dy)]; };
    // Same handles mapped into another space (e.g. comp space) by a matrix.
    G.mapHandles = function (handles, m) {
        var o = { kind: handles.kind }, keys = ["start", "end", "center", "minorEnd"], i;
        for (i = 0; i < keys.length; i++) {
            if (handles[keys[i]]) { var q = G.apply(m, handles[keys[i]]); o[keys[i]] = [G.round(q[0]), G.round(q[1])]; }
        }
        var dx = o.end[0] - o.start[0], dy = o.end[1] - o.start[1];
        o.angle = G.round(Math.atan2(dy, dx) * DEG, 3);
        return o;
    };
    /*
     * Split Figma gradient stops (rgba + position) into AE color stops and alpha stops.
     * Stable-sorted by position, clamped to 0..1, midpoints 0.5.
     */
    G.splitStops = function (stops) {
        var list = [], i, j, s;
        for (i = 0; i < stops.length; i++) {
            s = stops[i];
            list.push({ p: G.clamp(s.position, 0, 1), c: s.color, i: i });
        }
        // insertion sort (stable, ES3)
        for (i = 1; i < list.length; i++) {
            var cur = list[i];
            j = i - 1;
            while (j >= 0 && (list[j].p > cur.p || (list[j].p === cur.p && list[j].i > cur.i))) { list[j + 1] = list[j]; j--; }
            list[j + 1] = cur;
        }
        var colorStops = [], alphaStops = [];
        for (i = 0; i < list.length; i++) {
            var c = list[i].c;
            colorStops.push({ offset: G.round(list[i].p, 6), midpoint: 0.5, rgb: [G.round(c.r, 6), G.round(c.g, 6), G.round(c.b, 6)] });
            alphaStops.push({ offset: G.round(list[i].p, 6), midpoint: 0.5, alpha: G.round(c.a === undefined ? 1 : c.a, 6) });
        }
        return { colorStops: colorStops, alphaStops: alphaStops };
    };
    function fmt(n) {
        var r = G.round(n, 6);
        var s = String(r);
        if (s.indexOf("e") >= 0 || s.indexOf("E") >= 0) s = r.toFixed(6).replace(/\.?0+$/, "");
        return s;
    }
    G.formatFloat = fmt;
    function stopsBlock(kind, stops) {
        var L = ["<prop.pair>", "<key>" + kind + " Stops</key>", "<prop.list>", "<prop.pair>", "<key>Stops List</key>", "<prop.list>"];
        var i, k, vals;
        for (i = 0; i < stops.length; i++) {
            if (kind === "Alpha") vals = [stops[i].offset, stops[i].midpoint, stops[i].alpha];
            else vals = [stops[i].offset, stops[i].midpoint, stops[i].rgb[0], stops[i].rgb[1], stops[i].rgb[2], 1];
            L.push("<prop.pair>", "<key>Stop-" + i + "</key>", "<prop.list>", "<prop.pair>", "<key>Stops " + kind + "</key>", "<array>", "<array.type><float/></array.type>");
            for (k = 0; k < vals.length; k++) L.push("<float>" + fmt(vals[k]) + "</float>");
            L.push("</array>", "</prop.pair>", "</prop.list>", "</prop.pair>");
        }
        L.push("</prop.list>", "</prop.pair>", "<prop.pair>", "<key>Stops Size</key>", "<int type='unsigned' size='32'>" + stops.length + "</int>", "</prop.pair>", "</prop.list>", "</prop.pair>");
        return L.join("\n");
    }
    /*
     * After Effects stores shape-gradient colors as a "prop.map" XML document (GCky/Utf8 chunk).
     * This writes that document from split stops. Used by the Node side to build .ffx presets.
     */
    G.gradientXml = function (split) {
        return ["<?xml version='1.0'?>", "<prop.map version='4'>", "<prop.list>", "<prop.pair>", "<key>Gradient Color Data</key>", "<prop.list>",
            stopsBlock("Alpha", split.alphaStops), stopsBlock("Color", split.colorStops),
            "</prop.list>", "</prop.pair>", "<prop.pair>", "<key>Gradient Colors</key>", "<string>1.0</string>", "</prop.pair>", "</prop.list>", "</prop.map>"].join("\n") + "\n";
    };
    // Fallback for AE "Gradient Ramp" effect: only 2 colors; first/last stop.
    G.rampFallback = function (handles, stops) {
        var split = G.splitStops(stops);
        var a = split.colorStops[0], b = split.colorStops[split.colorStops.length - 1];
        return {
            shape: handles.kind === "linear" ? 1 : 2,
            start: handles.start, end: handles.end,
            startColor: [a.rgb[0], a.rgb[1], a.rgb[2], 1], endColor: [b.rgb[0], b.rgb[1], b.rgb[2], 1],
            lossy: stops.length > 2
        };
    };
    // Sample a gradient (split form) at t in 0..1 -> [r,g,b,a]; used by preview renderer and tests.
    G.sampleStops = function (split, t) {
        function lerpList(list, getter) {
            if (t <= list[0].offset) return getter(list[0]);
            var last = list[list.length - 1];
            if (t >= last.offset) return getter(last);
            for (var i = 0; i < list.length - 1; i++) {
                var A = list[i], B = list[i + 1];
                if (t >= A.offset && t <= B.offset) {
                    var u = B.offset - A.offset < 1e-9 ? 0 : (t - A.offset) / (B.offset - A.offset);
                    var va = getter(A), vb = getter(B), r = [], k;
                    for (k = 0; k < va.length; k++) r.push(va[k] + (vb[k] - va[k]) * u);
                    return r;
                }
            }
            return getter(last);
        }
        var rgb = lerpList(split.colorStops, function (s) { return s.rgb; });
        var al = lerpList(split.alphaStops, function (s) { return [s.alpha]; });
        return [rgb[0], rgb[1], rgb[2], al[0]];
    };

    // -------------------------------------------------------------------- paths
    /*
     * SVG path data (as produced by Figma vectorPaths / fillGeometry: M L H V C Q Z, absolute)
     * -> AE-style subpaths { closed, vertices, inTangents, outTangents } with tangents RELATIVE to vertex.
     */
    G.parseSvgPath = function (d) {
        var tokens = [], re = /([MLHVCSQTZmlhvcsqtz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g, m;
        while ((m = re.exec(d)) !== null) tokens.push(m[1] ? m[1] : parseFloat(m[2]));
        var paths = [], cur = null, i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0;
        function num() { return tokens[i++]; }
        function start(px, py) {
            cur = { closed: false, vertices: [[px, py]], inTangents: [[0, 0]], outTangents: [[0, 0]] };
            paths.push(cur);
        }
        function lineTo(px, py) {
            if (!cur) start(x, y);
            cur.vertices.push([px, py]); cur.inTangents.push([0, 0]); cur.outTangents.push([0, 0]);
        }
        function cubicTo(c1x, c1y, c2x, c2y, px, py) {
            if (!cur) start(x, y);
            var n = cur.vertices.length - 1;
            cur.outTangents[n] = [c1x - cur.vertices[n][0], c1y - cur.vertices[n][1]];
            cur.vertices.push([px, py]); cur.inTangents.push([c2x - px, c2y - py]); cur.outTangents.push([0, 0]);
        }
        while (i < tokens.length) {
            if (typeof tokens[i] === "string") { cmd = tokens[i]; i++; }
            var rel = cmd === cmd.toLowerCase() && cmd !== "z" ? true : false;
            var C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
            if (C === "M") { x = num() + ox; y = num() + oy; start(x, y); sx = x; sy = y; cmd = rel ? "l" : "L"; }
            else if (C === "L") { x = num() + ox; y = num() + oy; lineTo(x, y); }
            else if (C === "H") { x = num() + ox; lineTo(x, y); }
            else if (C === "V") { y = num() + oy; lineTo(x, y); }
            else if (C === "C") {
                var a1 = num() + ox, a2 = num() + oy, b1 = num() + ox, b2 = num() + oy, e1 = num() + ox, e2 = num() + oy;
                cubicTo(a1, a2, b1, b2, e1, e2); x = e1; y = e2;
            } else if (C === "Q") {
                var q1 = num() + ox, q2 = num() + oy, qe1 = num() + ox, qe2 = num() + oy;
                cubicTo(x + 2 / 3 * (q1 - x), y + 2 / 3 * (q2 - y), qe1 + 2 / 3 * (q1 - qe1), qe2 + 2 / 3 * (q2 - qe2), qe1, qe2);
                x = qe1; y = qe2;
            } else if (C === "Z") {
                if (cur) {
                    var n = cur.vertices.length - 1;
                    if (n > 0 && G.approx(cur.vertices[n][0], cur.vertices[0][0], 1e-4) && G.approx(cur.vertices[n][1], cur.vertices[0][1], 1e-4)) {
                        // closing point duplicates the first vertex: fold its in-tangent into vertex 0
                        cur.inTangents[0] = cur.inTangents[n];
                        cur.vertices.pop(); cur.inTangents.pop(); cur.outTangents.pop();
                    }
                    cur.closed = true;
                }
                x = sx; y = sy; cur = null;
            } else { i++; } // unsupported command (S/T/A are never emitted by Figma) - skip token
        }
        // round
        for (var p = 0; p < paths.length; p++) {
            var keys = ["vertices", "inTangents", "outTangents"];
            for (var k = 0; k < keys.length; k++) {
                var arr = paths[p][keys[k]];
                for (var v = 0; v < arr.length; v++) arr[v] = [G.round(arr[v][0]), G.round(arr[v][1])];
            }
        }
        return paths;
    };
    // Rounded rectangle path with per-corner radii [tl, tr, br, bl] (layer-local, origin top-left).
    G.roundedRectPath = function (w, h, r) {
        var K = 0.5522847498;
        if (Object.prototype.toString.call(r) !== "[object Array]") r = [r || 0, r || 0, r || 0, r || 0];
        var max = Math.min(w, h) / 2, tl = Math.min(r[0], max), tr = Math.min(r[1], max), br = Math.min(r[2], max), bl = Math.min(r[3], max);
        var V = [], I = [], O = [];
        function add(p, i, o) { V.push(p); I.push(i); O.push(o); }
        add([tl, 0], [-tl * K, 0], [0, 0]);
        add([w - tr, 0], [0, 0], [tr * K, 0]);
        add([w, tr], [0, -tr * K], [0, 0]);
        add([w, h - br], [0, 0], [0, br * K]);
        add([w - br, h], [br * K, 0], [0, 0]);
        add([bl, h], [0, 0], [-bl * K, 0]);
        add([0, h - bl], [0, bl * K], [0, 0]);
        add([0, tl], [0, 0], [0, -tl * K]);
        return { closed: true, vertices: V, inTangents: I, outTangents: O };
    };
    // Shift subpaths by (dx, dy) - e.g. from layer-local to shape-group space.
    G.translatePaths = function (paths, dx, dy) {
        var out = [], p, v;
        for (p = 0; p < paths.length; p++) {
            var src = paths[p], vs = [];
            for (v = 0; v < src.vertices.length; v++) vs.push([G.round(src.vertices[v][0] + dx), G.round(src.vertices[v][1] + dy)]);
            out.push({ closed: src.closed, vertices: vs, inTangents: src.inTangents, outTangents: src.outTangents });
        }
        return out;
    };

    // --------------------------------------------------------------- strokes
    G.lineCap = function (figmaCap) { return figmaCap === "ROUND" ? 2 : (figmaCap === "SQUARE" ? 3 : 1); };   // AE: 1 butt 2 round 3 projecting
    G.lineJoin = function (figmaJoin) { return figmaJoin === "ROUND" ? 2 : (figmaJoin === "BEVEL" ? 3 : 1); }; // AE: 1 miter 2 round 3 bevel
    // AE strokes are centered. INSIDE/OUTSIDE are emulated with an Offset Paths operator on a stroke-only group.
    G.strokeOffset = function (align, weight) {
        if (align === "INSIDE") return -weight / 2;
        if (align === "OUTSIDE") return weight / 2;
        return 0;
    };

    // --------------------------------------------------------------- effects
    // Figma DROP_SHADOW {offset{x,y}, radius, spread, color} -> AE "Drop Shadow" effect values.
    G.shadowToAE = function (e) {
        var dx = e.offset ? e.offset.x : 0, dy = e.offset ? e.offset.y : 0;
        var dir = Math.atan2(dx, -dy) * DEG; // AE: 0deg = up, clockwise
        if (dir < 0) dir += 360;
        return {
            color: [e.color.r, e.color.g, e.color.b, 1],
            opacity: G.round(e.color.a === undefined ? 1 : e.color.a, 4),   // 0..1, builder scales to AE's range
            direction: G.round(dir, 3),
            distance: G.round(Math.sqrt(dx * dx + dy * dy), 3),
            softness: G.round(e.radius || 0, 3),
            spread: e.spread || 0
        };
    };
    G.blurToAE = function (radius) { return G.round(radius || 0, 3); };

    // ------------------------------------------------------------------ text
    G.trackingFromLetterSpacing = function (ls, fontSize) {
        if (!ls) return 0;
        if (ls.unit === "PERCENT") return G.round(ls.value * 10, 2);          // % of em -> 1/1000 em
        return fontSize ? G.round(ls.value / fontSize * 1000, 2) : 0;          // px -> 1/1000 em
    };
    G.leadingFromLineHeight = function (lh, fontSize) {
        if (!lh || lh.unit === "AUTO") return null;                              // null => auto leading
        if (lh.unit === "PERCENT") return G.round(fontSize * lh.value / 100, 3);
        return G.round(lh.value, 3);
    };
    G.justification = function (align) {
        if (align === "CENTER") return "CENTER_JUSTIFY";
        if (align === "RIGHT") return "RIGHT_JUSTIFY";
        if (align === "JUSTIFIED") return "FULL_JUSTIFY_LASTLINE_LEFT";
        return "LEFT_JUSTIFY";
    };
    // Best-guess PostScript name from a Figma fontName; AE side verifies and falls back.
    G.postScriptGuess = function (fontName) {
        if (!fontName) return "ArialMT";
        var fam = String(fontName.family).replace(/\s+/g, "");
        var style = String(fontName.style).replace(/\s+/g, "");
        if (style === "Regular" || style === "") return fam + "-Regular";
        return fam + "-" + style;
    };

    // ---------------------------------------------------------------- raster
    G.exportScale = function (w, h, cap) {
        var c = cap === undefined ? 3 : cap;
        var longSide = Math.max(w, h, 1);
        return G.round(Math.min(c, 3500 / longSide), 4);
    };

    // ------------------------------------------------------ builder decisions
    /*
     * Which AE technique to use for a gradient paint:
     *   "native"  : shape Gradient Fill/Stroke + .ffx preset with the exact stops (editable in AE)
     *   "ramp"    : Gradient Ramp effect (+ Set Matte) - 2 colors, editable; used for text and as fallback
     * env: { presetsAvailable: bool }  (false when the .ffx could not be written or applying failed)
     */
    G.gradientStrategy = function (paint, nodeType, env) {
        if (nodeType === "text") return "ramp";
        if (paint && paint.ffx && (!env || env.presetsAvailable !== false)) return "native";
        return "ramp";
    };
    G.aeGradientType = function (kind) { return kind === "linear" ? 1 : 2; }; // AE: 1 linear, 2 radial

    /*
     * Figma: a mask layer clips all following siblings (above it) in the same parent, until the next mask.
     * Returns [{ kind: "node", node }, { kind: "masked", mask, content: [nodes] }] in bottom->top order.
     */
    G.groupMasks = function (children) {
        var out = [], cur = null, i;
        for (i = 0; i < children.length; i++) {
            var c = children[i];
            if (c.isMask) { cur = { kind: "masked", mask: c, content: [] }; out.push(cur); }
            else if (cur) cur.content.push(c);
            else out.push({ kind: "node", node: c });
        }
        return out;
    };

    // Inner shadow -> Photoshop-style layer style light angle (deg, CCW from +X, light FROM that direction).
    G.innerShadowAngle = function (dx, dy) {
        var a = Math.atan2(dy, -dx) * DEG;
        return G.round(a < 0 ? a + 360 : a, 3);
    };
    G.fitScale = function (w, h, W, H) { return G.round(Math.min(W / w, H / h) * 100, 4); };

    /*
     * Text placement. AE text layers have their own origin (baseline of first line), so we pick
     * an AE layer-space point A and the Figma node-local point P that must coincide:
     *   anchorPoint = A, position = matrixLocal * P.
     * rect = sourceRectAtTime() {left, top, width, height}; boxPos = top-left of paragraph box (or null).
     */
    G.textPlacement = function (t, rect, boxPos, w, h) {
        var fs = t.size || 16;
        var L = t.leading || fs * 1.2;
        var ax, px, ay, py;
        var isBox = t.autoResize !== "WIDTH_AND_HEIGHT";
        if (isBox && boxPos) { ax = boxPos[0]; px = 0; }
        else if (t.alignH === "CENTER") { ax = rect.left + rect.width / 2; px = w / 2; }
        else if (t.alignH === "RIGHT") { ax = rect.left + rect.width; px = w; }
        else { ax = rect.left; px = 0; }
        if (isBox && boxPos && t.alignV === "TOP" && (t.autoResize === "NONE" || t.autoResize === "TRUNCATE")) {
            ay = boxPos[1]; py = Math.max(0, (L - fs * 1.2) / 2);
        } else if (t.alignV === "BOTTOM" && (t.autoResize === "NONE" || t.autoResize === "TRUNCATE")) {
            ay = rect.top + rect.height; py = h - Math.max(0, (L - fs) / 2) - fs * 0.22;
        } else {
            ay = rect.top + rect.height / 2; py = h / 2;
        }
        return { anchor: [G.round(ax, 3), G.round(ay, 3)], local: [G.round(px, 3), G.round(py, 3)], box: isBox };
    };

    return G;
})();

if (typeof module !== "undefined" && module.exports) { module.exports = UBGeom; }
