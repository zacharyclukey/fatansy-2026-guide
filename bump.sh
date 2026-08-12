#!/bin/sh
# Bump the cache-busting version stamped on every asset URL.
#
# GitHub Pages serves css/js with a long max-age, so a browser will happily keep showing
# the old file for hours after a push. A changing ?v= makes the URL itself different, so
# there is nothing cached to reuse. Run this before committing a change.
V=$(date +%Y%m%d%H%M)
sed -i -E "s/\?v=[0-9]+/?v=$V/g" index.html app.js
sed -i -E "s/const BUILD = '[^']*'/const BUILD = '$V'/" app.js
echo "build $V"
