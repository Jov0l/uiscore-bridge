/*
 * Uiscore Bridge - minimal JSON for ExtendScript (ES3). Written from scratch for this project.
 * parse(): strict recursive-descent parser (no eval).  stringify(): enough for result objects.
 */
var UBJSON = (function () {
    var J = {};
    J.parse = function (text) {
        var i = 0, s = String(text);
        if (s.charCodeAt(0) === 0xFEFF) i = 1;
        function err(m) { throw new Error("JSON parse error at " + i + ": " + m); }
        function ws() { var c; while (i < s.length) { c = s.charAt(i); if (c === " " || c === "\t" || c === "\n" || c === "\r") i++; else break; } }
        function value() {
            ws();
            var c = s.charAt(i);
            if (c === "{") return obj();
            if (c === "[") return arr();
            if (c === "\"") return str();
            if (c === "t") { if (s.substr(i, 4) === "true") { i += 4; return true; } err("bad literal"); }
            if (c === "f") { if (s.substr(i, 5) === "false") { i += 5; return false; } err("bad literal"); }
            if (c === "n") { if (s.substr(i, 4) === "null") { i += 4; return null; } err("bad literal"); }
            return num();
        }
        function num() {
            var start = i;
            if (s.charAt(i) === "-") i++;
            while (i < s.length && "0123456789.eE+-".indexOf(s.charAt(i)) >= 0) i++;
            var n = parseFloat(s.substring(start, i));
            if (start === i || isNaN(n)) err("bad number");
            return n;
        }
        function str() {
            var out = "", c, h;
            i++;
            while (i < s.length) {
                c = s.charAt(i++);
                if (c === "\"") return out;
                if (c === "\\") {
                    c = s.charAt(i++);
                    if (c === "n") out += "\n"; else if (c === "t") out += "\t"; else if (c === "r") out += "\r";
                    else if (c === "b") out += "\b"; else if (c === "f") out += "\f";
                    else if (c === "u") { h = s.substr(i, 4); i += 4; out += String.fromCharCode(parseInt(h, 16)); }
                    else out += c; // \" \\ \/
                } else out += c;
            }
            err("unterminated string");
        }
        function arr() {
            var a = [];
            i++; ws();
            if (s.charAt(i) === "]") { i++; return a; }
            while (true) {
                a.push(value()); ws();
                var c = s.charAt(i++);
                if (c === "]") return a;
                if (c !== ",") err("expected , or ]");
            }
        }
        function obj() {
            var o = {};
            i++; ws();
            if (s.charAt(i) === "}") { i++; return o; }
            while (true) {
                ws();
                if (s.charAt(i) !== "\"") err("expected key");
                var k = str(); ws();
                if (s.charAt(i++) !== ":") err("expected :");
                o[k] = value(); ws();
                var c = s.charAt(i++);
                if (c === "}") return o;
                if (c !== ",") err("expected , or }");
            }
        }
        var v = value(); ws();
        if (i < s.length) err("trailing characters");
        return v;
    };
    function quote(str) {
        var out = "\"", i, c, code;
        for (i = 0; i < str.length; i++) {
            c = str.charAt(i); code = str.charCodeAt(i);
            if (c === "\"" || c === "\\") out += "\\" + c;
            else if (c === "\n") out += "\\n"; else if (c === "\r") out += "\\r"; else if (c === "\t") out += "\\t";
            else if (code < 32) { var h = code.toString(16); out += "\\u" + "0000".substr(h.length) + h; }
            else out += c;
        }
        return out + "\"";
    }
    J.stringify = function (v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v, i, parts;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return quote(v);
        if (v instanceof Array) {
            parts = [];
            for (i = 0; i < v.length; i++) parts.push(J.stringify(v[i]));
            return "[" + parts.join(",") + "]";
        }
        if (t === "object") {
            parts = [];
            for (var k in v) { if (v.hasOwnProperty(k) && typeof v[k] !== "function") parts.push(quote(k) + ":" + J.stringify(v[k])); }
            return "{" + parts.join(",") + "}";
        }
        return "null";
    };
    return J;
})();
if (typeof module !== "undefined" && module.exports) { module.exports = UBJSON; }
