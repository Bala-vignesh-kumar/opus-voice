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

  // THE RACE. Finalizing is asynchronous, so somebody who keeps talking has
  // words arriving while the barrier is in flight. They arrive volatile first —
  // finalizing is what the barrier is waiting on — and volatile text is kept
  // precisely so those words are not swallowed.
  var b = TurnAssembler()
  b.add("first turn", isFinal: true)
  b.beginBarrier()
  b.add("second turn", isFinal: false)   // spoken during the await
  b.endBarrier()
  expect(b.running, "second turn", "speech during the barrier survives it")

  // THE DEBRIS. Finalizing can revise the turn longer than it was when the
  // barrier was asked for — punctuation added, a word corrected. A baseline
  // stepped forward by a remembered count then stops short, and the tail of the
  // finished turn wears the next one: ",.., check in the code."
  var e = TurnAssembler()
  e.add("check", isFinal: false)
  e.beginBarrier()
  e.add("check in the code.", isFinal: true)   // longer than the mark
  e.endBarrier()
  expect(e.running, "", "a turn revised longer still leaves nothing behind")
  e.add("and the tests", isFinal: true)
  expect(e.running, "and the tests", "so the next turn starts clean")

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
