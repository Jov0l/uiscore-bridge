#!/usr/bin/env bash
# Package ae-extension/ into a signed .zxp (optional — for development use debug mode, see README).
# Needs Adobe's ZXPSignCmd (https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD) in PATH or $ZXPSIGNCMD.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist"; mkdir -p "$OUT_DIR"
ZXP="$OUT_DIR/uiscore-bridge-0.1.0.zxp"
CERT="$OUT_DIR/uiscore-selfsigned.p12"
PASS="${ZXP_PASSWORD:-uiscore}"
SIGN="${ZXPSIGNCMD:-$(command -v ZXPSignCmd || true)}"

node "$ROOT/scripts/build.js"

if [ -z "$SIGN" ]; then
  cat <<MSG
ZXPSignCmd not found — nothing signed.
  * For development you do NOT need a .zxp: enable PlayerDebugMode and copy ae-extension/
    to the CEP extensions folder as com.uiscore.bridge (see README.md).
  * To build a .zxp: download ZXPSignCmd from Adobe-CEP/CEP-Resources, put it in PATH
    (or export ZXPSIGNCMD=/path/to/ZXPSignCmd) and rerun: npm run package
MSG
  exit 0
fi

if [ ! -f "$CERT" ]; then
  "$SIGN" -selfSignedCert RU Moscow Uiscore "Uiscore Bridge" "$PASS" "$CERT"
fi
STAGE="$(mktemp -d)/com.uiscore.bridge"
mkdir -p "$STAGE"
cp -R "$ROOT/ae-extension/." "$STAGE/"
rm -f "$STAGE/.debug"
rm -f "$ZXP"
"$SIGN" -sign "$STAGE" "$ZXP" "$CERT" "$PASS" -tsa http://timestamp.digicert.com
echo "Signed: $ZXP (self-signed; install with ZXP Installer / UPIA)"
