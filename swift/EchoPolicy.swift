// Whether echo cancellation may actually be turned on.
//
// This exists because one config key has silently killed the headphone squeeze
// five separate times, and each time it was diagnosed from scratch.
//
// The mechanism, once, so nobody has to find it again. Echo cancellation means
// `setVoiceProcessingEnabled(true)`, which is a *duplex* audio unit: it takes
// the microphone as well as the speaker. A duplex path drags AirPods out of
// A2DP into SCO, the narrowband hands-free call mode. In SCO a stem pinch means
// "end call" — the bud emits no AVRCP media command at all, so nothing reaches
// macOS and nothing can reach this app. The squeeze does not fail; it never
// happens. Keepalive.swift is built the way it is to avoid exactly this, and a
// config key was reintroducing it from the other end.
//
// It is refused rather than warned about because on headphones the setting buys
// nothing anyway: echo cancellation earns its keep when the answer plays out of
// a speaker the microphone can hear, and buds in your ears are not that. It
// also costs recognition — the voice processing unit is tuned for telephony,
// its noise suppressor takes consonants with it and its gain control pumps,
// which is why Dictation was clearer than this app on the same microphone.
//
// So: turning it on with headphones is all cost and no benefit, and the cost is
// the feature people notice most.

import Foundation

struct EchoDecision {
  let enable: Bool
  /// Said out loud when the request was refused. nil when there is nothing to
  /// explain.
  let warning: String?
}

/// - Parameters:
///   - requested: the `echoCancellation` setting from config.json.
///   - outputIsBluetoothHeadset: where the answer is being played.
func echoDecision(requested: Bool, outputIsBluetoothHeadset: Bool) -> EchoDecision {
  guard requested else { return EchoDecision(enable: false, warning: nil) }
  guard outputIsBluetoothHeadset else { return EchoDecision(enable: true, warning: nil) }

  return EchoDecision(
    enable: false,
    warning: """
      echo cancellation is off: it was asked for, but the answer is playing \
      through bluetooth headphones — it opens a duplex audio path, which puts them in call mode, \
      and in call mode a squeeze is "end call" rather than play/pause, so the \
      squeeze stops working entirely. It buys nothing here either: there is no \
      acoustic path from buds in your ears back to the microphone. Set \
      echoCancellation to false to silence this, or use it with laptop speakers, \
      which is what it is for.
      """
  )
}
