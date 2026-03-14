#!/bin/bash
zip -r netflix-subtitle-translator.zip \
  manifest.json \
  src/ popup/ options/ icons/*.png icons/*.svg \
  -x "**/.DS_Store"
