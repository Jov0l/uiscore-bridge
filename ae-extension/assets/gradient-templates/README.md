# Gradient preset templates (third-party)

These six `.ffx` files are blank "Gradient Fill / Gradient Stroke → Colors" presets.
They come from **zimoby/ae-native-gradient-toolkit** (MIT License, © 2026 Zimoby;
the full license text is in `LICENSE-ae-native-gradient-toolkit.txt`). We took the files
from commit `46e00334…` (2026-07-30).

Uiscore Bridge (`ae-extension/js/ffx.js`) never edits the binary layout by hand. It does this:

1. It reads a template and finds the `GCky` chunk that holds the UTF-8 `prop.map` XML.
2. It replaces the stops XML with the one made by `UBGeom.gradientXml()`.
3. It fixes the RIFX/LIST chunk sizes and keeps the trailing XMP block as it is
   (that block sits outside the RIFX size).
4. It writes `gradients/gN_fill.ffx` / `gN_stroke.ffx` into the job folder.

Then the host script selects the `Colors` property of the G-Fill/G-Stroke and runs
`layer.applyPreset(file)`.

| family  | file                 | used for AE           | proven live          |
|---------|----------------------|-----------------------|----------------------|
| ae22-6  | ae22-6-fill/stroke   | 22.x, 23.x, 24.x      | no (mock + parse only) |
| ae25-6  | ae25-6-fill/stroke   | 25.x                  | no (mock + parse only) |
| ae26-3  | ae26-3-fill/stroke   | 26.x and newer        | yes (upstream, AE 26.3) |

The default stops in the ae25-6 templates are not white→black. That does not matter:
we always replace them.
