// Waking by a button on the headphones.
//
// AirPods do their own gesture detection and send an ordinary media key: one
// squeeze is play/pause, two is next, three is previous. So there is nothing
// here about presses or timing — the hardware has already decided, and this
// just has to notice which key arrived.
//
// Observed, never consumed. A global monitor cannot swallow the event, which is
// deliberate: intercepting next-track would leave the media keys broken for
// everything else on the machine, and a wake feature is not worth that. When
// nothing is playing, next-track does nothing anyway, so in the ordinary case
// the squeeze only wakes this.
//
// It wakes by touching the same file the Siri Shortcut touches. One wake path,
// already proven, and node does not have to know this exists.

import AppKit

// NX_KEYTYPE_* from IOKit's hidsystem headers, which are not exposed to Swift.
let MEDIA_KEY_PLAY = 16
let MEDIA_KEY_NEXT = 17
let MEDIA_KEY_PREVIOUS = 18
let MEDIA_KEY_FAST = 19
let MEDIA_KEY_REWIND = 20

/// The aux-control subtype. Everything else on the systemDefined stream belongs
/// to somebody else.
private let AUX_CONTROL_SUBTYPE = 8

/// A media key press or release, decoded out of an NSEvent's packed data1.
struct MediaKeyPress {
  let keyCode: Int
  let isDown: Bool
}

/// Unpacks data1: key code in the high 16 bits, key state in bits 8-15 of the
/// low half, where 0xA means down and 0xB means up.
func decodeMediaKey(subtype: Int, data1: Int) -> MediaKeyPress? {
  guard subtype == AUX_CONTROL_SUBTYPE else { return nil }
  let keyCode = (data1 & 0xFFFF_0000) >> 16
  let keyState = (data1 & 0x0000_FF00) >> 8
  guard keyState == 0xA || keyState == 0xB else { return nil }
  return MediaKeyPress(keyCode: keyCode, isDown: keyState == 0xA)
}

/// Press only. Waking on the release as well would wake twice per squeeze.
func isWakeKey(keyCode: Int, isDown: Bool, binding: Int) -> Bool {
  isDown && keyCode == binding
}

/// For the log, which is what a person reads to decide what to bind.
func mediaKeyName(_ code: Int) -> String {
  switch code {
  case MEDIA_KEY_PLAY: return "play/pause"
  case MEDIA_KEY_NEXT: return "next"
  case MEDIA_KEY_PREVIOUS: return "previous"
  case MEDIA_KEY_FAST: return "fast-forward"
  case MEDIA_KEY_REWIND: return "rewind"
  default: return "unknown (\(code))"
  }
}

/// Watches for the bound media key and pokes the wake file when it arrives.
final class MediaKeyWatcher {
  private var monitor: Any?
  private let binding: Int
  private let onLog: (String) -> Void

  /// Where the Siri Shortcut also writes. Reusing it means there is one way in
  /// from outside the app, and it is the one already known to work.
  private var wakeFile: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".opus-voice/wake")
  }

  init(binding: Int = MEDIA_KEY_NEXT, onLog: @escaping (String) -> Void) {
    self.binding = binding
    self.onLog = onLog
  }

  /// Whether the app may observe events at all. Without this the monitor
  /// installs happily and then never fires, which looks exactly like the
  /// headphones not working.
  static var permitted: Bool { AXIsProcessTrusted() }

  /// Shows the system prompt. Only ever called from a menu item, because a
  /// permission dialog nobody asked for is how apps get distrusted.
  static func requestPermission() {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
  }

  func start() {
    stop()
    monitor = NSEvent.addGlobalMonitorForEvents(matching: .systemDefined) { [weak self] event in
      guard
        let self,
        let press = decodeMediaKey(subtype: Int(event.subtype.rawValue), data1: event.data1)
      else { return }

      // Every media key is logged, not just the bound one. Which key a given
      // pair of headphones actually sends is a question only the hardware can
      // answer, and this is how it gets answered.
      if press.isDown {
        self.onLog("media key: \(mediaKeyName(press.keyCode)) [\(press.keyCode)]")
      }

      if isWakeKey(keyCode: press.keyCode, isDown: press.isDown, binding: self.binding) {
        self.poke()
      }
    }
  }

  func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
  }

  private func poke() {
    // Contents as well as timestamp, for the same reason the Shortcut's hook
    // writes $RANDOM: a timestamp alone can land inside one filesystem tick.
    let stamp = "\(Date().timeIntervalSince1970)\n"
    try? stamp.write(to: wakeFile, atomically: true, encoding: .utf8)
    onLog("woke by media key")
  }
}
