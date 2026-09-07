// Turning microphone audio into the 16 kHz Whisper is told it is getting.
//
// This used to be a stride: `round(rate / 16000)`, applied from index zero of
// every buffer. Two things were wrong with it, and both were invisible because
// the built-in microphone runs at 48 kHz, where the stride happens to be exact.
//
// The rate was only right at 48 kHz. At 44.1 kHz a stride of 3 produces 14700
// Hz, and at the 24 kHz a Bluetooth headset microphone offers, a stride of 2
// produces 12000 Hz. Both were then labelled 16000 in the endpoint event, so
// Whisper stretched every word — slower and lower than it was spoken — and its
// transcription got worse for reasons nothing in the app could explain.
//
// And the phase restarted every buffer. Taking index 0, 3, 6 … of each 1024
// frames means the gap across a buffer boundary is not the gap inside one, so
// the audio carried a discontinuity every 21 milliseconds.
//
// Hard rule 6 in CLAUDE.md is about exactly this class of mistake: hours spent
// judging a recognizer against a buffer nobody had looked at.

import Foundation

/// Resamples a stream to 16 kHz, keeping its position across buffers.
struct Downsampler {
  static let target: Double = 16000

  private(set) var inputRate: Double
  /// Where the next output sample falls, in input samples, carried between
  /// buffers. This is the whole point of the type: a fresh start every buffer
  /// is what put a seam in the audio.
  private var phase: Double = 0

  init(inputRate: Double) {
    self.inputRate = inputRate
  }

  /// Starts again at a new rate. The phase belonged to the old device.
  mutating func reset(inputRate: Double) {
    self.inputRate = inputRate
    phase = 0
  }

  mutating func resample(_ samples: [Float]) -> [Float] {
    guard !samples.isEmpty else { return [] }
    // Already at or below the target: handing back a resampled version of
    // something that needs no resampling only loses fidelity.
    guard inputRate > Self.target else { return samples }

    let step = inputRate / Self.target
    var out: [Float] = []
    out.reserveCapacity(Int(Double(samples.count) / step) + 1)

    var position = phase
    while position < Double(samples.count) {
      out.append(samples[Int(position)])
      position += step
    }
    // Whatever overshot the end of this buffer is where the next one begins.
    phase = position - Double(samples.count)
    return out
  }
}
