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

  func reset() {
    lock.lock(); defer { lock.unlock() }
    samples = []
    peak = 0
  }
}
