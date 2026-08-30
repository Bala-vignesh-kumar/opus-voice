// The menu bar app.
//
// It renders and it supervises; it decides nothing about the conversation. Mode
// comes off the same server-sent events the window reads, so the menu bar and
// the window cannot disagree — the same reason src/view.mjs exists.

import AppKit
import ServiceManagement

final class MenuBar: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!
  private var orchestrator: Orchestrator?
  private var launchProblem: LaunchProblem?
  private let window = FalconWindow()
  private var stream: Task<Void, Never>?
  private var headphones: RemoteCommandWatcher?

  private var mode = "asleep"
  private var status: String?
  /// The last few things said, so the menu can show the conversation when no
  /// window is open. Without this the menu bar reports a mode and nothing else,
  /// and a whole exchange can happen with nothing on screen to show for it.
  private var recent: [(who: String, text: String)] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)   // menu bar only, no dock icon

    // Drawn before anything can fail, so a broken setup is still visible and
    // still quittable rather than an app with no way in.
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    render()

    let info = Bundle.main.infoDictionary
    switch resolveLaunch(
      repoRoot: info?["FalconRepoRoot"] as? String,
      nodePath: info?["FalconNodePath"] as? String
    ) {
    case .failure(let problem):
      launchProblem = problem
      render()
    case .success(let launch):
      let orchestrator = Orchestrator(launch: launch) { [weak self] in
        DispatchQueue.main.async { self?.sessionChanged() }
      }
      self.orchestrator = orchestrator
      orchestrator.start()
      startHeadphoneWake(launch: launch)
      registerLoginItemOnce()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    stream?.cancel()
    headphones?.stop()
    orchestrator?.stop()
  }

  /// Squeeze the headphones to wake it.
  ///
  /// Measured, not assumed: AirPods send AVRCP commands that macOS routes to
  /// the Now Playing app, never HID media keys. A global NSEvent monitor with
  /// every permission granted saw nothing; this path sees every squeeze.
  private func startHeadphoneWake(launch: Launch) {
    let config = launch.repoRoot.appendingPathComponent("config.json")
    let watcher = RemoteCommandWatcher(
      gesture: WakeGesture.named(stringSetting("wakeGesture", inConfigAt: config)),
      forwardToPlayer: boolSetting("forwardMediaKeys", inConfigAt: config, default: true),
      onWake: { [weak self] in self?.wokenByGesture() }
    ) { [weak self] message in
      self?.appendToLog(message)
    }
    headphones = watcher
    watcher.start()
  }

  /// What a squeeze means. The watcher recognises the gesture; this decides.
  private func wokenByGesture() {
    pokeWakeFile()
    appendToLog("woke by headphone squeeze")
  }

  /// Touching the file node's Trigger watches. The same door the Siri Shortcut
  /// comes through, so there is one way in and one thing to get right.
  private func pokeWakeFile() {
    let file = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".falcon/wake")
    let stamp = "\(Date().timeIntervalSince1970)\n"
    try? stamp.write(to: file, atomically: true, encoding: .utf8)
  }
  // MARK: state

  private var failureMessage: String? {
    launchProblem?.message ?? orchestrator?.problem
  }

  private func sessionChanged() {
    render()
    // The stream carries the token, so it can only start once there is a
    // session to read it from.
    if orchestrator?.sessionURL != nil { listen() }
    // And the window holds the same token. Reconnecting the menu's stream while
    // leaving the window on the old one is how an app ends up looking dead while
    // working perfectly: the page keeps its last frame, its library 403s, and
    // nothing on screen says why.
    showSession()
  }

  /// Points an open window at the current session. A closed one is left
  /// closed: a session restarting is not a reason to put a window on somebody's
  /// screen.
  private func showSession() {
    guard window.isVisible, let url = orchestrator?.sessionURL ?? sessionURLOnDisk() else { return }
    window.show(session: url)
  }

  private func render() {
    let symbol = menuBarSymbol(mode: mode, status: status, failed: failureMessage != nil)
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Falcon")
    image?.isTemplate = true
    item.button?.image = image
    item.menu = buildMenu()
  }

  // MARK: the conversation stream

  /// Follows the same server-sent events the window does, so the glyph reflects
  /// what actually happened rather than what the menu last asked for.
  private func listen() {
    guard let base = orchestrator?.sessionURL else { return }
    stream?.cancel()
    stream = Task { [weak self] in
      guard let events = URL(string: "/events?\(base.query ?? "")", relativeTo: base) else { return }
      guard let (bytes, _) = try? await URLSession.shared.bytes(from: events) else { return }
      // The stream ends when the session does. A dropped connection is not
      // worth surfacing on its own, because the orchestrator already reports a
      // dead child — and reporting it twice would mean two different glyphs
      // racing to describe one failure.
      do {
        for try await line in bytes.lines {
          guard line.hasPrefix("data: "), let self else { continue }
          let payload = String(line.dropFirst(6))
          guard
            let data = payload.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
          else { continue }
          await MainActor.run {
            // A snapshot carries both; a patch carries whichever changed.
            if let mode = json["mode"] as? String { self.mode = mode }
            if json.keys.contains("status") { self.status = json["status"] as? String }
            self.absorb(json)
            self.render()
          }
        }
      } catch {
        // Cancelled, or the server went away. Either way there is nothing to say.
      }
    }
  }

  /// Pulls conversation lines out of a snapshot or a patch. The bus sends a
  /// whole `entries` array to a client that connects late, and single `entry`
  /// objects after that.
  private func absorb(_ json: [String: Any]) {
    var incoming: [[String: Any]] = []
    if let entries = json["entries"] as? [[String: Any]] { recent = []; incoming = entries }
    if let entry = json["entry"] as? [String: Any] { incoming = [entry] }
    for entry in incoming {
      guard
        let kind = entry["type"] as? String,
        kind == "you" || kind == "falcon",
        let text = entry["text"] as? String,
        !text.isEmpty
      else { continue }
      recent.append((who: kind == "you" ? "you" : "falcon", text: text))
    }
    if recent.count > 6 { recent.removeFirst(recent.count - 6) }
  }

  // MARK: menu

  private func buildMenu() -> NSMenu {
    let menu = NSMenu()

    if let message = failureMessage {
      let problem = NSMenuItem(title: message, action: nil, keyEquivalent: "")
      problem.isEnabled = false
      menu.addItem(problem)
      menu.addItem(.separator())
      menu.addItem(withTitle: "Open Log", action: #selector(openLog), keyEquivalent: "").target = self
      menu.addItem(withTitle: "Quit Falcon", action: #selector(quit), keyEquivalent: "q").target = self
      return menu
    }

    // The conversation, so a whole exchange can happen with the window closed
    // and still leave something to look at.
    if recent.isEmpty {
      let empty = NSMenuItem(title: "Nothing said yet", action: nil, keyEquivalent: "")
      empty.isEnabled = false
      menu.addItem(empty)
    } else {
      for line in recent {
        let trimmed = line.text.count > 60 ? String(line.text.prefix(59)) + "…" : line.text
        let item = NSMenuItem(title: "\(line.who == "you" ? "you" : "falcon")   \(trimmed)",
                              action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
      }
    }
    menu.addItem(.separator())

    menu.addItem(withTitle: "Open Window", action: #selector(openWindow), keyEquivalent: "o").target = self
    menu.addItem(.separator())

    for (title, command) in [("Discuss", "chat"), ("Take Notes", "note"), ("Sleep", "stop")] {
      let entry = NSMenuItem(title: title, action: #selector(setMode(_:)), keyEquivalent: "")
      entry.representedObject = command
      entry.target = self
      menu.addItem(entry)
    }

    menu.addItem(.separator())
    menu.addItem(withTitle: "Open Project Folder", action: #selector(openProject), keyEquivalent: "").target = self
    // Everything the terminal surface would have told you. Without this the app
    // is the only surface that cannot explain itself.
    menu.addItem(withTitle: "Open Log", action: #selector(openLog), keyEquivalent: "").target = self

    let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    login.target = self
    menu.addItem(login)

    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Falcon", action: #selector(quit), keyEquivalent: "q").target = self
    return menu
  }

  @objc private func openWindow() {
    // Falling back to the file on disk before giving up: the orchestrator's
    // copy can be stale if the session was republished, and a menu item that
    // does nothing at all is the worst outcome available.
    guard let url = orchestrator?.sessionURL ?? sessionURLOnDisk() else {
      let alert = NSAlert()
      alert.messageText = "No session to show yet"
      alert.informativeText = "Falcon is still starting, or node is not running. Open Log from this menu to see why."
      alert.runModal()
      return
    }
    window.show(session: url)
  }

  @objc private func setMode(_ sender: NSMenuItem) {
    guard let command = sender.representedObject as? String else { return }
    post(["cmd": "mode", "mode": command])
  }

  @objc private func openProject() {
    let info = Bundle.main.infoDictionary
    guard case .success(let launch) = resolveLaunch(
      repoRoot: info?["FalconRepoRoot"] as? String, nodePath: info?["FalconNodePath"] as? String)
    else { return }
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: launch.projectDir.path)
  }

  /// Appends one line to the log node is writing. Opened per line and in
  /// O_APPEND mode: this fires a few times a day at most, and a long-lived
  /// second handle with its own offset would overwrite node's output rather
  /// than interleave with it.
  private func appendToLog(_ message: String) {
    guard let log = orchestrator?.logFile else { return }
    guard let data = "Falcon: \(message)\n".data(using: .utf8) else { return }
    // Never truncating: node owns that, and this is the second writer.
    let handle = Orchestrator.openLog(at: log, truncating: false)
    handle.write(data)
    try? handle.close()
  }

  @objc private func openLog() {
    guard let log = orchestrator?.logFile else { return }
    NSWorkspace.shared.open(log)
  }

  @objc private func toggleLogin() {
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {
      NSLog("Falcon: could not change the login item: \(error.localizedDescription)")
    }
    render()
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }


  // MARK: plumbing

  /// The same POST the window's buttons make, so a menu item and a button are
  /// the same instruction arriving by different routes.
  private func post(_ body: [String: String]) {
    guard
      let base = orchestrator?.sessionURL,
      let endpoint = URL(string: "/command", relativeTo: base),
      let token = URLComponents(url: base, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "k" })?.value,
      let data = try? JSONSerialization.data(withJSONObject: body)
    else { return }

    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-falcon-token")
    request.httpBody = data
    URLSession.shared.dataTask(with: request).resume()
  }

  /// Registered once, on first launch, and never again — so turning it off in
  /// System Settings stays off instead of being undone at the next launch.
  private func registerLoginItemOnce() {
    let key = "FalconDidRegisterLoginItem"
    guard !UserDefaults.standard.bool(forKey: key) else { return }
    UserDefaults.standard.set(true, forKey: key)
    try? SMAppService.mainApp.register()
  }
}

// @main rather than top-level code: this file is compiled alongside three
// others, and only main.swift may carry statements at file scope.
@main
struct Falcon {
  static func main() {
    let app = NSApplication.shared
    // Held for the process lifetime; NSApplication does not retain its delegate.
    let delegate = MenuBar()
    app.delegate = delegate
    app.run()
  }
}
