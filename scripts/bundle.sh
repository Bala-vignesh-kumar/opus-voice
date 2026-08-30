#!/bin/bash
# Builds Falcon.app.
#
# The bundle is a thin launcher: it holds the menu bar binary and nothing else.
# Copying src/, ui/ and vendor/ in would duplicate 231MB of Piper runtime and
# voice models into /Applications, and would mean every `git pull` needed a
# rebundle to take effect. Instead the repository's absolute path is recorded
# here and the app runs against the working tree in place.
#
# node is resolved here too, for the same reason the Siri hook takes no PATH: a
# process started at login inherits no useful one.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

green=$'\033[38;5;114m'; amber=$'\033[38;5;179m'; dim=$'\033[2m'; bold=$'\033[1m'; reset=$'\033[0m'
APP="${FALCON_APP_DIR:-/Applications}/Falcon.app"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  printf '%s✗%s node is not on PATH — install it first\n' "$amber" "$reset"
  exit 1
fi

if [ ! -x bin/falcon ]; then
  printf '%sbuilding first…%s\n' "$dim" "$reset"
  ./build.sh
fi
[ -x bin/falcon ] || { printf '%s✗%s bin/falcon did not build\n' "$amber" "$reset"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp bin/falcon "$APP/Contents/MacOS/Falcon"
mkdir -p "$APP/Contents/Resources"
cp assets/Falcon.icns "$APP/Contents/Resources/Falcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.falcon.app</string>
  <key>CFBundleName</key><string>Falcon</string>
  <key>CFBundleDisplayName</key><string>Falcon</string>
  <key>CFBundleExecutable</key><string>Falcon</string>
  <key>CFBundleIconFile</key><string>Falcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Falcon listens to your microphone so you can talk to Claude hands-free.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Falcon transcribes your speech on-device so Claude can respond to what you say.</string>
  <!-- Recorded rather than discovered: a login-launched app has no PATH and no
       working directory to find these from. -->
  <key>FalconRepoRoot</key><string>$ROOT</string>
  <key>FalconNodePath</key><string>$NODE</string>
</dict>
</plist>
PLIST

# Ad-hoc signature so TCC can track the bundle's identity across rebuilds. The
# permission grant is attached to this, which is why the prompt can finally say
# "Falcon" rather than "Terminal".
codesign --force --deep --sign - "$APP" 2>/dev/null

# Verify rather than assume, the same way install.sh does.
#
# The command is passed in rather than run first, because under `set -e` a
# failing check would abort the script before it could report the failure —
# which turns "one thing is wrong" into "nothing happened and I don't know why".
fail=0
check() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '%s✓%s %s\n' "$green" "$reset" "$what"
  else
    printf '%s✗%s %s\n' "$amber" "$reset" "$what"
    fail=1
  fi
}

printf '\n'
check "the binary is in place" test -x "$APP/Contents/MacOS/Falcon"
check "the icon is in place" test -f "$APP/Contents/Resources/Falcon.icns"
check "the repo path is recorded" /usr/libexec/PlistBuddy -c "Print :FalconRepoRoot" "$APP/Contents/Info.plist"
check "the node path is recorded" /usr/libexec/PlistBuddy -c "Print :FalconNodePath" "$APP/Contents/Info.plist"
check "the signature verifies" codesign --verify --deep "$APP"
check "config.json sets \"dir\"" node -e 'import("./src/config.mjs").then(m=>process.exit(m.loadConfig().dir?0:1))'

if [ "$fail" != 0 ]; then
  printf '\n%sthe bundle is not usable yet — fix the ✗ above%s\n' "$amber" "$reset"
  printf '\n  %s"dir"%s is the project it wakes up in. At login there is no working\n' "$bold" "$reset"
  printf '  directory, so it will not start without one:\n\n'
  printf '      %s"dir": "/Users/you/code/the-project"%s\n\n' "$dim" "$reset"
  exit 1
fi

printf '\n%s✓%s %s\n' "$green" "$reset" "$APP"
printf '\n  Open it once to grant Microphone and Speech Recognition:\n'
printf '    %sopen -a "Falcon"%s\n' "$dim" "$reset"
printf '\n  It registers itself as a login item on first launch. Turn that off in\n'
printf '  System Settings › General › Login Items, or from its own menu.\n\n'
