// voiceio — the audio half of Opus Voice.
//
// Owns the microphone, Apple's on-device recognizer, and speech synthesis in a
// single process so they can share one audio graph. That sharing is the whole
// point: the voice-processing audio unit only cancels echo from audio rendered
// through its own output, so synthesized speech is played through this engine
// rather than handed to `say`. Without that, the mic hears the Mac talking and
// the thing barges in on itself.
//
// Protocol is newline-delimited JSON: commands on stdin, events on stdout.

import AVFoundation
import CoreMedia
import Foundation
import Speech

// MARK: - JSON line IO

let stdoutLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ message: String, fatal: Bool = false) {
    emit(["type": "error", "message": message, "fatal": fatal])
    if fatal { exit(1) }
}

// MARK: - Transcriber engine (macOS 26)

/// Wraps `SpeechAnalyzer` + `SpeechTranscriber`, the recognizer behind modern
/// dictation. It is a separate type purely so all the macOS 26 symbols sit
/// behind one availability annotation instead of being smeared through VoiceIO.
///
/// Unlike `SFSpeechRecognitionTask` this session does not expire after a minute,
/// so it is started once and kept running; turn boundaries are drawn with
/// `finalize` rather than by tearing the recognizer down.
@available(macOS 26.0, *)
final class TranscriberEngine {
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let format: AVAudioFormat
    private var converter: AVAudioConverter?

    /// Running sample clock for the input stream. Every buffer must carry its
    /// start time: without one the analyzer accepts the audio and then reports
    /// nothing at all, which looks exactly like a dead microphone.
    private var framePosition: Int64 = 0
    private let clock = NSLock()

    /// Called on every result. `volatile` text is still revisable; anything else
    /// is immutable and has been appended to the finalized run.
    var onResult: ((_ text: String, _ isFinal: Bool) -> Void)?

    /// The audio format the analyzer wants; mic buffers are resampled into it.
    var inputFormat: AVAudioFormat { format }

    static func supports(_ locale: Locale) async -> Bool {
        guard SpeechTranscriber.isAvailable else { return false }
        return await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil
    }

    static func installed(_ locale: Locale) async -> Bool {
        let code = locale.identifier(.bcp47)
        return await SpeechTranscriber.installedLocales
            .contains { $0.identifier(.bcp47) == code }
    }

    /// Downloads the on-device model for this locale if it is supported but not
    /// yet present. Nothing to do on a machine that already has it.
    static func install(_ locale: Locale) async throws {
        let probe = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
            try await request.downloadAndInstall()
        }
    }

    init(locale: Locale) async throws {
        // Volatile results are what makes the UI feel live and drive barge-in;
        // without them nothing appears until the speaker pauses.
        transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        guard let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(
                domain: "voiceio",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "no analyzer audio format for \(locale.identifier)"]
            )
        }
        format = best

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.continuation = continuation
        analyzer = SpeechAnalyzer(modules: [transcriber])
        try await analyzer.start(inputSequence: stream)

        Task { [transcriber] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    self.onResult?(text, result.isFinal)
                }
            } catch {
                emit([
                    "type": "recog_error",
                    "message": error.localizedDescription,
                    "engine": "transcriber",
                ])
            }
        }
    }

    /// Resamples a mic buffer into the analyzer's format and hands it over.
    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converted = resample(buffer) else { return }
        clock.lock()
        let start = CMTime(value: framePosition, timescale: CMTimeScale(format.sampleRate))
        framePosition += Int64(converted.frameLength)
        clock.unlock()
        continuation.yield(AnalyzerInput(buffer: converted, bufferStartTime: start))
    }

    /// Promotes everything still volatile into a final result, so a turn
    /// boundary lands on immutable text rather than on a guess.
    ///
    /// Finalizing needs a concrete mark and needs input to keep arriving past
    /// it — `finalize(through: nil)` simply never returns on a live stream. The
    /// mic satisfies that, but a stalled input device would otherwise wedge
    /// turn-taking forever, so the wait is capped and the barrier is
    /// best-effort.
    func finalizeTurn(timeout: TimeInterval = 2.0) async {
        clock.lock()
        let mark = CMTime(value: framePosition, timescale: CMTimeScale(format.sampleRate))
        clock.unlock()

        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let resumed = NSLock()
            var already = false
            let finish = {
                resumed.lock()
                let first = !already
                already = true
                resumed.unlock()
                if first { cont.resume() }
            }
            Task {
                try? await self.analyzer.finalize(through: mark)
                finish()
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                finish()
            }
        }
    }

    private func resample(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if pcm.format == format { return pcm }
        if converter == nil || converter?.inputFormat != pcm.format {
            converter = AVAudioConverter(from: pcm.format, to: format)
        }
        guard let converter else { return nil }

        let ratio = format.sampleRate / pcm.format.sampleRate
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }

        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return pcm
        }
        if error != nil { return nil }
        return out.frameLength > 0 ? out : nil
    }
}

// MARK: - VoiceIO

final class VoiceIO: NSObject {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let synth = AVSpeechSynthesizer()
    private let state = DispatchQueue(label: "voiceio.state")

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    // macOS 26 path. SFSpeechRecognizer only has assets for a handful of
    // locales, so anything else (en-IN among them) silently degrades to Apple's
    // dictation server. SpeechTranscriber is the model modern dictation uses and
    // ships on-device assets for the full English spread, which is a large
    // accuracy difference on non-US accents. Preferred whenever it has the
    // locale; the legacy recognizer stays as the fallback.
    private var transcriber: AnyObject?
    private var usingTranscriber = false
    private var recognizerName = "SFSpeechRecognizer"

    /// Turn assembly for the transcriber path. Results arrive as revisable
    /// "volatile" text followed by immutable finalized text, so a turn is
    /// everything finalized past `finalizedBase` plus whatever is still volatile.
    private var finalizedText = ""
    private var volatileText = ""
    private var finalizedBase = 0
    private var awaitingBarrier = false

    private var playFormat: AVAudioFormat!
    private var micFormat: AVAudioFormat!
    private var pcmFormat: AVAudioFormat?
    private var converter: AVAudioConverter?

    // Config, overridable via the `configure` command.
    private var voice: AVSpeechSynthesisVoice?
    private var rate: Float = 0.52
    private var pitch: Float = 1.0
    private var endpointMs: Double = 700
    private var endpointFastMs: Double = 400
    private var bargeInWords = 2
    private var onDevice = true
    private var localeId = "en-US"

    // Turn state.
    private var listening = true
    private var speaking = false
    private var partial = ""
    private var lastChange = Date()
    private var spokenLower = ""
    private var queue: [String] = []
    private var generation = 0
    private var endpointTimer: DispatchSourceTimer?

    // Diagnostics: proves whether audio is arriving and whether recognition is
    // failing, rather than leaving a silent app that looks identical either way.
    private var levelSum: Float = 0
    private var levelFrames = 0
    private var lastLevelEmit = Date()
    private var recogFailures = 0

    // MARK: Startup

    /// Must be called before `start()`; the recognizer is built once at setup.
    func setLocale(_ identifier: String) {
        localeId = identifier
    }

    func start() {
        requestPermissions { [weak self] in
            guard let self else { return }
            do {
                try self.setupAudio()
            } catch {
                fail("audio engine failed to start: \(error.localizedDescription)", fatal: true)
                return
            }
            // Picking a recognizer can mean a model download, so `ready` waits
            // for it. Announcing before it resolves reports the wrong engine and
            // the wrong on-device state.
            self.setupRecognizer {
                self.startEndpointTimer()
                emit([
                    "type": "ready",
                    "voice": self.voice?.name ?? "unknown",
                    "voiceId": self.voice?.identifier ?? "",
                    "onDevice": self.onDevice,
                    "locale": self.localeId,
                    "recognizer": self.recognizerName,
                ])
            }
        }
    }

    private func requestPermissions(_ done: @escaping () -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { micOK in
            guard micOK else {
                fail("microphone access denied — grant it to your terminal in System Settings › Privacy & Security › Microphone", fatal: true)
                return
            }
            SFSpeechRecognizer.requestAuthorization { status in
                guard status == .authorized else {
                    fail("speech recognition denied — grant it to your terminal in System Settings › Privacy & Security › Speech Recognition", fatal: true)
                    return
                }
                DispatchQueue.main.async(execute: done)
            }
        }
    }

    private func setupAudio() throws {
        let input = engine.inputNode
        // Acoustic echo cancellation. Best-effort: some aggregate/virtual devices
        // refuse it, in which case barge-in gets noisier but still works via the
        // self-echo filter in handleTranscript.
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            emit(["type": "warn", "message": "echo cancellation unavailable: \(error.localizedDescription)"])
        }

        let hardware = engine.outputNode.outputFormat(forBus: 0)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: hardware.sampleRate, channels: 1) else {
            throw NSError(domain: "voiceio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no usable output format"])
        }
        playFormat = format

        engine.attach(player)
        // Pin the mixer to the hardware format explicitly. Touching mainMixerNode
        // otherwise binds it lazily at 44.1kHz, which throws -10875 against a
        // 48kHz output device.
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: hardware)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        // Voice processing turns the built-in mic into a 9-channel array feed
        // whose channels all carry the same processed signal, so take channel 0
        // and hand the recognizer plain mono.
        let inputFormat = input.outputFormat(forBus: 0)
        micFormat = AVAudioFormat(standardFormatWithSampleRate: inputFormat.sampleRate, channels: 1)
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            guard let self, let mono = self.mono(from: buffer) else { return }
            self.meter(mono)
            if #available(macOS 26.0, *), let engine = self.transcriber as? TranscriberEngine {
                engine.feed(mono)
            } else {
                self.request?.append(mono)
            }
        }

        engine.prepare()
        try engine.start()

        if voice == nil { voice = Self.resolveVoice(nil) }
    }

    private func mono(from buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format.channelCount == 1 { return buffer }
        guard let source = buffer.floatChannelData,
              let format = micFormat,
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength),
              let dest = out.floatChannelData
        else { return nil }
        out.frameLength = buffer.frameLength
        memcpy(dest[0], source[0], Int(buffer.frameLength) * MemoryLayout<Float>.size)
        return out
    }

    /// Reports mic loudness a few times a second so a dead input is visible
    /// rather than indistinguishable from a working one that hears nothing.
    private func meter(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData else { return }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<count { sum += samples[0][i] * samples[0][i] }
        levelSum += sum
        levelFrames += count

        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.3, levelFrames > 0 else { return }
        let rms = (levelSum / Float(levelFrames)).squareRoot()
        levelSum = 0
        levelFrames = 0
        lastLevelEmit = now
        emit(["type": "level", "rms": Double(rms)])
    }

    private func setupRecognizer(_ done: @escaping () -> Void) {
        // Prefer the macOS 26 transcriber wherever it has the locale. This is the
        // whole accuracy story for non-US English: SFSpeechRecognizer has no
        // on-device asset for en-IN and quietly falls back to the dictation
        // server, which mis-hears Indian-accented speech badly.
        if #available(macOS 26.0, *) {
            let locale = Locale(identifier: localeId)
            Task {
                let fallback = { (reason: String) in
                    emit(["type": "warn", "message": "\(reason); using the legacy recognizer"])
                    DispatchQueue.main.async { self.setupLegacyRecognizer(done) }
                }
                guard await TranscriberEngine.supports(locale) else {
                    fallback("SpeechTranscriber has no model for \(self.localeId)")
                    return
                }
                if await !TranscriberEngine.installed(locale) {
                    emit(["type": "warn", "message": "downloading the on-device model for \(self.localeId)…"])
                    do {
                        try await TranscriberEngine.install(locale)
                    } catch {
                        fallback("model download failed (\(error.localizedDescription))")
                        return
                    }
                }
                do {
                    let engine = try await TranscriberEngine(locale: locale)
                    engine.onResult = { [weak self] text, isFinal in
                        self?.handleTranscriberResult(text, isFinal: isFinal)
                    }
                    DispatchQueue.main.async {
                        self.transcriber = engine
                        self.usingTranscriber = true
                        self.onDevice = true
                        self.recognizerName = "SpeechTranscriber"
                        done()
                    }
                } catch {
                    fallback("SpeechTranscriber failed to start (\(error.localizedDescription))")
                }
            }
            return
        }
        setupLegacyRecognizer(done)
    }

    private func setupLegacyRecognizer(_ done: @escaping () -> Void) {
        recognizerName = "SFSpeechRecognizer"
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
            fail("no speech recognizer for \(localeId)", fatal: true)
            return
        }
        recognizer.defaultTaskHint = .dictation
        self.recognizer = recognizer
        onDevice = recognizer.supportsOnDeviceRecognition
        if !onDevice {
            emit(["type": "warn", "message": "on-device recognition unavailable; falling back to server-based (needs network)"])
        }
        restartRecognition()
        done()
    }

    // MARK: Recognition

    private func restartRecognition() {
        // The transcriber session does not expire, so a turn boundary is a
        // finalize, not a teardown.
        if usingTranscriber {
            beginTurnBarrier()
            return
        }
        task?.cancel()
        task = nil
        request?.endAudio()

        guard let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = onDevice
        if #available(macOS 13.0, *) { req.addsPunctuation = true }
        request = req

        state.sync {
            partial = ""
            lastChange = Date()
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.recogFailures = 0
                self.handleTranscript(result.bestTranscription.formattedString)
            }
            guard let error = error as NSError?, self.request === req else { return }

            // Sessions expire (~1 min) and cycling is normal, but a failure that
            // repeats is a real fault and must not be hidden behind a silent
            // restart loop that looks exactly like "nothing was said".
            self.recogFailures += 1
            emit([
                "type": "recog_error",
                "message": error.localizedDescription,
                "code": error.code,
                "domain": error.domain,
                "attempt": self.recogFailures,
            ])

            if self.recogFailures == 3, self.onDevice {
                self.onDevice = false
                emit(["type": "warn", "message": "on-device recognition keeps failing — retrying over the network. To fix on-device: System Settings › Keyboard › Dictation, turn it on and let the language download finish."])
            }

            let backoff = min(2.0, 0.25 * Double(self.recogFailures))
            DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { self.restartRecognition() }
        }
    }

    /// Assembles a turn from transcriber results. Finalized text accumulates;
    /// volatile text replaces whatever came before it.
    private func handleTranscriberResult(_ text: String, isFinal: Bool) {
        var running = ""
        var suppressed = false
        state.sync {
            if isFinal {
                finalizedText += text
                volatileText = ""
            } else {
                volatileText = text
            }
            suppressed = awaitingBarrier
            running = String(finalizedText.dropFirst(finalizedBase)) + volatileText
        }
        // Between taking a turn and the barrier landing, results still describe
        // the turn just handed off. Emitting them would repeat it.
        guard !suppressed else { return }
        handleTranscript(running)
    }

    /// Draws a turn boundary. Promotes anything still volatile to final, then
    /// moves the baseline past it so the next turn starts from empty text.
    /// Must not be called from the `state` queue.
    private func beginTurnBarrier() {
        guard #available(macOS 26.0, *), let engine = transcriber as? TranscriberEngine else { return }
        state.sync { awaitingBarrier = true }
        Task {
            await engine.finalizeTurn()
            self.state.sync {
                self.finalizedBase = self.finalizedText.count
                self.volatileText = ""
                self.partial = ""
                self.awaitingBarrier = false
            }
        }
    }

    private func handleTranscript(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        var shouldBargeIn = false
        state.sync {
            guard trimmed != partial else { return }
            // Second line of defence behind echo cancellation: if everything we
            // "heard" is already inside what we are currently saying, it's our
            // own voice leaking back in.
            if speaking, isSelfEcho(trimmed) { return }
            partial = trimmed
            lastChange = Date()
            if speaking, trimmed.split(separator: " ").count >= bargeInWords {
                shouldBargeIn = true
            }
        }
        guard !partial.isEmpty else { return }
        emit(["type": "partial", "text": trimmed])
        if shouldBargeIn {
            emit(["type": "bargein"])
            stopSpeaking()
        }
    }

    private func isSelfEcho(_ text: String) -> Bool {
        let words = text.lowercased().split(separator: " ")
        guard !words.isEmpty else { return true }
        return words.allSatisfy { spokenLower.contains($0) }
    }

    private func startEndpointTimer() {
        let timer = DispatchSource.makeTimerSource(queue: state)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard self.listening, !self.speaking, !self.partial.isEmpty else { return }
            // The recognizer punctuates as it goes, so a trailing full stop is a
            // strong signal the thought is finished — take the turn sooner. Without
            // one, wait longer rather than cutting off someone mid-sentence.
            let complete = self.partial.hasSuffix(".") || self.partial.hasSuffix("?") || self.partial.hasSuffix("!")
            let threshold = complete ? self.endpointFastMs : self.endpointMs
            guard Date().timeIntervalSince(self.lastChange) * 1000 > threshold else { return }
            let text = self.partial
            self.partial = ""
            emit(["type": "final", "text": text])
            DispatchQueue.main.async { self.restartRecognition() }
        }
        timer.resume()
        endpointTimer = timer
    }

    // MARK: Speech

    func speak(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        state.sync { queue.append(clean) }
        drain()
    }

    private func drain() {
        var next: String?
        state.sync {
            guard !speaking, !queue.isEmpty else { return }
            next = queue.removeFirst()
            speaking = true
            spokenLower = next!.lowercased()
            // Anything heard mid-utterance starts a fresh turn.
            partial = ""
        }
        guard let utteranceText = next else { return }
        beginTurnBarrier()
        emit(["type": "speech_start", "text": utteranceText])
        synthesize(utteranceText)
    }

    private func synthesize(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = rate
        utterance.pitchMultiplier = pitch

        let gen = state.sync { () -> Int in
            generation += 1
            return generation
        }

        converter = nil
        var started = false

        synth.write(utterance) { [weak self] buffer in
            guard let self else { return }
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }

            if pcm.frameLength == 0 {
                // End marker: tail a silent buffer whose completion tells us the
                // audio actually reached the speakers, not merely got scheduled.
                self.scheduleTail(gen: gen, started: started)
                return
            }

            if self.converter == nil {
                self.converter = AVAudioConverter(from: pcm.format, to: self.playFormat)
            }
            guard let converted = self.convert(pcm) else { return }

            self.player.scheduleBuffer(converted, completionHandler: nil)
            if !started {
                started = true
                self.player.play()
            }
        }
    }

    // MARK: External PCM (Piper)
    //
    // Audio synthesized elsewhere still has to be played through this engine,
    // not handed to the system, or echo cancellation loses its reference signal
    // and barge-in starts triggering on our own voice.

    private var pcmStarted = false

    private func pcmStart(text: String, sampleRate: Double) {
        guard let inputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        ) else {
            fail("unsupported PCM sample rate: \(sampleRate)")
            return
        }

        converter = AVAudioConverter(from: inputFormat, to: playFormat)
        pcmFormat = inputFormat
        pcmStarted = false

        state.sync {
            generation += 1
            speaking = true
            spokenLower = text.lowercased()
            partial = ""
        }
        beginTurnBarrier()
        emit(["type": "speech_start", "text": text])
    }

    private func pcmAppend(_ data: Data) {
        guard let format = pcmFormat, !data.isEmpty else { return }
        let frames = AVAudioFrameCount(data.count / 2)
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let channel = buffer.int16ChannelData
        else { return }

        buffer.frameLength = frames
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            memcpy(channel[0], base, data.count)
        }

        guard let converted = convert(buffer) else { return }
        player.scheduleBuffer(converted, completionHandler: nil)
        if !pcmStarted {
            pcmStarted = true
            player.play()
        }
    }

    private func pcmEnd() {
        let gen = state.sync { generation }
        scheduleTail(gen: gen, started: pcmStarted)
    }

    private func convert(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return nil }
        let ratio = playFormat.sampleRate / pcm.format.sampleRate
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: capacity) else { return nil }

        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return pcm
        }
        if let error {
            fail("audio conversion failed: \(error.localizedDescription)")
            return nil
        }
        return out.frameLength > 0 ? out : nil
    }

    private func scheduleTail(gen: Int, started: Bool) {
        guard started, let tail = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: 512) else {
            finishSpeaking(gen: gen, interrupted: false)
            return
        }
        tail.frameLength = 512
        player.scheduleBuffer(tail, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            self?.finishSpeaking(gen: gen, interrupted: false)
        }
    }

    private func finishSpeaking(gen: Int, interrupted: Bool) {
        var report = false
        state.sync {
            // Stale completion from an utterance we already cut off.
            guard gen == generation, speaking else { return }
            speaking = false
            spokenLower = ""
            partial = ""
            lastChange = Date()
            report = true
        }
        guard report else { return }
        emit(["type": "speech_end", "interrupted": interrupted])
        drain()
    }

    func stopSpeaking() {
        var gen = 0
        state.sync {
            generation += 1
            gen = generation
            queue.removeAll()
            guard speaking else { return }
            speaking = false
            spokenLower = ""
            partial = ""
            lastChange = Date()
        }
        synth.stopSpeaking(at: .immediate)
        player.stop()
        _ = gen
        emit(["type": "speech_end", "interrupted": true])
    }

    // MARK: Commands

    func handle(_ command: [String: Any]) {
        switch command["cmd"] as? String ?? "" {
        case "speak":
            if let text = command["text"] as? String { speak(text) }
        case "pcm_start":
            pcmStart(
                text: command["text"] as? String ?? "",
                sampleRate: command["sampleRate"] as? Double ?? 22050
            )
        case "pcm":
            if let encoded = command["data"] as? String,
               let data = Data(base64Encoded: encoded) {
                pcmAppend(data)
            }
        case "pcm_end":
            pcmEnd()
        case "stop":
            stopSpeaking()
        case "listen":
            state.sync {
                listening = command["on"] as? Bool ?? true
                partial = ""
            }
        case "configure":
            configure(command)
        case "voices":
            emit(["type": "voices", "voices": Self.voiceCatalog()])
        case "quit":
            engine.stop()
            exit(0)
        default:
            fail("unknown command: \(command["cmd"] ?? "nil")")
        }
    }

    private func configure(_ command: [String: Any]) {
        if let name = command["voice"] as? String, let resolved = Self.resolveVoice(name) {
            voice = resolved
            emit(["type": "voice", "name": resolved.name, "voiceId": resolved.identifier])
        }
        if let value = command["rate"] as? Double { rate = Float(value) }
        if let value = command["pitch"] as? Double { pitch = Float(value) }
        state.sync {
            if let value = command["endpointMs"] as? Double { endpointMs = value }
            if let value = command["endpointFastMs"] as? Double { endpointFastMs = value }
            if let value = command["bargeInWords"] as? Int { bargeInWords = max(1, value) }
        }
    }

    // MARK: Voices

    /// Voices Apple ships that sound acceptable at default quality, best first.
    /// Only consulted when nothing better is installed.
    private static let fallbackNames = ["Ava", "Zoe", "Samantha", "Allison", "Susan", "Tom", "Alex"]

    static func resolveVoice(_ preference: String?) -> AVSpeechSynthesisVoice? {
        let all = AVSpeechSynthesisVoice.speechVoices()
        if let preference, !preference.isEmpty {
            if let exact = all.first(where: { $0.identifier == preference }) { return exact }
            let named = all.filter { $0.name.lowercased() == preference.lowercased() }
            if let best = pickByQuality(named) { return best }
        }
        // Prefer en-US, but never strand a machine that only has other locales.
        return pickByQuality(all.filter { $0.language == "en-US" })
            ?? pickByQuality(all.filter { $0.language.hasPrefix("en") })
    }

    private static func pickByQuality(_ voices: [AVSpeechSynthesisVoice]) -> AVSpeechSynthesisVoice? {
        if let premium = voices.first(where: { $0.quality == .premium }) { return premium }
        if let enhanced = voices.first(where: { $0.quality == .enhanced }) { return enhanced }
        for name in fallbackNames {
            if let match = voices.first(where: { $0.name == name }) { return match }
        }
        return voices.first
    }

    static func voiceCatalog() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .map { [
                "name": $0.name,
                "voiceId": $0.identifier,
                "language": $0.language,
                "quality": $0.quality == .premium ? "premium" : ($0.quality == .enhanced ? "enhanced" : "default"),
            ] }
    }
}

// MARK: - Main

setvbuf(stdout, nil, _IONBF, 0)

let io = VoiceIO()
if let index = CommandLine.arguments.firstIndex(of: "--locale"),
   index + 1 < CommandLine.arguments.count {
    io.setLocale(CommandLine.arguments[index + 1])
}
io.start()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty,
              let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        DispatchQueue.main.async { io.handle(obj) }
    }
    // stdin closed — the orchestrator is gone.
    exit(0)
}

RunLoop.main.run()
