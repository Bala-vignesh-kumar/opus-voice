// swift/AppLaunchTests.swift
// Compiled together with AppLaunch.swift by scripts/test-swift.sh.
//
// A function rather than top-level code: Swift only allows statements at file
// scope in main.swift, so every test file hands its work to swift/TestMain.swift.

func runAppLaunchTests() -> Int {
  var failures = 0

  func expect(_ actual: Bool, _ wanted: Bool, _ what: String) {
    if actual != wanted {
      print("  ✗ \(what): got \(actual), wanted \(wanted)")
      failures += 1
    }
  }

  // Somebody double-clicked it, or picked it out of Spotlight. They want to see
  // something.
  expect(shouldOpenWindowAtLaunch(isDefaultLaunch: true), true, "a person opened it")

  // The login item. The app comes up with the machine, and a window nobody
  // asked for landing on a fresh desktop every morning is the behaviour this
  // whole check exists to prevent.
  expect(shouldOpenWindowAtLaunch(isDefaultLaunch: false), false, "the system opened it")

  if failures == 0 { print("  ✓ launch decisions") }
  return failures
}
