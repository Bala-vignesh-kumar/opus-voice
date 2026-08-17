#!/bin/bash
# Builds the voiceio audio daemon.
#
# The Info.plist is linked into the binary's __TEXT section because macOS reads
# the usage-description strings from there before it will show the microphone
# and speech-recognition permission prompts. A plain CLI binary without it gets
# killed the moment it touches the mic.
set -euo pipefail

cd "$(dirname "$0")"

echo "building voiceio…"
swiftc -O \
  -o bin/voiceio \
  swift/VoiceIO.swift \
  -framework AVFoundation \
  -framework Speech \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker swift/Info.plist

# Ad-hoc signature so TCC can track the binary's identity across rebuilds.
codesign --force --sign - bin/voiceio 2>/dev/null || echo "note: ad-hoc codesign skipped"

echo "built bin/voiceio"
