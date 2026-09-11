#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
app_path="$root_dir/dist/FeishuGrabber.app"
contents="$app_path/Contents"
resources="$contents/Resources"
engine="$resources/engine"
build_dir="$root_dir/.build-app"
icon_source="$root_dir/macos/AppIcon-1024.png"
iconset="$build_dir/AppIcon.iconset"

if [[ -e "$app_path" ]]; then
  case "$app_path" in
    "$root_dir/dist/FeishuGrabber.app") /bin/rm -rf -- "$app_path" ;;
    *) echo "Refusing to replace unexpected path: $app_path" >&2; exit 2 ;;
  esac
fi

runtime_node="${FEISHU_NODE_BIN:-}"
codex_node="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [[ -z "$runtime_node" && -x "$codex_node" ]]; then
  runtime_node="$codex_node"
fi
if [[ -z "$runtime_node" ]]; then
  runtime_node="$(command -v node || true)"
fi
if [[ -z "$runtime_node" || ! -x "$runtime_node" ]]; then
  echo "A standalone Node.js binary is required. Set FEISHU_NODE_BIN=/path/to/node." >&2
  exit 1
fi
if otool -L "$runtime_node" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/System/|/usr/lib/)' | grep -q .; then
  echo "Node.js has non-system dynamic dependencies and cannot be bundled safely: $runtime_node" >&2
  echo "Set FEISHU_NODE_BIN to a standalone official Node.js binary." >&2
  exit 1
fi

mkdir -p "$contents/MacOS" "$resources/runtime" "$engine/tools"

if [[ ! -f "$icon_source" ]]; then
  echo "Missing app icon source: $icon_source" >&2
  exit 1
fi

if [[ -e "$iconset" ]]; then
  case "$iconset" in
    "$root_dir/.build-app/AppIcon.iconset") /bin/rm -rf -- "$iconset" ;;
    *) echo "Refusing to replace unexpected path: $iconset" >&2; exit 2 ;;
  esac
fi
mkdir -p "$iconset"
sips -z 16 16 "$icon_source" --out "$iconset/icon_16x16.png" >/dev/null
sips -z 32 32 "$icon_source" --out "$iconset/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$icon_source" --out "$iconset/icon_32x32.png" >/dev/null
sips -z 64 64 "$icon_source" --out "$iconset/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$icon_source" --out "$iconset/icon_128x128.png" >/dev/null
sips -z 256 256 "$icon_source" --out "$iconset/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$icon_source" --out "$iconset/icon_256x256.png" >/dev/null
sips -z 512 512 "$icon_source" --out "$iconset/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$icon_source" --out "$iconset/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$icon_source" --out "$iconset/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$iconset" -o "$resources/AppIcon.icns"

xcrun swiftc \
  -swift-version 5 \
  -parse-as-library \
  -target arm64-apple-macos13.0 \
  -framework SwiftUI \
  -framework AppKit \
  "$root_dir/macos/FeishuGrabberApp.swift" \
  -o "$contents/MacOS/FeishuGrabber"

cp "$root_dir/macos/Info.plist" "$contents/Info.plist"
cp "$runtime_node" "$resources/runtime/node"
chmod +x "$resources/runtime/node"

cp "$root_dir/grab.mjs" "$engine/grab.mjs"
cp "$root_dir/package.json" "$engine/package.json"
cp -R "$root_dir/lib" "$engine/lib"
cp "$root_dir/tools/ai-chrome.mjs" "$engine/tools/ai-chrome.mjs"
cp -R "$root_dir/node_modules" "$engine/node_modules"

codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"

echo "Built: $app_path"
du -sh "$app_path"
