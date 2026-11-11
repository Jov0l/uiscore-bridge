![Uiscore Bridge](docs/cover.jpg)

# Uiscore Bridge

**Figma → After Effects, layer by layer.** Native shapes, editable gradients, no raster surprises.

Uiscore Bridge sends Figma frames to After Effects and rebuilds them as editable layers: shape layers, text, precomps, masks, effects and **native gradients** (Gradient Fill / Gradient Stroke with editable stops). Built from scratch with its own JSON schema (`uiscore.bridge.job` v1) and its own transport.

```
Figma plugin ──HTTP POST──► CEP panel in AE (Node, 127.0.0.1:7341)
                            │ writes job.json, PNGs, gradient .ffx presets
                            ▼
                        ExtendScript builder.jsx → comps and layers
```

Version 0.1.0 is the first milestone: static layouts, **no animation yet**.

## Download

Grab `Uiscore_Bridge_v0.1.0_release.zip` from [Releases](../../releases). It contains the signed `UiscoreBridge.zxp`, the `Figma plugin` folder and `INSTALL.txt`.

## Install

**After Effects**
1. Install `UiscoreBridge.zxp` with [ZXP Installer](https://aescripts.com/learn/zxp-installer/).
2. Restart After Effects and open **Window → Extensions → Uiscore Bridge**.
3. Turn on **Edit → Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network**.

**Figma (desktop app)**
1. **Plugins → Development → Import plugin from manifest…** and pick `Figma plugin/manifest.json`.
2. Run it from **Plugins → Development → Uiscore Bridge**.

The AE panel must stay open while you export: it runs the local server on port **7341** (localhost only).

## Usage

- Select a frame or layer in Figma and press **Export in After Effects**.
- The badge at the bottom shows **Connected** or **AE Disconnected**. Click the red badge to recheck the connection; if AE is still unreachable, an alert explains what to do.
- **Scale (1x–4x)**: maximum PNG multiplier for raster layers (default 3x, longest side capped at 3500 px).
- **Group as**: `Precomps` or `Parented nulls`.
- **Target**: `New comp per frame` or `Into active comp`.
- **Mark as raster (\*)** toggles a `*` at the start of the selected layer names. Those layers are exported as PNG, which is handy for noise, complex effects and illustrations.
- Jobs are saved next to your AE project in `Uiscore Bridge/` (or `~/Documents/Uiscore Bridge/` for an unsaved project).
- Light and dark themes follow your Figma setting.

## What's supported (milestone 1)

- Rectangles (including per-corner radius), ellipses, polygons, stars, vectors and lines → shape layers with bezier paths.
- Text → text layers: font, size, tracking, leading, alignment, point and box text, mixed styles (AE 24+).
- Image fills and `*` layers → PNG footage; shadows and blur are re-added in AE as effects.
- Frames, groups, components and instances → precomps (or parenting); `clipsContent` → layer mask.
- Opacity, layer blend modes, multiple solid and gradient fills and strokes (inside / center / outside, dashes, caps, joins).
- Drop shadow → Drop Shadow, layer blur → Gaussian Blur, Figma masks → track mattes.

**Partial / TODO:** inner shadow may fail in localized AE builds; background blur is approximated; boolean operations import as a flattened path; per-side stroke widths, corner smoothing and skew are not supported yet.

## Gradients

Linear and radial gradients become **native** Gradient Fill / Gradient Stroke with editable color and opacity stops. ExtendScript can't write gradient stops directly, so the panel generates an `.ffx` preset per gradient and applies it to the layer. End points are recalculated so the gradient matches Figma pixel for pixel, including on rotated and non-square shapes. If a preset can't be applied, the layer falls back to a Gradient Ramp effect with a warning. **Nothing is ever rasterized.**

Known limits: elliptical radials are built on the major axis, angular and diamond gradients are built as radial (with a warning).

## Development

```sh
npm install        # only acorn (checks that host scripts are pure ES3)
npm test           # build + node --test "tests/*.test.js"
npm run example    # full pipeline on a sample card → examples/
npm run visual     # docs/gradients_compare.png
```

Run `npm run build` after editing `shared/geom.js` or `figma-plugin/src/*`. The JSON schema is described in [docs/schema.md](docs/schema.md).

| Path | Contents |
|---|---|
| `figma-plugin/` | Figma plugin: `manifest.json`, `src/` sources, built `code.js` and `ui.html` |
| `ae-extension/` | CEP panel for After Effects: manifest, HTTP server, preset generator, ExtendScript host |
| `shared/geom.js` | Shared math: matrices, transforms, gradients, paths, shadows |
| `scripts/` | Build and optional `.zxp` packaging |
| `tests/` | `node:test` suites |
| `tools/` | Example pipeline and visual comparison tools |

## Third-party

`ae-extension/assets/gradient-templates/*.ffx` are templates from [zimoby/ae-native-gradient-toolkit](https://github.com/zimoby/ae-native-gradient-toolkit), MIT License © 2026 Zimoby (see `LICENSE-ae-native-gradient-toolkit.txt` in that folder).

---

Built by Uiscore. Bug reports and feedback are welcome in [Issues](../../issues).
