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

  // peak must describe the audio that is actually left. It reported 0.206 for
  // a turn whose kept audio peaked at 0.011, and that gap is what revealed the
  // trim was throwing the speech away.
  let g = UtteranceBuffer(sampleRate: 4, maxSeconds: 30)
  g.append([0.9, 0.9, 0.1, 0.1, 0.1, 0.1])
  g.trimToLast(seconds: 1.0)
  check(abs(g.peak - 0.1) < 0.0001, "peak follows the trim")

  // Cutting to where speech starts, not to a fixed window. A whole previous
  // utterance sat in front of the real one and got transcribed instead:
  // "I spoke a lot" came back as "Nice vocal note".
  let h = UtteranceBuffer(sampleRate: 100, maxSeconds: 30)
  var audio = [Float]()
  audio += Array(repeating: 0.9, count: 100)   // an older utterance, 1s
  audio += Array(repeating: 0.0, count: 200)   // 2s of quiet between them
  audio += Array(repeating: 0.8, count: 150)   // what was just said, 1.5s
  h.append(audio)
  h.trimToSpeech(silence: 0.6, lead: 0.3)
  let kept = h.take()
  // 1.5s of speech plus 0.3s of lead-in, and none of the older utterance.
  check(kept.count >= 150 && kept.count <= 200, "keeps the last utterance and its lead-in, got \(kept.count)")

  // Nothing but silence must not be mistaken for an utterance.
  let i2 = UtteranceBuffer(sampleRate: 100, maxSeconds: 30)
  i2.append(Array(repeating: 0.0, count: 300))
  i2.trimToSpeech()
  check(i2.take().count == 300, "silence alone is left untouched rather than cut to nothing")

  // One continuous utterance keeps all of itself.
  let j = UtteranceBuffer(sampleRate: 100, maxSeconds: 30)
  j.append(Array(repeating: 0.7, count: 250))
  j.trimToSpeech()
  check(j.take().count == 250, "a single unbroken utterance is kept whole")

  if failures == 0 { print("  ✓ utterance buffer") }
  return failures
}
