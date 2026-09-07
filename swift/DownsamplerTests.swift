// swift/DownsamplerTests.swift
// The decimation that feeds Whisper, which is arithmetic and so can be tested
// without a microphone.

import Foundation

func runDownsamplerTests() -> Int {
  var failures = 0

  func check(_ condition: Bool, _ what: String) {
    if !condition {
      print("  ✗ \(what)")
      failures += 1
    }
  }

  /// A ramp, so a sample's value says where in the stream it came from.
  func ramp(_ count: Int, from start: Float = 0) -> [Float] {
    (0..<count).map { start + Float($0) }
  }

  // 48k is the built-in microphone and the case that already worked: exactly
  // three input samples per output one.
  var at48 = Downsampler(inputRate: 48000)
  let out48 = at48.resample(ramp(4800))
  check(abs(out48.count - 1600) <= 1, "48k decimates to 16k, got \(out48.count) not ~1600")

  // The bug. A stride of round(44100/16000) = 3 gives 14700 Hz, which was then
  // labelled 16000 and handed to Whisper — every word 8% too slow and too low.
  var at44 = Downsampler(inputRate: 44100)
  let out44 = at44.resample(ramp(44100))
  check(abs(out44.count - 16000) <= 2, "44.1k resamples to 16k, got \(out44.count) not ~16000")

  // 24k is what a Bluetooth headset microphone offers. round(24000/16000) = 2
  // gave 12000 Hz: a third of the speed, still labelled 16000.
  var at24 = Downsampler(inputRate: 24000)
  let out24 = at24.resample(ramp(24000))
  check(abs(out24.count - 16000) <= 2, "24k resamples to 16k, got \(out24.count) not ~16000")

  // The second half of the bug, and the one a stride cannot fix. Decimation
  // restarted at index 0 for every 1024-frame buffer, so the interval across a
  // buffer boundary was shorter than the interval inside one. Whisper was fed
  // audio with a stutter every 21ms.
  var whole = Downsampler(inputRate: 48000)
  let inOneGo = whole.resample(ramp(3072))

  var split = Downsampler(inputRate: 48000)
  var piecemeal: [Float] = []
  piecemeal += split.resample(ramp(1024, from: 0))
  piecemeal += split.resample(ramp(1024, from: 1024))
  piecemeal += split.resample(ramp(1024, from: 2048))

  check(inOneGo == piecemeal,
        "buffer boundaries change the audio: \(inOneGo.prefix(6)) vs \(piecemeal.prefix(6))")

  // An input already at the target rate is passed through untouched rather than
  // resampled into a slightly different version of itself.
  var already = Downsampler(inputRate: 16000)
  check(already.resample(ramp(100)) == ramp(100), "16k in is 16k out, unchanged")

  // Empty buffers happen when a device is starting up. They must not throw off
  // the phase for the buffers after them.
  var withGaps = Downsampler(inputRate: 48000)
  _ = withGaps.resample([])
  check(withGaps.resample(ramp(3)) == [0], "an empty buffer is not a hiccup")

  // Changing device mid-session means a new rate. The phase belongs to the old
  // stream and carrying it over would misalign the first buffer of the new one.
  var swapped = Downsampler(inputRate: 48000)
  _ = swapped.resample(ramp(1000))
  swapped.reset(inputRate: 44100)
  check(swapped.inputRate == 44100, "a device change is accepted")

  if failures == 0 { print("  ✓ sixteen kilohertz resampling") }
  return failures
}
