// The node process, owned by the app.
//
// The app is the parent of the tree so that macOS has one bundle identity to
// attach microphone permission to, and so there is one thing to quit. What this
// class adds on top of "spawn a process" is knowing when the session is
// actually usable, and not pretending a crash loop is a running app.

import Foundation

final class Orchestrator {
  private let launch: Launch
  private let onChange: () -> Void
  private var task: Process?
  private var poll: Timer?
  private var restarts: [Date] = []
  private var stopping = false

  /// Where the window can be pointed, once node has bound a port.
  private(set) var sessionURL: URL? { didSet { onChange() } }
  /// Non-nil when something is wrong and the menu bar should say so.
  private(set) var problem: String? { didSet { onChange() } }

  private var sessionFile: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".opus-voice/session.json")
  }

  init(launch: Launch, onChange: @escaping () -> Void) {
    self.launch = launch
    self.onChange = onChange
  }

  func start() {
    // A session file from a previous run points at a port nothing is listening
    // on. Clearing it first means the poll below cannot latch onto a stale one.
    try? FileManager.default.removeItem(at: sessionFile)
    sessionURL = nil
    spawn()
    waitForSession()
  }

  func stop() {
    stopping = true
    poll?.invalidate()
    // SIGTERM rather than SIGKILL: index.mjs handles it, and its shutdown is
    // what closes the audio device and withdraws the session file.
    task?.terminate()
    task = nil
  }

  private func spawn() {
    let process = Process()
    process.executableURL = launch.node
    process.arguments = [
      launch.repoRoot.appendingPathComponent("src/index.mjs").path,
      "--ui",
      // The app opens the window itself, on demand. Letting node spawn one
      // would put a window on screen at every login.
      "--spawn-window", "false",
      "--dir", launch.projectDir.path,
    ]
    process.currentDirectoryURL = launch.repoRoot
    // Nothing reads these, and an unread pipe fills up and blocks the child.
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { self?.died() }
    }

    do {
      try process.run()
      task = process
      problem = nil
    } catch {
      problem = "could not start node: \(error.localizedDescription)"
    }
  }

  private func died() {
    guard !stopping else { return }
    sessionURL = nil

    // Three restarts in a minute is a crash loop, not a blip. Restarting past
    // that just hides the real failure behind a flickering menu bar.
    let minuteAgo = Date().addingTimeInterval(-60)
    restarts = restarts.filter { $0 > minuteAgo }
    guard restarts.count < 3 else {
      problem = "opus voice keeps stopping — run npm start in \(launch.repoRoot.path) to see why"
      return
    }
    restarts.append(Date())
    spawn()
    waitForSession()
  }

  /// Watches for the session file. Polled rather than watched because the file
  /// is written through a rename, and a directory watch reports the scratch
  /// file too — a poll is both simpler and harder to get wrong.
  private func waitForSession() {
    poll?.invalidate()
    let deadline = Date().addingTimeInterval(30)
    poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
      guard let self else { timer.invalidate(); return }
      if let url = self.readSession() {
        self.sessionURL = url
        timer.invalidate()
        return
      }
      if Date() > deadline {
        timer.invalidate()
        self.problem =
          "opus voice did not finish starting — run npm start in \(self.launch.repoRoot.path)"
      }
    }
  }

  private func readSession() -> URL? {
    guard
      let data = try? Data(contentsOf: sessionFile),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let text = json["url"] as? String
    else { return nil }
    return URL(string: text)
  }
}
