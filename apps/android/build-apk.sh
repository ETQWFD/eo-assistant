#!/usr/bin/env bash
# Build a signed EO Assistant APK without Gradle.
#
# Requires: JDK 17, Android SDK build-tools + platform android-35, zip.
# Usage:
#   ANDROID_HOME=/home/user/Android/Sdk ./build-apk.sh
#   EO_KEYSTORE_PASS=... EO_KEYSTORE=release.keystore ./build-apk.sh
#
# The default keystore is generated under build/ for local/sideload testing.
# Never reuse the default password for a public release.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/home/user/Android/Sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/35.0.0}"
API_JAR="${API_JAR:-$SDK/platforms/android-35/android.jar}"
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$PATH"

for tool in aapt2 d8 apksigner zipalign; do
  test -x "$BUILD_TOOLS/$tool" || { echo "missing $BUILD_TOOLS/$tool" >&2; exit 1; }
done
test -f "$API_JAR" || { echo "missing android.jar: $API_JAR" >&2; exit 1; }

VERSION_NAME="$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' AndroidManifest.xml | head -1)"
OUT="releases/eo-assistant-${VERSION_NAME}.apk"
KEYSTORE="${EO_KEYSTORE:-keystore/eo-release.jks}"
KEYSTORE_PASS="${EO_KEYSTORE_PASS:-eo-assistant-local-only}"
KEY_ALIAS="${EO_KEY_ALIAS:-eo}"

rm -rf build
mkdir -p build/res build/gen build/classes build/dex build/keystore releases

echo "[1/7] compile resources"
"$BUILD_TOOLS/aapt2" compile --dir res -o build/res.zip

echo "[2/7] link resources"
"$BUILD_TOOLS/aapt2" link \
  -o build/base.apk \
  -I "$API_JAR" \
  --manifest AndroidManifest.xml \
  -R build/res.zip \
  --java build/gen \
  --auto-add-overlay

echo "[3/7] compile java"
find src build/gen -name '*.java' > build/sources.txt
javac -source 11 -target 11 -classpath "$API_JAR" -d build/classes @build/sources.txt

echo "[4/7] dex"
"$BUILD_TOOLS/d8" --lib "$API_JAR" --min-api 24 --output build/dex \
  $(find build/classes -name '*.class')
cp build/dex/classes.dex build/classes.dex
(cd build && zip -q base.apk classes.dex)

echo "[5/7] align"
"$BUILD_TOOLS/zipalign" -f 4 build/base.apk build/aligned.apk

echo "[6/7] sign"
mkdir -p "$(dirname "$KEYSTORE")"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair \
    -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" \
    -alias "$KEY_ALIAS" -keypass "$KEYSTORE_PASS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=EO Assistant, OU=EO, O=EO, L=Local, ST=Local, C=CN"
fi
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" \
  --ks-key-alias "$KEY_ALIAS" --key-pass "pass:$KEYSTORE_PASS" \
  --min-sdk-version 24 \
  --out "$OUT" build/aligned.apk

echo "[7/7] verify"
"$BUILD_TOOLS/apksigner" verify --min-sdk-version 24 --print-certs "$OUT" | sed -n '1,12p'
ls -lh "$OUT"
echo "built: $(pwd)/$OUT"
