// The one file allowed to have statements at file scope. Everything else hands
// it a count of failures.

import Foundation

@main
struct SwiftTests {
  static func main() {
    let failures = runMenuBarStateTests() + runEnvironmentTests() + runUtteranceTests() + runTurnAssemblerTests()
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }
}
