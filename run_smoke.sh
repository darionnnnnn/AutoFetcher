#!/bin/bash
# 用 Chrome for Testing 跑煙霧測試(一般 Chrome 152 起已封鎖 --load-extension)
set -eu
cd "$(dirname "$0")"
node tests/smoke/run.mjs
EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
# Windows(Git Bash)的 Edge 路徑
if [ ! -x "$EDGE" ]; then EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; fi
if [ ! -x "$EDGE" ]; then EDGE="/c/Program Files/Microsoft/Edge/Application/msedge.exe"; fi
if [ -x "$EDGE" ]; then BROWSER_PATH="$EDGE" node tests/smoke/load.mjs; else echo "SKIP:本機未安裝 Edge"; fi
