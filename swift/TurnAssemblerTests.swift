import Foundation

func runTurnAssemblerTests() -> Int {
  var failures = 0
  func expect(_ actual: String, _ wanted: String, _ what: String) {
    if actual != wanted {
      print("  ✗ \(what): got \(actual.debugDescription), wanted \(wanted.debugDescription)")
      failures += 1
    }
  }

  // Ordinary turn: volatile text revises, then finalizes.
  var a = TurnAssembler()
  a.add("what", isFinal: false)
  expect(a.running, "what", "volatile text is the turn so far")
  a.add("what files", isFinal: false)
  expect(a.running, "what files", "volatile text replaces, not appends")
  a.add("what files are here", isFinal: true)
  expect(a.running, "what files are here", "finalized text becomes the turn")

  // Taking that turn clears it.
  a.beginBarrier()
  a.endBarrier()
  expect(a.running, "", "the turn is consumed once the barrier lands")

  // The next turn starts from empty.
  a.add("and the tests", isFinal: true)
  expect(a.running, "and the tests", "the next turn is not polluted by the last")

  // THE RACE. Finalizing is asynchronous. Somebody who keeps talking has words
  // finalized while the barrier is in flight, and a baseline computed on
  // completion swallows them — which is how "hello can you hear me" reached
  // Claude as ".".
  var b = TurnAssembler()
  b.add("first turn", isFinal: true)
  b.beginBarrier()
  b.add("second turn", isFinal: true)   // spoken during the await
  b.endBarrier()
  expect(b.running, "second turn", "speech during the barrier survives it")

  // Volatile text in flight at the barrier belongs to the turn being ended.
  var c = TurnAssembler()
  c.add("done now", isFinal: false)
  c.beginBarrier()
  c.add("done now", isFinal: true)      // finalizeTurn promotes it
  c.endBarrier()
  expect(c.running, "", "volatile text promoted by the barrier is consumed")

  // Finalizing may revise shorter than the volatile text it replaces; the
  // baseline must not run off the end.
  var d = TurnAssembler()
  d.add("a long guess", isFinal: false)
  d.beginBarrier()
  d.add("short", isFinal: true)
  d.endBarrier()
  expect(d.running, "", "a shorter revision does not push the baseline past the end")
  d.add("next", isFinal: true)
  expect(d.running, "next", "and the turn after it still works")

  if failures == 0 { print("  ✓ turn assembly") }
  return failures
}
