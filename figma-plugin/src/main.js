/* Uiscore Bridge - Figma plugin entry (main thread). Bundled into ../code.js by scripts/build.js */
var UB_PLUGIN_VERSION = "0.1.0";
var UB_DEFAULT_OPTIONS = { rasterScaleCap: 3, groupsAs: "precomp", compMode: "new", port: 7341 };

// Window sizes come from the Figma design "uiscore bridge" (node 2686:126894):
// Choose Frame = 460 x 460 (460 x 650 with the "No bridge" alert), Ready / Exporting = 469 x 650 (469 x 791 with the alert),
// Done / Error = 460 x 469. The UI asks for a resize whenever the state or the alert changes.
var UB_UI_SIZES = { compact: { width: 460, height: 460 }, full: { width: 469, height: 650 } };
figma.showUI(__html__, { width: UB_UI_SIZES.compact.width, height: UB_UI_SIZES.compact.height, themeColors: true, title: "Uiscore Bridge" });

async function ubLoadOptions() {
  var saved = await figma.clientStorage.getAsync("ub-options");
  return Object.assign({}, UB_DEFAULT_OPTIONS, saved || {});
}

function ubTopLevelRoots(selection) {
  // A selected node whose ancestor is also selected is skipped: each root becomes one AE comp.
  var ids = {};
  for (var i = 0; i < selection.length; i++) ids[selection[i].id] = true;
  return selection.filter(function (n) {
    var p = n.parent;
    while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") { if (ids[p.id]) return false; p = p.parent; }
    return true;
  });
}

var ubThumbToken = 0;
async function ubThumbnail(node) {
  // Small PNG of the first selected layer for the preview card (fits 2x of the 389 x 241 card area).
  if (!node || typeof node.exportAsync !== "function" || !node.width || !node.height) return null;
  var scale = Math.min(2, (2 * 357) / node.width, (2 * 209) / node.height);
  if (!(scale > 0)) return null;
  try { return await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: Math.max(0.01, scale) } }); }
  catch (e) { return null; }
}

function ubSelectionInfo(changed) {
  var sel = figma.currentPage.selection;
  var info = { type: "selection", count: sel.length, names: sel.slice(0, 5).map(function (n) { return n.name; }), changed: !!changed };
  figma.ui.postMessage(info);
  if (!changed) return;
  var token = ++ubThumbToken;
  if (!sel.length) { figma.ui.postMessage(Object.assign({}, info, { thumb: null, changed: false })); return; }
  setTimeout(function () {
    if (token !== ubThumbToken) return;
    ubThumbnail(sel[0]).then(function (bytes) {
      if (token !== ubThumbToken) return;
      figma.ui.postMessage(Object.assign({}, info, { thumb: bytes, changed: false }));
    });
  }, 120);
}

figma.on("selectionchange", function () { ubSelectionInfo(true); });

figma.ui.onmessage = async function (msg) {
  if (msg.type === "init") {
    figma.ui.postMessage({ type: "options", options: await ubLoadOptions(), version: UB_PLUGIN_VERSION });
    ubSelectionInfo(true);
  } else if (msg.type === "resize") {
    var w = Math.max(320, Math.min(1200, Math.round(Number(msg.width) || 0)));
    var h = Math.max(240, Math.min(1200, Math.round(Number(msg.height) || 0)));
    figma.ui.resize(w, h);
  } else if (msg.type === "save-options") {
    await figma.clientStorage.setAsync("ub-options", msg.options);
  } else if (msg.type === "mark-raster") {
    var sel = figma.currentPage.selection, n = 0;
    for (var i = 0; i < sel.length; i++) {
      var node = sel[i];
      if (node.name.charAt(0) === "*") node.name = node.name.slice(1).replace(/^\s+/, "");
      else node.name = "*" + node.name;
      n++;
    }
    if (n) ubSelectionInfo(false);
  } else if (msg.type === "export") {
    var roots = ubTopLevelRoots(figma.currentPage.selection);
    if (!roots.length) { figma.ui.postMessage({ type: "export-error", text: "Select one or more frames first." }); return; }
    try {
      var options = Object.assign(await ubLoadOptions(), msg.options || {});
      var serializer = createUBSerializer(figma, UBGeom, { rasterScaleCap: Number(options.rasterScaleCap) || 3, groupsAs: options.groupsAs, compMode: options.compMode, pluginVersion: UB_PLUGIN_VERSION });
      var result = await serializer.serialize(roots, { source: { fileName: figma.root.name, page: figma.currentPage.name } });
      figma.ui.postMessage({ type: "job", job: result.job, images: result.images.map(function (im) { return { id: im.id, bytes: im.bytes }; }) });
    } catch (err) {
      figma.ui.postMessage({ type: "export-error", text: String(err && err.stack ? err.stack : err) });
    }
  } else if (msg.type === "notify") {
    figma.notify(msg.text, { timeout: 2500, error: !!msg.error });
  }
};
