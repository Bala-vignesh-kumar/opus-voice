// swift/UtteranceBuffer.swift
// The audio of one spoken turn, kept so a better recognizer can have a second
// look at it.
//
// Apple's recognizer drives the interface — partials, barge-in, endpointing —
// and is good enough for all three. It is the text reaching Claude that suffers
// on an accent it was not tuned for, so that text, and only that text, is
// re-derived from this audio.
//
// A class rather than a struct: the microphone tap appends to it from an audio
// thread thousands of times a second, and copying an array that large per
// buffer is exactly the allocation churn a realtime callback must not do.

import Foundation

final class UtteranceBuffer {
  private let lock = NSLock()
  private var samples: [Float] = []
  private let maxSamples: Int
  private(set) var peak: Float = 0

  let sampleRate: Double

  init(sampleRate: Double = 16000, maxSeconds: Double = 30) {
    self.sampleRate = sampleRate
    self.maxSamples = Int(sampleRate * maxSeconds)
  }

  var seconds: Double {
    lock.lock(); defer { lock.unlock() }
    return Double(samples.count) / sampleRate
  }

  func append(_ incoming: [Float]) {
    lock.lock(); defer { lock.unlock() }
    samples.append(contentsOf: incoming)
    for value in incoming {
      let magnitude = abs(value)
      if magnitude > peak { peak = magnitude }
    }
    // Keep the end, not the start. The most recent audio is what was just said;
    // dropping it would truncate the turn rather than the silence before it.
    if samples.count > maxSamples {
      samples.removeFirst(samples.count - maxSamples)
    }
  }

  /// The turn's audio. Destructive: this audio belongs to one turn only, and
  /// leaving it behind would prepend the last turn to the next one.
  func take() -> [Float] {
    lock.lock(); defer { lock.unlock() }
    let out = samples
    samples = []
    peak = 0
    return out
  }

  /// Drops everything but the most recent `seconds`.
  ///
  /// Called when the recognizer first reports words, so the buffer holds the
  /// utterance rather than everything since the last turn. Continuous listening
  /// otherwise handed the second recognizer half a minute of room noise with a
  /// sentence buried in it, and it transcribed the noise too.
  ///
  /// The tail is kept rather than the head because speech begins slightly
  /// before the recognizer notices it; this is the pre-roll that keeps the
  /// first word.
  func trimToLast(seconds: Double) {
    lock.lock(); defer { lock.unlock() }
    let keep = Int(sampleRate * seconds)
    guard samples.count > keep else { return }
    samples.removeFirst(samples.count - keep)
    // Recompute, or peak keeps describing audio that is no longer here. The
    // two numbers disagreeing — a turn reported at peak 0.206 whose audio was
    // measurably silent — is what exposed this trim discarding the speech.
    peak = samples.reduce(0) { Swift.max($0, abs($1)) }
  }

  /// Cuts back to where the current run of speech began.
  ///
  /// A fixed window cannot win. Trimming to 1.5s cut the word itself off,
  /// because the recognizer reports its first partial well after the sound was
  /// made. Widening it to 10s handed the second recognizer ten seconds of the
  /// previous conversation, and it duly transcribed that instead — "I spoke a
  /// lot" came back as "Nice vocal note".
  ///
  /// So the cut follows the audio rather than the clock: walk back from the end
  /// while there is sound, stop at the first real silence, and keep a little
  /// lead-in so the first consonant survives.
  ///
  /// - Parameters:
  ///   - silence: how much quiet counts as the edge of an utterance.
  ///   - lead: kept before that edge, because speech begins before it is loud.
  ///   - floor: relative to this turn's own peak, so a quiet speaker and a loud
  ///     one are treated the same.
  func trimToSpeech(silence: Double = 0.6, lead: Double = 0.35, floor: Float = 0.08) {
    lock.lock(); defer { lock.unlock() }
    guard !samples.isEmpty else { return }

    let frame = max(1, Int(sampleRate * 0.02))          // 20ms
    let quietFrames = max(1, Int(silence / 0.02))
    let threshold = max(peak * floor, 0.004)

    // Frame energies, newest last.
    var loud: [Bool] = []
    loud.reserveCapacity(samples.count / frame + 1)
    var i = 0
    while i < samples.count {
      let end = Swift.min(i + frame, samples.count)
      var m: Float = 0
      for j in i..<end { m = Swift.max(m, abs(samples[j])) }
      loud.append(m >= threshold)
      i = end
    }

    // Walk back from the end through the speech, stopping at the first stretch
    // of quiet long enough to be a gap between utterances rather than a breath.
    var index = loud.count - 1
    while index >= 0, !loud[index] { index -= 1 }        // trailing silence
    guard index >= 0 else { return }                     // nothing but silence
    var run = 0
    while index >= 0 {
      run = loud[index] ? 0 : run + 1
      if run >= quietFrames { break }
      index -= 1
    }

    // index sits at the far side of the silence; the speech begins after it.
    // Cutting at index would keep the whole gap as well as the lead-in.
    let startFrame = Swift.max(0, index + run)
    var cut = startFrame * frame - Int(sampleRate * lead)
    cut = Swift.max(0, Swift.min(cut, samples.count))
    guard cut > 0 else { return }
    samples.removeFirst(cut)
    peak = samples.reduce(0) { Swift.max($0, abs($1)) }
  }

  func reset() {
    lock.lock(); defer { lock.unlock() }
    samples = []
    peak = 0
  }
}
