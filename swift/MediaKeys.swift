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
import IOKit.hid

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
  /// Keystrokes, logged while verbose. Purely a control: without it, "no media
  /// key events" cannot be told apart from "nobody pressed anything", and the
  /// last three hours went into exactly that confusion.
  private var control: Any?
  private let binding: Int
  private let onLog: (String) -> Void
  /// Logs every systemDefined event, not just media keys. On while we work out
  /// what these headphones actually send.
  var verbose = true

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

  /// Whether the app may observe events at all.
  ///
  /// Input Monitoring, not Accessibility. They are different TCC services and
  /// granting the wrong one changes nothing: a global monitor installs happily
  /// under either and only delivers events under this one, which is
  /// indistinguishable from headphones that do not work.
  static var permitted: Bool {
    IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
  }

  /// Asks for it, and opens the pane. Only ever called from a menu item,
  /// because a permission dialog nobody asked for is how apps get distrusted.
  static func requestPermission() {
    _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    if let pane = URL(string:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent") {
      NSWorkspace.shared.open(pane)
    }
  }

  func start() {
    stop()
    // Said out loud at startup: a denied permission makes the monitor install
    // happily and then never fire, which is indistinguishable from broken
    // headphones unless somebody writes down which one it was.
    onLog(MediaKeyWatcher.permitted
      ? "media keys: Input Monitoring granted, watching"
      : "media keys: NOT PERMITTED — grant Input Monitoring (not Accessibility), then restart")
    monitor = NSEvent.addGlobalMonitorForEvents(matching: .systemDefined) { [weak self] event in
      guard let self else { return }

      // Every systemDefined event, not just the aux-control ones. Whether any
      // arrive at all is what separates "the permission is missing" from "these
      // headphones do not use this event path", and those need opposite fixes.
      if self.verbose {
        self.onLog("systemDefined: subtype=\(event.subtype.rawValue) data1=\(event.data1)")
      }

      guard let press = decodeMediaKey(subtype: Int(event.subtype.rawValue), data1: event.data1)
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

    if verbose {
      var keys = 0
      control = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] _ in
        keys += 1
        // Only the first few: this is proof of life, not a keylogger. No key
        // codes are recorded, just that the stream is delivering at all.
        if keys <= 3 { self?.onLog("control: keyboard events are being delivered") }
      }
    }
  }

  func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    if let control { NSEvent.removeMonitor(control) }
    control = nil
  }

  private func poke() {
    // Contents as well as timestamp, for the same reason the Shortcut's hook
    // writes $RANDOM: a timestamp alone can land inside one filesystem tick.
    let stamp = "\(Date().timeIntervalSince1970)\n"
    try? stamp.write(to: wakeFile, atomically: true, encoding: .utf8)
    onLog("woke by media key")
  }
}
