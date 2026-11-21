// Waking by squeezing the headphones.
//
// AirPods do not emit HID media keys. A stem squeeze is an AVRCP command sent
// over Bluetooth, which macOS routes to whichever app owns the Now Playing
// role — which is why the squeeze reached Spotify instantly while a global
// NSEvent monitor, with every permission granted, saw nothing at all. Measured,
// not guessed: the HID path logged 0 events across three sessions while this
// one logged every squeeze.
//
// The cost is inherent to how the system works. Commands go to exactly one app,
// so receiving them means taking the Now Playing role from whatever had it.
// `forwardToPlayer` hands the command onward afterwards so music still
// responds, at the price of being specific to the players it knows.

import AppKit
import MediaPlayer

/// Which squeeze wakes it. The names are what a person says, not AVRCP verbs.
enum WakeGesture: String {
  case playPause          // one squeeze
  case next               // two squeezes
  case previous           // three squeezes

  static func named(_ raw: String?) -> WakeGesture {
    WakeGesture(rawValue: raw ?? "") ?? .playPause
  }
}

final class RemoteCommandWatcher {
  private let gesture: WakeGesture
  private let forwardToPlayer: Bool
  private let onLog: (String) -> Void
  private var claimed = false

  private var wakeFile: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".opus-voice/wake")
  }

  init(gesture: WakeGesture, forwardToPlayer: Bool, onLog: @escaping (String) -> Void) {
    self.gesture = gesture
    self.forwardToPlayer = forwardToPlayer
    self.onLog = onLog
  }

  func start() {
    let center = MPRemoteCommandCenter.shared()

    register(center.togglePlayPauseCommand, as: .playPause, named: "toggle")
    register(center.playCommand, as: .playPause, named: "play")
    register(center.pauseCommand, as: .playPause, named: "pause")
    register(center.nextTrackCommand, as: .next, named: "next")
    register(center.previousTrackCommand, as: .previous, named: "previous")

    claim()
    onLog("headphone wake: listening for \(gesture.rawValue)")
  }

  func stop() {
    let center = MPRemoteCommandCenter.shared()
    for command in [
      center.togglePlayPauseCommand, center.playCommand, center.pauseCommand,
      center.nextTrackCommand, center.previousTrackCommand,
    ] {
      command.removeTarget(nil)
      command.isEnabled = false
    }
    // Handing the role back matters: leaving it held would keep the headphones
    // pointed at a process that has quit.
    MPNowPlayingInfoCenter.default().playbackState = .stopped
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    claimed = false
  }

  private func register(_ command: MPRemoteCommand, as gesture: WakeGesture, named: String) {
    command.isEnabled = true
    command.addTarget { [weak self] _ in
      guard self != nil else { return .commandFailed }
      // Answer MediaPlayer first and do the work on the next turn of the main
      // loop. Running it inside the handler crashed the app on an AirPods
      // squeeze: forward() runs a synchronous AppleScript, which spins a nested
      // run loop (and can sit on an Automation prompt) while MediaPlayer's
      // dispatch is still open, and any Objective-C exception raised in here
      // unwinds through MediaPlayer, leaving the dispatch unanswered so it
      // aborts the process when it is freed.
      DispatchQueue.main.async { [weak self] in
        self?.handle(named, as: gesture)
      }
      return .success
    }
  }

  private func handle(_ named: String, as gesture: WakeGesture) {
    // Every command is logged, not just the bound one, because which squeeze
    // sends which command differs by model and by the settings in Bluetooth.
    onLog("headphone command: \(named)")
    if gesture == self.gesture {
      poke()
    }
    if forwardToPlayer {
      forward(named)
    }
  }

  /// Claims Now Playing. There is no way to receive these commands without it —
  /// the system delivers them to one app, and this is how an app volunteers.
  private func claim() {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: "opus voice",
      MPMediaItemPropertyArtist: "say hey falcon",
      MPNowPlayingInfoPropertyPlaybackRate: 1.0,
    ]
    MPNowPlayingInfoCenter.default().playbackState = .playing
    claimed = true
  }

  /// Passes the command to a running player, so taking the Now Playing role
  /// does not mean losing control of the music. Scripted rather than routed
  /// because the system has already decided this app is the destination.
  private func forward(_ command: String) {
    let action: String
    switch command {
    case "next": action = "next track"
    case "previous": action = "previous track"
    default: action = "playpause"
    }
    // Checked with NSWorkspace before any AppleScript is built. Compiling
    // `tell application "Spotify"` when Spotify is not installed does not fail:
    // it opens a modal "Where is Spotify?" chooser and blocks until someone
    // answers it, so every squeeze on a machine without Spotify hung the app
    // (and, inside MediaPlayer's handler, crashed it). The "if it is running"
    // guard inside the script came too late to help, because the chooser is
    // raised at compile time.
    for bundleID in ["com.spotify.client", "com.apple.Music"]
    where !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty {
      let script = "tell application id \"\(bundleID)\" to \(action)"
      guard let apple = NSAppleScript(source: script) else { continue }
      var error: NSDictionary?
      apple.executeAndReturnError(&error)
      if error == nil { return }
    }
  }

  private func poke() {
    let stamp = "\(Date().timeIntervalSince1970)\n"
    try? stamp.write(to: wakeFile, atomically: true, encoding: .utf8)
    onLog("woke by headphone squeeze")
  }
}
