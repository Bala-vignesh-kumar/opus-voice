// What to do with a result from the recognizer.
//
// Pulled out of `handleTranscript` because the decision was being made inside a
// `state.sync { }` closure and communicated by `return` — which returns from the
// closure, not from the function around it. Execution carried straight on to
// the emit below it, so a result the closure had just rejected as this app's own
// voice was still published as an accepted partial whenever anything was
// already held. Node's EchoGuard caught it downstream, which is the only reason
// it never looked broken.
//
// A decision that is a value cannot be ignored by the code that asked for it.

import Foundation

enum TranscriptDecision: Equatable {
  /// A repeat, or this app hearing itself. Publish nothing.
  case ignore
  /// Ordinary speech. `startingTurn` means the capture buffer should be trimmed:
  /// everything before now is whatever the room was doing.
  case accept(startingTurn: Bool)
  /// Speech over the top of an answer. Accept it, and stop talking.
  case interrupt(startingTurn: Bool)
}

/// - Parameters:
///   - trimmed: the recognizer's text, already trimmed and known to be speech
///   - partial: what is currently held for this turn
///   - speaking: whether an answer is playing right now
///   - isSelfEcho: whether `trimmed` is contained in what is being said
///   - bargeInWords: words needed to count as an interruption
func transcriptDecision(
  trimmed: String,
  partial: String,
  speaking: Bool,
  isSelfEcho: Bool,
  bargeInWords: Int
) -> TranscriptDecision {
  // The recognizer repeats itself constantly; an identical result is not news.
  if trimmed == partial { return .ignore }

  // Second line of defence behind echo cancellation. Checked before barge-in on
  // purpose: hearing its own answer back must never be the thing that stops it.
  if speaking, isSelfEcho { return .ignore }

  let startingTurn = partial.isEmpty

  // One stray word while it is talking is a cough, a door, or the tail of its
  // own sentence. Two is somebody actually talking over it.
  if speaking, trimmed.split(separator: " ").count >= bargeInWords {
    return .interrupt(startingTurn: startingTurn)
  }
  return .accept(startingTurn: startingTurn)
}
