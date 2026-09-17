// swift/EndpointTests.swift
import Foundation

func runEndpointTests() -> Int {
  var failures = 0
  func expect(_ actual: Bool, _ wanted: Bool, _ what: String) {
    if actual != wanted { print("  ✗ \(what)"); failures += 1 }
  }

  // The failure this file exists for: transcript stalled, speaker still going.
  expect(shouldEndTurn(sinceChangeMs: 3500, sinceLoudMs: 40, complete: false,
                       endpointMs: 3000, endpointFastMs: 800),
         false, "a stalled transcript does not end a turn while sound continues")

  // The fast path is the sharper edge: a full stop mid-sentence plus 800ms of
  // transcript quiet used to be enough. It is not, if the person is talking.
  expect(shouldEndTurn(sinceChangeMs: 900, sinceLoudMs: 100, complete: true,
                       endpointMs: 3000, endpointFastMs: 800),
         false, "a mid-sentence full stop does not end a turn while sound continues")

  // Both quiet: the turn is over.
  expect(shouldEndTurn(sinceChangeMs: 3200, sinceLoudMs: 3100, complete: false,
                       endpointMs: 3000, endpointFastMs: 800),
         true, "transcript and room both quiet ends the turn")
  expect(shouldEndTurn(sinceChangeMs: 900, sinceLoudMs: 850, complete: true,
                       endpointMs: 3000, endpointFastMs: 800),
         true, "a finished thought ends sooner once the room is quiet too")

  // Sound stopped but the recognizer is still catching up: wait for the words.
  expect(shouldEndTurn(sinceChangeMs: 200, sinceLoudMs: 3500, complete: false,
                       endpointMs: 3000, endpointFastMs: 800),
         false, "a transcript still arriving holds the turn open")

  // The quiet threshold follows the speaker, with a floor for the room.
  expect(quietThreshold(turnPeak: 0.5) == 0.04, true, "loud speaker: 8% of peak")
  expect(quietThreshold(turnPeak: 0.02) == 0.008, true, "quiet room: the floor holds")

  if failures == 0 { print("  ✓ end of turn") }
  return failures
}
