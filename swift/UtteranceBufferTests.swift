// swift/UtteranceBufferTests.swift
import Foundation

func runUtteranceBufferTests() -> Int {
  var failures = 0
  func check(_ c: Bool, _ what: String) { if !c { print("  ✗ \(what)"); failures += 1 } }

  let b = UtteranceBuffer(sampleRate: 16000, maxSeconds: 1.0)
  check(b.take().isEmpty, "a fresh buffer holds nothing")

  b.append([0.1, 0.2, 0.3])
  check(b.take().count == 3, "appended samples come back")

  // take() is destructive: a turn's audio belongs to that turn only.
  check(b.take().isEmpty, "taking empties it")

  // The cap exists so a forgotten open microphone cannot grow without limit.
  let over = [Float](repeating: 0.5, count: 16000 * 2)   // 2s into a 1s cap
  b.append(over)
  check(b.seconds <= 1.0 + 0.001, "the buffer is capped at maxSeconds")
  check(b.take().count == 16000, "the cap keeps exactly maxSeconds of samples")

  // Capping keeps the END, not the start: the most recent second of speech is
  // the part somebody actually said, and dropping it would truncate the turn.
  let c = UtteranceBuffer(sampleRate: 4, maxSeconds: 1.0)
  c.append([1, 2, 3, 4, 5, 6])
  check(c.take() == [3, 4, 5, 6], "the cap drops the oldest samples")

  // peak drives the energy floor that keeps Whisper from hallucinating on
  // silence, so it has to survive until the audio is taken.
  let d = UtteranceBuffer(sampleRate: 16000, maxSeconds: 30)
  d.append([0.0, -0.4, 0.2])
  check(abs(d.peak - 0.4) < 0.0001, "peak is the largest magnitude seen")
  _ = d.take()
  check(d.peak == 0, "peak resets with the buffer")

  // A turn is the utterance, not everything heard since the last one. Without
  // this the second recognizer got 27s of room noise with a sentence in it and
  // dutifully transcribed the noise as well.
  let e = UtteranceBuffer(sampleRate: 4, maxSeconds: 30)
  e.append([1, 2, 3, 4, 5, 6, 7, 8])
  e.trimToLast(seconds: 1.0)
  check(e.take() == [5, 6, 7, 8], "trimming keeps the most recent second")

  // The tail, because speech starts before the recognizer reports it — this is
  // the pre-roll that keeps the first word of the turn.
  let f = UtteranceBuffer(sampleRate: 4, maxSeconds: 30)
  f.append([1, 2])
  f.trimToLast(seconds: 5.0)
  check(f.take() == [1, 2], "trimming to more than exists keeps everything")

  if failures == 0 { print("  ✓ utterance buffer") }
  return failures
}
