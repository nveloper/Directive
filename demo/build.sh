#!/bin/sh
# Assembles the static demo: the app's own frontend from server/static, with
# demo/index.html and demo/mock-api.js in place of the server.
# Usage: demo/build.sh [output-dir]   (default: _site)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-_site}
rm -rf "$out"
mkdir -p "$out"
cp -R "$here/../server/static/." "$out/"
cp "$here/index.html" "$here/mock-api.js" "$out/"
touch "$out/.nojekyll"
echo "demo written to $out"
