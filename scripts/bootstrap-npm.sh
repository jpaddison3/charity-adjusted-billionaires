#!/bin/sh
set -eu

npm_version="$(node -p "require('./package.json').engines.npm")"
npm install --global "npm@$npm_version" --ignore-scripts
