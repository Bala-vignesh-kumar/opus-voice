#!/bin/bash
# Compiles and runs the Swift unit tests.
#
# swiftc directly rather than XCTest or SPM: the project builds its binaries
# with swiftc from build.sh, and one pure function does not justify introducing
# a package manifest and a test framework alongside it.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
out="$work/swift-tests"

echo "swift tests…"
swiftc -o "$out" \
  swift/MenuBarState.swift swift/MenuBarStateTests.swift \
  swift/Environment.swift swift/EnvironmentTests.swift \
  swift/Utterance.swift swift/UtteranceTests.swift \
  swift/TurnAssembler.swift swift/TurnAssemblerTests.swift \
  swift/UtteranceBuffer.swift swift/UtteranceBufferTests.swift \
  swift/AppLaunch.swift swift/AppLaunchTests.swift \
  swift/RemoteCommands.swift swift/RemoteCommandsTests.swift \
  swift/EchoPolicy.swift swift/EchoPolicyTests.swift \
  swift/Downsampler.swift swift/DownsamplerTests.swift \
  swift/TranscriptDecision.swift swift/TranscriptDecisionTests.swift \
  swift/Endpoint.swift swift/EndpointTests.swift \
  swift/TestMain.swift
"$out"
