#!/bin/bash
# 用 Chrome for Testing 跑煙霧測試(一般 Chrome 152 起已封鎖 --load-extension)
set -e
cd "$(dirname "$0")"
CFT=$(ls -d .browsers/chrome/*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | head -1)
if [ -z "$CFT" ]; then
  echo "缺少 Chrome for Testing,先跑:npx @puppeteer/browsers install chrome@stable --path \"\$PWD/.browsers\""
  exit 1
fi
BROWSER_PATH="$PWD/$CFT" node tests/smoke/load.mjs
EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
if [ -x "$EDGE" ]; then BROWSER_PATH="$EDGE" node tests/smoke/load.mjs; else echo "SKIP:本機未安裝 Edge"; fi
