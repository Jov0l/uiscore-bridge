/*
 * Uiscore Bridge - native AE gradient preset (.ffx) writer. Node / CEP side.
 *
 * After Effects does not let ExtendScript set "ADBE Vector Grad Colors" (propertyValueType NO_VALUE).
 * What AE *does* accept is an animation preset whose payload contains the gradient as a
 * "prop.map" XML document inside a LIST('GCky') -> 'Utf8' chunk of a big-endian RIFX file.
 * We take a tiny AE-authored template preset (one Gradient Fill or Gradient Stroke "Colors" property,
 * see assets/gradient-templates/README.md for provenance), swap that XML, re-serialize the RIFX tree
 * with corrected chunk sizes, and the ExtendScript side applies it with layer.applyPreset() while the
 * target Colors property is selected. Result: a fully editable native gradient in AE's gradient editor.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const LIST_IDS = { RIFX: true, RIFF: true, LIST: true };

function parseChunks(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    const id = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const dataStart = off + 8;
    if (dataStart + size > end) throw new Error("RIFX chunk '" + id + "' at " + off + " overruns its parent");
    const node = { id, size };
    if (LIST_IDS[id]) {
      node.formType = buf.toString("latin1", dataStart, dataStart + 4);
      node.children = parseChunks(buf, dataStart + 4, dataStart + size);
    } else {
      node.data = buf.subarray(dataStart, dataStart + size);
    }
    out.push(node);
    off = dataStart + size + (size & 1);
  }
  return out;
}

/** Parse a RIFX file into { root, trailer } (trailer = bytes after the RIFX boundary, e.g. XMP). */
function parseRifx(buf) {
  if (buf.toString("latin1", 0, 4) !== "RIFX") throw new Error("Not a RIFX file");
  const size = buf.readUInt32BE(4);
  const end = 8 + size;
  if (end > buf.length) throw new Error("RIFX size exceeds file length");
  const root = { id: "RIFX", size, formType: buf.toString("latin1", 8, 12), children: parseChunks(buf, 12, end) };
  return { root, trailer: buf.subarray(end + (size & 1)) };
}

function serializeNode(node) {
  let body;
  if (node.children) {
    const parts = [Buffer.from(node.formType, "latin1")];
    for (const c of node.children) parts.push(serializeNode(c));
    body = Buffer.concat(parts);
  } else {
    body = Buffer.from(node.data);
  }
  const head = Buffer.alloc(8);
  head.write(node.id, 0, 4, "latin1");
  head.writeUInt32BE(body.length, 4);
  const pad = body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, body, pad]);
}

function serializeRifx(doc) {
  return Buffer.concat([serializeNode(doc.root), doc.trailer]);
}

function findAll(node, pred, acc) {
  acc = acc || [];
  if (pred(node)) acc.push(node);
  if (node.children) for (const c of node.children) findAll(c, pred, acc);
  return acc;
}

/** Locate the single LIST('GCky') -> 'Utf8' gradient payload. */
function findGradientPayload(doc) {
  const lists = findAll(doc.root, (n) => n.id === "LIST" && n.formType === "GCky");
  if (lists.length !== 1) throw new Error("Template must contain exactly one GCky gradient, found " + lists.length);
  const utf8 = lists[0].children.filter((c) => c.id === "Utf8");
  if (utf8.length !== 1) throw new Error("GCky list must contain exactly one Utf8 chunk");
  return utf8[0];
}

function readGradientXml(buf) {
  return findGradientPayload(parseRifx(buf)).data.toString("utf8");
}

/** Validate split stops ({colorStops, alphaStops}) before writing. */
function validateSplit(split) {
  for (const key of ["colorStops", "alphaStops"]) {
    const list = split[key];
    if (!Array.isArray(list) || list.length < 2) throw new Error(key + " needs at least 2 stops");
    let prev = -1;
    for (const s of list) {
      if (!(s.offset >= 0 && s.offset <= 1)) throw new Error(key + " offset out of range: " + s.offset);
      if (s.offset < prev) throw new Error(key + " offsets must be non-decreasing");
      prev = s.offset;
    }
  }
}

/** Template bytes + gradient XML string -> new .ffx bytes. */
function buildGradientFfx(templateBuf, xml) {
  const doc = parseRifx(templateBuf);
  const payload = findGradientPayload(doc);
  payload.data = Buffer.from(xml, "utf8");
  return serializeRifx(doc);
}

/** Pick the template family for an AE version string ("26.3.0", "23.6x56", ...). */
function templateFamily(aeVersion) {
  const major = parseInt(String(aeVersion || "26"), 10) || 26;
  if (major >= 26) return "ae26-3";
  if (major >= 25) return "ae25-6";
  return "ae22-6"; // AE 2022 (22.x), 2023 (23.x), 2024 (24.x): oldest template, newer AE reads older presets
}

function templatePath(templatesDir, aeVersion, kind) {
  return path.join(templatesDir, templateFamily(aeVersion) + "-" + (kind === "stroke" ? "stroke" : "fill") + ".ffx");
}

function writeGradientFfx(opts) {
  const G = opts.geom;
  validateSplit(opts.split);
  const xml = G.gradientXml(opts.split);
  const tpl = fs.readFileSync(templatePath(opts.templatesDir, opts.aeVersion, opts.kind));
  const bytes = buildGradientFfx(tpl, xml);
  fs.writeFileSync(opts.outFile, bytes);
  return { file: opts.outFile, bytes: bytes.length, family: templateFamily(opts.aeVersion) };
}

module.exports = { parseRifx, serializeRifx, findGradientPayload, readGradientXml, buildGradientFfx, templateFamily, templatePath, writeGradientFfx, validateSplit };
