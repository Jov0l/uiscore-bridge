/*
 * A permissive After Effects object-model mock for running host/*.jsx in a Node vm.
 * Not a renderer: it records what the builder does (layers, properties, values, presets)
 * so tests can assert on structure and catch runtime errors / typos in ExtendScript.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const KNOWN_PREFIX = /^(ADBE |innerShadow\/)/;

function createAE(opts) {
  opts = opts || {};
  const log = { unknownNames: new Set(), presets: [], commands: [], viewer: [] };
  let nextId = 1;

  class Prop {
    constructor(name, parent) { this.matchName = name; this.name = name; this.parentProperty = parent || null; this.children = []; this._value = undefined; this.enabled = true; this.selected = false; }
    get propertyIndex() { return this.parentProperty ? this.parentProperty.children.indexOf(this) + 1 : 0; }
    get numProperties() { return this.children.length; }
    property(k) {
      if (typeof k === "number") return this.children[k - 1] || null;
      let c = this.children.find((x) => x.matchName === k || x.name === k);
      if (!c) {
        if (!KNOWN_PREFIX.test(k)) log.unknownNames.add(k);
        c = new Prop(k, this); this.children.push(c);
      }
      return c;
    }
    addProperty(k) {
      if (!KNOWN_PREFIX.test(k)) log.unknownNames.add(k);
      const c = new Prop(k, this); this.children.push(c); return c;
    }
    remove() { const a = this.parentProperty.children; a.splice(a.indexOf(this), 1); }
    setValue(v) { if (this.matchName === "ADBE Vector Grad Colors") throw new Error("Can't set value of a NO_VALUE property"); if (this._keys && this._keys.length) throw new Error("setValue on a keyframed property"); this._value = v; }
    get value() { return this._value; }
    // keyframes (times in comp time, like AE) + expressions
    get numKeys() { return this._keys ? this._keys.length : 0; }
    setValueAtTime(t, v) { this._keys = this._keys || []; const k = this._keys.find((x) => x.t === t); if (k) k.v = v; else { this._keys.push({ t, v }); this._keys.sort((a, b) => a.t - b.t); } }
    keyTime(k) { return this._keys[k - 1].t; }
    keyValue(k) { return this._keys[k - 1].v; }
    setValueAtKey(k, v) { this._keys[k - 1].v = v; }
    get expression() { return this._expr || ""; }
    set expression(e) { this._expr = e; this.expressionEnabled = !!e; }
    _clone(parent) {
      const c = new Prop(this.matchName, parent); c.name = this.name; c._value = this._value; c.enabled = this.enabled;
      if (this._keys) c._keys = this._keys.map((k) => Object.assign({}, k));
      if (this._expr) { c._expr = this._expr; c.expressionEnabled = this.expressionEnabled; }
      if (this.dimensionsSeparated) c.dimensionsSeparated = true;
      c.children = this.children.map((x) => x._clone(c));
      return c;
    }
  }

  class TextDocument {
    constructor(text) { this.text = text; this.font = "ArialMT"; this.fontSize = 12; this.applyFill = true; this.fillColor = [0, 0, 0]; this.tracking = 0; this.autoLeading = true; this.leading = 0; this.justification = 0; this.ranges = []; if (opts.boxText) this.boxTextPos = [0, 0]; }
    characterRange(a, b) { if (!opts.characterRange) throw new Error("not available"); const r = { start: a, end: b }; this.ranges.push(r); return r; }
  }
  if (!opts.characterRange) TextDocument.prototype.characterRange = undefined;

  class Layer extends Prop {
    constructor(comp, kind, extra) {
      super("ADBE Layer");
      Object.assign(this, { comp, kind, parent: null, blendingMode: "NORMAL", adjustmentLayer: false, collapseTransformation: false, comment: "", trackMatte: null,
        _start: 0, inPoint: 0, outPoint: comp ? comp.duration : 10, stretch: 100, timeRemapEnabled: false, threeDLayer: false, label: 0 }, extra || {});
      this.id = nextId++;
    }
    // AE: changing startTime slides the layer (in/out points move with it)
    get startTime() { return this._start; }
    set startTime(t) { const d = t - this._start; this._start = t; this.inPoint += d; this.outPoint += d; }
    setParentWithJump(p) { this._parent = p || null; }
    get trackMatteLayer() { return this.trackMatte ? this.trackMatte.layer : null; }
    get trackMatteType() { return this._tmType || (this.trackMatte ? this.trackMatte.type : "NONE"); }
    set trackMatteType(t) { this._tmType = t; } // legacy (AE < 23) assignment
    remove() {
      const a = this.comp._layers; a.splice(a.indexOf(this), 1);
      for (const l of a) if (l._parent === this) l._parent = null;
    }
    copyToComp(target) {
      const c = new Layer(target, this.kind, { name: this.name, source: this.source, enabled: this.enabled, blendingMode: this.blendingMode, _start: this._start, inPoint: this.inPoint,
        outPoint: this.outPoint, stretch: this.stretch, threeDLayer: this.threeDLayer, label: this.label, comment: this.comment, collapseTransformation: this.collapseTransformation });
      c.children = this.children.map((x) => x._clone(c));
      target._layers.unshift(c); log.copies = (log.copies || 0) + 1;
      return c;
    }
    get index() { return this.comp._layers.indexOf(this) + 1; }
    set parent(p) { this._parent = p; }
    get parent() { return this._parent || null; }
    applyPreset(file) {
      const colors = this.children.length ? findSelected(this) : null;
      if (!colors) throw new Error("No property selected");
      if (!fs.existsSync(file.fsName)) throw new Error("preset missing");
      colors._value = "preset:" + file.fsName;
      log.presets.push({ layer: this.name, file: file.fsName, prop: colors.matchName });
    }
    setTrackMatte(matte, type) { this.trackMatte = { layer: matte, type }; }
    moveBefore(l) { move(this, l, 0); }
    moveAfter(l) { move(this, l, 1); }
    sourceRectAtTime() { const fsz = 24; return { left: 0, top: -fsz * 0.75, width: 120, height: fsz }; }
  }
  function findSelected(p) { for (const c of p.children) { if (c.selected) return c; const r = findSelected(c); if (r) return r; } return null; }
  function move(l, ref, after) { const a = l.comp._layers; a.splice(a.indexOf(l), 1); a.splice(a.indexOf(ref) + after, 0, l); }

  class FolderItem { constructor(name) { this.name = name; this.id = nextId++; this.parentFolder = null; } }
  class FootageItem { constructor(file) { this.file = file; this.name = path.basename(file.fsName); this.id = nextId++; this.parentFolder = null; } }
  class CompItem {
    constructor(name, w, h, par, dur, fps) { if (w < 4 || w > 30000) throw new Error('After Effects error: Unable to call "addComp" because of parameter 2. Value ' + w + ' out of range 4 to 30000.'); if (h < 4 || h > 30000) throw new Error('After Effects error: Unable to call "addComp" because of parameter 3. Value ' + h + ' out of range 4 to 30000.'); Object.assign(this, { name, width: w, height: h, pixelAspect: par, duration: dur, frameRate: fps, bgColor: [0, 0, 0] }); this.id = nextId++; this._layers = []; this.parentFolder = null;
      const comp = this;
      const add = (kind, extra) => { const l = new Layer(comp, kind, extra); comp._layers.unshift(l); return l; };
      this.layers = {
        addShape: () => add("shape", { name: "Shape Layer" }),
        addText: (t) => { const l = add("text", { name: t }); l.property("ADBE Text Properties").property("ADBE Text Document")._value = new TextDocument(t); return l; },
        addBoxText: (size, t) => { const l = add("boxText", { name: t, boxSize: size }); const d = new TextDocument(t); d.boxTextPos = [0, 0]; l.property("ADBE Text Properties").property("ADBE Text Document")._value = d; return l; },
        addNull: () => add("null", { name: "Null" }),
        add: (item) => add(item instanceof CompItem ? "precomp" : "footage", { name: item.name, source: item }),
        precompose: (indices, name, moveAll) => {
          if (!moveAll && indices.length > 1) throw new Error("precompose: moveAllAttributes must be true for several layers");
          const sel = indices.map((i) => comp._layers[i - 1]);
          if (sel.some((l) => !l)) throw new Error("precompose: bad index");
          const nc = new CompItem(name, comp.width, comp.height, comp.pixelAspect, comp.duration, comp.frameRate); items.push(nc);
          const at = Math.min(...indices) - 1;
          for (const l of sel) { comp._layers.splice(comp._layers.indexOf(l), 1); l.comp = nc; nc._layers.push(l); l.selected = false; }
          for (const l of comp._layers) if (sel.includes(l._parent)) l._parent = null;
          for (const l of sel) if (l._parent && !sel.includes(l._parent)) l._parent = null;
          const pl = new Layer(comp, "precomp", { name, source: nc });
          comp._layers.splice(at, 0, pl);
          return nc;
        }
      };
    }
    get selectedLayers() { return this._layers.filter((l) => l.selected); }
    get usedIn() { return items.filter((c) => c instanceof CompItem && c._layers.some((l) => l.source === this)); }
    get numLayers() { return this._layers.length; }
    layer(i) { return this._layers[i - 1]; }
    openInViewer() { project.activeItem = this; log.viewer.push(this.name); }
  }

  const items = [];
  const rootFolder = new FolderItem("Root");
  const project = {
    activeItem: null, file: opts.projectFile ? { parent: { fsName: opts.projectFile } } : null, rootFolder,
    get numItems() { return items.length; }, item: (i) => items[i - 1],
    items: {
      addComp: (...a) => { const c = new CompItem(...a); items.push(c); return c; },
      addFolder: (n) => { const f = new FolderItem(n); f.parentFolder = rootFolder; items.push(f); return f; }
    },
    importFile: (io) => { const f = new FootageItem(io.file); items.push(f); return f; }
  };

  class File {
    constructor(p) { this.fsName = path.resolve(String(p)); this.encoding = "BINARY"; }
    get exists() { return fs.existsSync(this.fsName); }
    get parent() { return { fsName: path.dirname(this.fsName) }; }
    open() { return this.exists; }
    read() { return fs.readFileSync(this.fsName, "utf8"); }
    close() {}
  }

  const app = {
    version: opts.version || "26.3x10", project,
    beginUndoGroup: () => { app._undo = (app._undo || 0) + 1; }, endUndoGroup: () => { app._undo--; },
    findMenuCommandId: (n) => (opts.noMenu ? 0 : 9001), executeCommand: (id) => { log.commands.push(id);
      for (const c of items) if (c instanceof CompItem) for (const l of c._layers) if (l.selected) l.property("ADBE Layer Styles").property("innerShadow/enabled"); },
    fonts: opts.fonts === false ? undefined : { getFontsByFamilyNameAndStyleName: (fam, sty) => [{ postScriptName: (fam + "-" + sty).replace(/\s+/g, "") }] }
  };

  const ctx = {
    app, File, FolderItem, CompItem, FootageItem, TextDocument,
    Shape: function Shape() {}, ImportOptions: function ImportOptions(f) { this.file = f; },
    BlendingMode: { NORMAL: "NORMAL", MULTIPLY: "MULTIPLY", SCREEN: "SCREEN", OVERLAY: "OVERLAY", ADD: "ADD", DARKEN: "DARKEN", LIGHTEN: "LIGHTEN", COLOR_DODGE: "COLOR_DODGE", COLOR_BURN: "COLOR_BURN", LINEAR_BURN: "LINEAR_BURN", SOFT_LIGHT: "SOFT_LIGHT", HARD_LIGHT: "HARD_LIGHT", DIFFERENCE: "DIFFERENCE", EXCLUSION: "EXCLUSION", HUE: "HUE", SATURATION: "SATURATION", COLOR: "COLOR", LUMINOSITY: "LUMINOSITY" },
    TrackMatteType: { ALPHA: "ALPHA", LUMA: "LUMA", NO_TRACK_MATTE: "NONE" },
    ParagraphJustification: { LEFT_JUSTIFY: "L", CENTER_JUSTIFY: "C", RIGHT_JUSTIFY: "R", FULL_JUSTIFY_LASTLINE_LEFT: "J" },
    $: { evalFile: () => {} }
  };
  if (opts.legacyMatte) delete Layer.prototype.setTrackMatte;
  vm.createContext(ctx);
  const hostDir = path.join(__dirname, "..", "..", "ae-extension", "host");
  for (const f of ["json.jsx", "geom.jsx", "builder.jsx"]) vm.runInContext(fs.readFileSync(path.join(hostDir, f), "utf8"), ctx, { filename: f });
  ctx.UBGeom = ctx.UBGeom || vm.runInContext("UBGeom", ctx);
  return { ctx, app, project, items, log, run: (code) => vm.runInContext(code, ctx), CompItem, Layer };
}

/** Flatten a comp's layers to a readable tree for assertions / debugging. */
function describe(comp, depth) {
  depth = depth || 0;
  return comp._layers.map((l) => ({ name: l.name, kind: l.kind, parent: l.parent ? l.parent.name : null, enabled: l.enabled, matte: l.trackMatte ? l.trackMatte.layer.name : null,
    precomp: l.kind === "precomp" && depth < 4 ? { name: l.source.name, layers: describe(l.source, depth + 1) } : undefined }));
}

module.exports = { createAE, describe };
