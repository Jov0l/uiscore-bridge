# Uiscore Bridge job schema (`uiscore.bridge.job`, version 1)

This is our own format. It is not compatible with AEUX.

## Transport (Figma UI → panel)

`POST http://127.0.0.1:7341/import` with `Content-Type: text/plain`, which avoids a CORS preflight. The body is JSON:

```json
{ "job": { ... }, "images": { "img_1": "<base64 PNG>", ... } }
```

The panel writes the job folder `<project folder or ~/Documents>/Uiscore Bridge/<timestamp>_<slug>/`:
`job.json`, `images/*.png`, `gradients/*.ffx`. It then calls `UiscoreBridge.importJob(path)` and replies:
`{ ok, summary, comps[], warnings[], jobDir, jobFile, stats }`. `warnings` combines Figma-side warnings (`[Figma] …`), preset errors and host warnings.

`GET /ping` → `{ ok, app: "uiscore-bridge", version, schema, schemaVersion, host: {app:"AEFT", version} }`.

## Root

| key | type | note |
|---|---|---|
| schema | `"uiscore.bridge.job"` | |
| version | `1` | |
| id, createdAt | string | |
| source | `{app:"figma", plugin, file, page}` | |
| options | `{compMode:"new"\|"active", groupsAs:"precomp"\|"parent", rasterScaleCap, fps, duration}` | |
| comps[] | Comp | one per selected top-level node |
| assets.images | `{ id: {file, nodeId} }` | |
| warnings[] | `{id, name, message}` | serializer warnings |

## Comp
`{ id, name, width, height, background: Paint[], root: Node }`

## Node (shared fields)
| key | note |
|---|---|
| id, name, figmaType | the source node |
| type | `frame, group, component, instance, rect, ellipse, polygon, star, path, line, boolean, text` |
| visible, opacity, blend (AE name), figmaBlend | |
| size `{w,h}` | |
| transform | `matrixLocal` / `matrixComp` = `[a,b,c,d,tx,ty]`; `local` / `comp` = `{position, rotation°, scale%, skew, anchor}` (anchor 0,0 = top-left; a mirror becomes a negative Y scale). Optional `rasterPlacement`. |
| isMask, maskType (`ALPHA`/`VECTOR`/`LUMINANCE`), clipsContent | |
| fills: Paint[], strokes: `{paints[], weight, individualWeights, align, dash[], cap, aeCap, join, aeJoin, miterLimit}` | |
| effects[] | `dropShadow / innerShadow {color, opacity, direction, distance, softness, spread, showBehindNode}`, `layerBlur / backgroundBlur {radius, blurriness}`; `bakedIntoRaster` when the effect is already in the PNG |
| geometry | `{primitive:"rect", radius: n \| [tl,tr,br,bl]}` \| `{primitive:"ellipse"}` \| `{primitive:"path", paths:[{closed, vertices, inTangents, outTangents, windingRule}], booleanOp?}` |
| text | `{characters, autoResize, alignH, alignV, justification, paragraphSpacing, truncation, font, size, tracking, leading, fills, segments[]}` |
| raster | `{asset, reason:"marked"\|"imageFill"\|…, scale, pixelSize, bounds}`; the node is placed as a PNG |
| children[] | |

## Paint
Shared: `{visible, opacity, blend, type}`.

* `solid`: `color [r,g,b]` (0–1)
* `image`: `scaleMode, imageHash` (the node itself becomes a raster)
* `gradient`:
  * `kind`: `linear | radial | angular | diamond` (angular/diamond are built as radial, with a warning)
  * `stops[]`: `{position, color:[r,g,b,a]}`, the original Figma stops
  * `split`: `{colorStops:[{offset, midpoint, rgb}], alphaStops:[{offset, midpoint, alpha}]}`, sorted stops in the same layout as AE
  * `handles` (layer px): `start, end` (AE points; `end` is corrected for non-square boxes, see README), `figmaEnd`, and for radial also `center, minorEnd, radii, aspect`, `angle, length`
  * `handlesComp`: the same points in comp px (for debugging / ramp)
  * `gradientTransform`: the raw Figma matrix
