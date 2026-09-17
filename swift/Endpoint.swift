// swift/Endpoint.swift
// Whether a spoken turn has ended.
//
// Two witnesses, and both have to agree. The recognizer's transcript going
// quiet is the old test, and on its own it cut people off: on 16 Sep 2026 a
// 30-second buffer ended with the speaker still talking at full volume in its
// last frame — "discussing with you." — because the transcript had stalled
// (or gained a full stop mid-sentence, which is the fast path) while the sound
// had not stopped at all. An accent the recognizer was not tuned for makes it
// pause to reconsider, and a pause in the transcript is not a pause in speech.
//
// So the microphone gets a vote: the turn ends only when the transcript has
// been still for the threshold *and* nothing loud has been heard for as long.
// Pure, so it can be tested without an audio device.

import Foundation

/// - Parameters:
///   - sinceChangeMs: how long the transcript has been unchanged.
///   - sinceLoudMs: how long since the microphone last heard something loud.
///   - complete: the transcript ends like a finished thought (full stop).
///   - endpointMs: silence that ends a turn mid-sentence.
///   - endpointFastMs: silence that ends a turn after a finished thought.
func shouldEndTurn(sinceChangeMs: Double, sinceLoudMs: Double, complete: Bool,
                   endpointMs: Double, endpointFastMs: Double) -> Bool {
  let threshold = complete ? endpointFastMs : endpointMs
  guard sinceChangeMs > threshold else { return false }
  return sinceLoudMs > threshold
}

/// The loudness below which the room is quiet, relative to how loud this turn
/// has been so far, with a floor so a whisper-quiet room cannot keep a turn
/// open forever.
///
/// The floor is set from the same session's measurements: a speaker at
/// −20 dBFS rms, other people across the room at −45. 0.008 is −42 dBFS —
/// under the speaker by a wide margin, over the room by a small one.
func quietThreshold(turnPeak: Float) -> Float {
  return max(turnPeak * 0.08, 0.008)
}
