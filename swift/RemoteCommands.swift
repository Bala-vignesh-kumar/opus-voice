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

/// The gesture an AVRCP command represents, or nil if it is one we listen for
/// but do not bind.
///
/// Kept as a mapping rather than a switch inside the handler so it can be
/// tested: everything else in this file needs a Bluetooth stack and the Now
/// Playing role to exercise at all.
func gesture(forCommand name: String) -> WakeGesture? {
  switch name {
  case "toggle", "play", "pause": return .playPause
  case "next": return .next
  case "previous": return .previous
  default: return nil
  }
}

final class RemoteCommandWatcher {
  /// The gesture this watcher answers to. Named apart from the free function
  /// above so the two do not shadow each other inside the class.
  private let boundGesture: WakeGesture
  private let forwardToPlayer: Bool
  /// What a squeeze means. This class recognises the gesture and nothing more —
  /// deciding what to do about it belongs to whoever is listening, which is
  /// also what makes the recognition above testable.
  private let onWake: () -> Void
  private let onLog: (String) -> Void
  private var claimed = false

  init(gesture: WakeGesture,
       forwardToPlayer: Bool,
       onWake: @escaping () -> Void,
       onLog: @escaping (String) -> Void) {
    self.boundGesture = gesture
    self.forwardToPlayer = forwardToPlayer
    self.onWake = onWake
    self.onLog = onLog
  }

  func start() {
    let center = MPRemoteCommandCenter.shared()

    register(center.togglePlayPauseCommand, named: "toggle")
    register(center.playCommand, named: "play")
    register(center.pauseCommand, named: "pause")
    register(center.nextTrackCommand, named: "next")
    register(center.previousTrackCommand, named: "previous")

    claim()
    onLog("headphone wake: listening for \(boundGesture.rawValue)")
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

  private func register(_ command: MPRemoteCommand, named: String) {
    command.isEnabled = true
    command.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      // Every command is logged, not just the bound one, because which squeeze
      // sends which command differs by model and by the settings in Bluetooth.
      self.onLog("headphone command: \(named)")
      if gesture(forCommand: named) == self.boundGesture {
        self.onWake()
      }
      if self.forwardToPlayer {
        self.forward(named)
      }
      return .success
    }
  }

  /// Claims Now Playing. There is no way to receive these commands without it —
  /// the system delivers them to one app, and this is how an app volunteers.
  private func claim() {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: "Falcon",
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
    for player in ["Spotify", "Music"] {
      let script = "tell application \"\(player)\" to if it is running then \(action)"
      guard let apple = NSAppleScript(source: script) else { continue }
      var error: NSDictionary?
      apple.executeAndReturnError(&error)
      if error == nil { return }
    }
  }
}
