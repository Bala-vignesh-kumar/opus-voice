// swift/RemoteCommandsTests.swift
// The gesture half of the headphone wake, which is a pure mapping and so can
// be tested without headphones, a Bluetooth stack, or the Now Playing role.

func runRemoteCommandsTests() -> Int {
  var failures = 0

  func expect(_ actual: WakeGesture?, _ wanted: WakeGesture?, _ what: String) {
    if actual != wanted {
      print("  ✗ \(what): got \(String(describing: actual)), wanted \(String(describing: wanted))")
      failures += 1
    }
  }

  // Which squeeze sends which command differs by model and by the settings in
  // Bluetooth, so all three of these arrive as "one squeeze".
  expect(gesture(forCommand: "toggle"), .playPause, "toggle is one squeeze")
  expect(gesture(forCommand: "play"), .playPause, "play is one squeeze")
  expect(gesture(forCommand: "pause"), .playPause, "pause is one squeeze")
  expect(gesture(forCommand: "next"), .next, "next is two squeezes")
  expect(gesture(forCommand: "previous"), .previous, "previous is three squeezes")

  // Anything else is a command we registered for but do not bind, and must not
  // resolve to a gesture — least of all to the default one.
  expect(gesture(forCommand: "seekForward"), nil, "an unbound command is not a gesture")
  expect(gesture(forCommand: ""), nil, "an empty command is not a gesture")

  func expectNamed(_ raw: String?, _ wanted: WakeGesture, _ what: String) {
    if WakeGesture.named(raw) != wanted {
      print("  ✗ \(what): got \(WakeGesture.named(raw)), wanted \(wanted)")
      failures += 1
    }
  }

  expectNamed("playPause", .playPause, "playPause by name")
  expectNamed("next", .next, "next by name")
  expectNamed("previous", .previous, "previous by name")
  // A typo in config.json must leave the gesture working rather than binding
  // nothing at all, so it falls back to the common case.
  expectNamed("nxt", .playPause, "an unknown name falls back")
  expectNamed(nil, .playPause, "an absent setting falls back")

  if failures == 0 { print("  ✓ headphone gesture mapping") }
  return failures
}
