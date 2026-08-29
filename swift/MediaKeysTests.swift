import Foundation

// Decoding a system-defined event is bit manipulation against a layout that is
// easy to get subtly wrong and impossible to eyeball. These pin it down without
// needing AirPods, a permission grant, or a run loop.
func runMediaKeysTests() -> Int {
  var failures = 0

  func check(_ condition: Bool, _ what: String) {
    if !condition {
      print("  ✗ \(what)")
      failures += 1
    }
  }

  /// data1 packs the key code in the high 16 bits, and the state in bits 8-15
  /// of the low half: 0xA is down, 0xB is up.
  func data1(code: Int, down: Bool) -> Int {
    (code << 16) | ((down ? 0xA : 0xB) << 8)
  }

  // Only the aux-control subtype carries media keys. Everything else on the
  // systemDefined stream is somebody else's business.
  check(decodeMediaKey(subtype: 7, data1: data1(code: MEDIA_KEY_NEXT, down: true)) == nil,
        "a non-aux subtype decodes to nothing")

  guard let next = decodeMediaKey(subtype: 8, data1: data1(code: MEDIA_KEY_NEXT, down: true)) else {
    print("  ✗ a next-track press must decode")
    return failures + 1
  }
  check(next.keyCode == MEDIA_KEY_NEXT, "the key code is read from the high half")
  check(next.isDown, "a press is a press")

  guard let release = decodeMediaKey(subtype: 8, data1: data1(code: MEDIA_KEY_NEXT, down: false)) else {
    print("  ✗ a release must decode")
    return failures + 1
  }
  check(!release.isDown, "a release is not a press")

  // Waking on both press and release would wake twice per squeeze.
  check(isWakeKey(keyCode: MEDIA_KEY_NEXT, isDown: true, binding: MEDIA_KEY_NEXT),
        "the bound key on press wakes")
  check(!isWakeKey(keyCode: MEDIA_KEY_NEXT, isDown: false, binding: MEDIA_KEY_NEXT),
        "the bound key on release does not wake again")
  check(!isWakeKey(keyCode: MEDIA_KEY_PLAY, isDown: true, binding: MEDIA_KEY_NEXT),
        "an unbound key does not wake")

  // The log has to be readable by a person deciding what to bind, which is the
  // entire point of watching before binding.
  check(mediaKeyName(MEDIA_KEY_PLAY) == "play/pause", "play is named")
  check(mediaKeyName(MEDIA_KEY_NEXT) == "next", "next is named")
  check(mediaKeyName(MEDIA_KEY_PREVIOUS) == "previous", "previous is named")
  check(mediaKeyName(99).contains("99"), "an unknown code still names its number")

  if failures == 0 { print("  ✓ media key decoding") }
  return failures
}
