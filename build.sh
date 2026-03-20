#!/bin/bash

mkdir -p dist

# --- Firefox (MV2) ---
echo "Building Firefox..."
zip -r dist/netflix-subtitle-translator-firefox.zip \
  manifest.json src/ icons/*.png icons/*.svg \
  -x "**/.DS_Store"
echo "Built: dist/netflix-subtitle-translator-firefox.zip"

# --- Chrome (MV3) ---
echo ""
echo "Building Chrome..."
rm -rf dist/chrome
mkdir -p dist/chrome
cp -r src icons dist/chrome/
cp manifest.chrome.json dist/chrome/manifest.json
pushd dist/chrome > /dev/null
zip -r "$OLDPWD/dist/netflix-subtitle-translator-chrome.zip" . \
  -x "**/.DS_Store"
popd > /dev/null
echo "Built: dist/netflix-subtitle-translator-chrome.zip"
echo "Dev folder: dist/chrome/ (load unpacked in chrome://extensions)"
