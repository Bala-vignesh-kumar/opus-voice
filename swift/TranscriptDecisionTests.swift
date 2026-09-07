// swift/TranscriptDecisionTests.swift
// What to do with a recognizer result, which is a pure decision and so can be
// tested without a recognizer.

import Foundation

func runTranscriptDecisionTests() -> Int {
  var failures = 0

  func expect(_ actual: TranscriptDecision, _ wanted: TranscriptDecision, _ what: String) {
    if actual != wanted {
      print("  ✗ \(what): got \(actual), wanted \(wanted)")
      failures += 1
    }
  }

  // The ordinary case: new words, nobody is speaking, so they are the turn.
  expect(transcriptDecision(trimmed: "hello there", partial: "hello",
                            speaking: false, isSelfEcho: false, bargeInWords: 2),
         .accept(startingTurn: false), "new words are accepted")

  // First words of a turn. The caller trims the capture buffer on this, so it
  // has to be distinguishable from a continuation.
  expect(transcriptDecision(trimmed: "hello", partial: "",
                            speaking: false, isSelfEcho: false, bargeInWords: 2),
         .accept(startingTurn: true), "the first words start a turn")

  // The recognizer repeats itself constantly. A result identical to what is
  // already held is not news.
  expect(transcriptDecision(trimmed: "hello", partial: "hello",
                            speaking: false, isSelfEcho: false, bargeInWords: 2),
         .ignore, "a repeat is ignored")

  // The bug this file exists for. `return` inside the state closure exited only
  // the closure, so a rejected self-echo carried on to be emitted as a partial
  // whenever something was already held.
  expect(transcriptDecision(trimmed: "going back to sleep", partial: "earlier words",
                            speaking: true, isSelfEcho: true, bargeInWords: 2),
         .ignore, "its own voice is ignored, not emitted")

  // Same rejection at the start of a turn, which happened to behave correctly
  // before only because the empty-partial guard caught it afterwards.
  expect(transcriptDecision(trimmed: "going back to sleep", partial: "",
                            speaking: true, isSelfEcho: true, bargeInWords: 2),
         .ignore, "its own voice is ignored at the start of a turn too")

  // Enough words while it is talking means the person is talking over it.
  expect(transcriptDecision(trimmed: "no wait", partial: "",
                            speaking: true, isSelfEcho: false, bargeInWords: 2),
         .interrupt(startingTurn: true), "two words interrupt")

  // One stray word is a cough, a door, or the tail of its own sentence. It must
  // not stop the answer.
  expect(transcriptDecision(trimmed: "no", partial: "",
                            speaking: true, isSelfEcho: false, bargeInWords: 2),
         .accept(startingTurn: true), "one word is not an interruption")

  // Barge-in only applies while it is speaking. The same words in silence are
  // an ordinary turn.
  expect(transcriptDecision(trimmed: "no wait", partial: "",
                            speaking: false, isSelfEcho: false, bargeInWords: 2),
         .accept(startingTurn: true), "words in silence do not interrupt")

  // A self-echo is checked before barge-in: hearing its own answer back must
  // never be what stops it talking.
  expect(transcriptDecision(trimmed: "notes saved it was about the redis lock",
                            partial: "", speaking: true, isSelfEcho: true, bargeInWords: 2),
         .ignore, "it does not interrupt itself")

  if failures == 0 { print("  ✓ transcript decisions") }
  return failures
}
