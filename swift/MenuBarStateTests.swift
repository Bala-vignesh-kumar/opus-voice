// swift/MenuBarStateTests.swift
// Compiled together with MenuBarState.swift by scripts/test-swift.sh. Plain
// assertions rather than XCTest, because one pure function does not justify a
// test framework the rest of this project does not use.
//
// A function rather than top-level code: Swift only allows statements at file
// scope in main.swift, so every test file hands its work to the entry point in
// swift/TestMain.swift.

func runMenuBarStateTests() -> Int {
  var failures = 0

  func expect(_ actual: String, _ wanted: String, _ what: String) {
    if actual != wanted {
      print("  ✗ \(what): got \(actual), wanted \(wanted)")
      failures += 1
    }
  }

  expect(menuBarSymbol(mode: "asleep", status: nil, failed: false), "moon.zzz", "asleep")
  expect(menuBarSymbol(mode: "awake", status: nil, failed: false), "waveform", "awake")
  expect(menuBarSymbol(mode: "chat", status: nil, failed: false), "waveform", "chat")
  expect(menuBarSymbol(mode: "note", status: nil, failed: false), "record.circle", "note")

  // A turn in flight outranks the mode: what it is doing right now is more
  // informative than which mode it is in while it does it.
  expect(menuBarSymbol(mode: "awake", status: "thinking", failed: false), "waveform.circle.fill", "thinking")
  expect(menuBarSymbol(mode: "note", status: "speaking", failed: false), "waveform.circle.fill", "speaking")

  // Failure outranks everything. An app that looks fine while broken is the one
  // outcome this whole design refuses.
  expect(menuBarSymbol(mode: "awake", status: "thinking", failed: true), "exclamationmark.triangle", "failed")

  // An unknown mode must still draw something rather than an empty menu bar.
  expect(menuBarSymbol(mode: "something-new", status: nil, failed: false), "waveform", "unknown mode")

  // An empty status is not a status; it must not read as a turn in flight.
  expect(menuBarSymbol(mode: "asleep", status: "", failed: false), "moon.zzz", "empty status")

  if failures == 0 { print("  ✓ menu bar state mapping") }
  return failures
}
