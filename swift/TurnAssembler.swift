// Assembling one spoken turn out of transcriber results.
//
// Results arrive as revisable "volatile" text followed by immutable finalized
// text, and finalized text accumulates for the life of the session. A turn is
// therefore everything finalized past a baseline, plus whatever is still
// volatile — and taking a turn means moving that baseline forward.
//
// Extracted from VoiceIO so the baseline arithmetic can be tested without an
// audio device. It is the part that was wrong, and it was wrong in a way no
// amount of reading it caught.

import Foundation

struct TurnAssembler {
  private(set) var finalized = ""
  private(set) var volatileText = ""
  private var base = 0
  /// How much text belonged to the turn being ended, recorded when the barrier
  /// was asked for rather than when it lands.
  private var pending: Int?

  /// The turn so far.
  var running: String { String(finalized.dropFirst(base)) + volatileText }

  /// Results are still describing the turn just handed off, so emitting them
  /// would repeat it.
  var awaitingBarrier: Bool { pending != nil }

  mutating func add(_ text: String, isFinal: Bool) {
    if isFinal {
      finalized += text
      volatileText = ""
    } else {
      volatileText = text
    }
  }

  /// Asks for a turn boundary, recording everything heard up to this instant.
  ///
  /// The recording is the whole point. Finalizing is asynchronous, and someone
  /// who keeps talking through it has their words finalized before it lands —
  /// so a baseline computed on completion swallows the start of what they just
  /// said. This one is computed on request and cannot.
  mutating func beginBarrier() {
    pending = finalized.count + volatileText.count
  }

  /// Moves the baseline past exactly the turn that was ended.
  ///
  /// Clamped to what actually exists, because finalizing may revise the
  /// promoted text shorter than the volatile text it replaced.
  mutating func endBarrier() {
    base = min(finalized.count, pending ?? base)
    volatileText = ""
    pending = nil
  }

  /// Everything so far is spoken for. Used when the session restarts.
  mutating func reset() {
    finalized = ""
    volatileText = ""
    base = 0
    pending = nil
  }
}
