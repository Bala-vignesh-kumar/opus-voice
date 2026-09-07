// A silent audio stream, held open so the headphones have something to control.
//
// AirPods only emit a play/pause command when there is an audio stream running.
// The system Bluetooth log calls this `AStS`: with no stream it reads `Idle`,
// and a squeeze in that state dies at the bud — no media command is sent, so no
// app can receive one. Measured on this machine: hundreds of `AStS Idle`
// samples and not one squeeze delivered; with a stream open, `AStS A2DP` and
// every squeeze arrived.
//
// AVAudioPlayer rather than AVAudioEngine, and that is the whole design.
// AVAudioEngine opens a duplex I/O unit — it takes the input as well as the
// output — which puts the AirPods into SCO, the narrowband call mode. In SCO a
// single press means "end call", not play/pause, so an engine-based keepalive
// defeats the exact thing it exists to enable. It was also audible. This plays
// out and only out.

import AVFoundation

final class Keepalive {
    private var player: AVAudioPlayer?

    /// Said out loud when the stream cannot be held open.
    ///
    /// Every failure here used to return silently, which made this the one part
    /// of the squeeze with no evidence at all: no stream means the bud never
    /// emits a media command, so the symptom is an app that is listening
    /// perfectly and never hears a squeeze — indistinguishable from three other
    /// causes. Whether it is running is now a fact rather than an assumption.
    var onProblem: ((String) -> Void)?

    /// Said out loud when it *can* be held open — deliberately not `onProblem`.
    ///
    /// A warning stream that fires on success is a warning stream you stop
    /// reading, and this one has to stay worth reading: `restart()` runs on
    /// every route change, so it speaks whenever headphones come or go.
    var onNote: ((String) -> Void)?

    /// A one-second 8 kHz mono WAV of pure zeroes, built in memory so there is
    /// no asset to ship, find at runtime, or get wrong in a bundle.
    private static func silentWAV(seconds: Int = 1) -> Data {
        let rate = 8000, bits = 16, channels = 1
        let samples = rate * seconds
        let dataBytes = samples * channels * bits / 8
        var wav = Data()
        func le(_ value: Int, _ width: Int) {
            for i in 0..<width { wav.append(UInt8((value >> (8 * i)) & 0xFF)) }
        }
        wav.append(contentsOf: Array("RIFF".utf8)); le(36 + dataBytes, 4)
        wav.append(contentsOf: Array("WAVE".utf8))
        wav.append(contentsOf: Array("fmt ".utf8)); le(16, 4); le(1, 2); le(channels, 2)
        le(rate, 4); le(rate * channels * bits / 8, 4); le(channels * bits / 8, 2); le(bits, 2)
        wav.append(contentsOf: Array("data".utf8)); le(dataBytes, 4)
        wav.append(Data(count: dataBytes))   // the silence itself
        return wav
    }

    /// Starts the stream. Safe to call again; a second call does nothing.
    func start() {
        guard player == nil else { return }
        guard let made = try? AVAudioPlayer(data: Keepalive.silentWAV()) else {
            onProblem?("keepalive: could not build the silent stream — the headphone squeeze will not work")
            return
        }
        made.numberOfLoops = -1
        // Zero, not merely quiet: this must never be heard, and it must never
        // give echo cancellation anything to chase.
        made.volume = 0
        guard made.prepareToPlay() else {
            onProblem?("keepalive: the silent stream would not prepare — the headphone squeeze will not work")
            return
        }
        guard made.play() else {
            onProblem?("keepalive: the silent stream would not start — the headphone squeeze will not work")
            return
        }
        player = made
        onNote?("keepalive: silent stream open, so a squeeze has something to control")
    }

    func stop() {
        player?.stop()
        player = nil
    }

    /// Rebuilds against the current output device. The player is bound to the
    /// device it started on, so headphones connecting or disconnecting leaves it
    /// playing into something that is no longer there.
    func restart() {
        stop()
        start()
    }
}
