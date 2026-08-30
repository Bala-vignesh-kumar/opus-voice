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
      // A turn does not open with punctuation. The recognizer emits a bare "."
      // between utterances, and landing it in an empty turn put a full stop in
      // front of the next thing said — ". good." — which then reached Claude
      // as a sentence beginning with nothing.
      //
      // Only at the front: punctuation inside a turn is the recognizer doing
      // its job, and stripping that would run words together.
      if finalized.isEmpty, !isSpeech(text) { return }
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

  /// Ends the turn by clearing it, rather than stepping a baseline past it.
  ///
  /// The baseline was clamped so it could not overrun, which meant that when
  /// finalizing revised the text *longer* than it was when the mark was taken —
  /// punctuation added, a word corrected — the baseline stopped short and the
  /// tail of the finished turn survived into the next one. It showed up as
  /// turns beginning ",.., " and "in... ": a few unconsumed characters wearing
  /// the next sentence.
  ///
  /// Clearing cannot leave a remainder, because there is no arithmetic to get
  /// wrong. Volatile text is deliberately kept: it has not been finalized, so
  /// it is words arriving now rather than the turn just ended — which is what
  /// stops this reintroducing the race where speech during the barrier was
  /// swallowed.
  mutating func endBarrier() {
    finalized = ""
    base = 0
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
