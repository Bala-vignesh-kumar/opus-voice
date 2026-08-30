#!/bin/bash
# Builds the voiceio audio daemon.
#
# The Info.plist is linked into the binary's __TEXT section because macOS reads
# the usage-description strings from there before it will show the microphone
# and speech-recognition permission prompts. A plain CLI binary without it gets
# killed the moment it touches the mic.
set -euo pipefail

cd "$(dirname "$0")"

# Git does not track empty directories, so a fresh clone has no bin/ and the
# linker fails with a bare "No such file or directory".
mkdir -p bin

echo "building voiceio…"
swiftc -O \
  -o bin/voiceio \
  swift/VoiceIO.swift \
  swift/Utterance.swift \
  swift/TurnAssembler.swift \
  swift/UtteranceBuffer.swift \
  swift/InputDevice.swift \
  swift/Keepalive.swift \
  -framework AVFoundation \
  -framework Speech \
  -framework CoreAudio \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker swift/Info.plist

# Ad-hoc signature so TCC can track the binary's identity across rebuilds.
codesign --force --sign - bin/voiceio 2>/dev/null || echo "note: ad-hoc codesign skipped"

echo "built bin/voiceio"

# The window on its own, for `npm run app`. Separate binary because it is
# optional: the terminal UI works without it, so a failure here must not stop
# the audio daemon shipping.
#
# FalconWindow.swift is compiled into this and into the app below. One window,
# two entry points — the duplicate that used to live in VoiceApp.swift had
# already drifted.
echo "building falcon-window…"
if swiftc -O \
  -o bin/falcon-window \
  swift/FalconWindow.swift \
  swift/Environment.swift \
  swift/WindowMain.swift \
  -framework AppKit \
  -framework WebKit; then
  codesign --force --sign - bin/falcon-window 2>/dev/null || true
  echo "built bin/falcon-window"
else
  echo "note: falcon-window did not build — 'npm start' still works, 'npm run app' will open your browser"
fi

# The menu bar app. Like voiceapp it is optional — the terminal workflow does
# not need it, so a failure here must not stop the audio daemon shipping.
echo "building falcon…"
if swiftc -O \
  -o bin/falcon \
  swift/MenuBarState.swift \
  swift/AppLaunch.swift \
  swift/Environment.swift \
  swift/RemoteCommands.swift \
  swift/Orchestrator.swift \
  swift/SessionClient.swift \
  swift/StatusItem.swift \
  swift/FalconWindow.swift \
  swift/FalconApp.swift \
  -framework AppKit \
  -framework WebKit \
  -framework MediaPlayer \
  -framework ServiceManagement; then
  codesign --force --sign - bin/falcon 2>/dev/null || true
  echo "built bin/falcon"
else
  echo "note: falcon did not build — 'npm start' and 'npm run app' still work"
fi
