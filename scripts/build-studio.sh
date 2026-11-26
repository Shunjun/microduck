#!/bin/sh
# Build the browser bundle before embedding it in the board's Rust binary.
# The board runs the embedded output; it does not need Node or npm.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
command -v npm >/dev/null 2>&1 || {
    echo 'Studio frontend builds require Node.js 22 and npm on the build machine.' >&2
    exit 1
}
npm --prefix studio/frontend ci
npm --prefix studio/frontend run build
