#!/bin/sh
set -eu

npm_version="$(node -p "require('./package.json').engines.npm")"
if [ "$(npm --version)" = "$npm_version" ]; then
  exit 0
fi
npm install --global "npm@$npm_version" --ignore-scripts
