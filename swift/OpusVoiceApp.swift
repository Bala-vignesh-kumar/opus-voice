// The menu bar app.
//
// It renders and it supervises; it decides nothing about the conversation. Mode
// comes off the same server-sent events the window reads, so the menu bar and
// the window cannot disagree — the same reason src/view.mjs exists.

import AppKit
import ServiceManagement
import WebKit

final class MenuBar: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!
  private var orchestrator: Orchestrator?
  private var launchProblem: LaunchProblem?
  private var window: NSWindow?
  private var stream: Task<Void, Never>?
  private var mediaKeys: MediaKeyWatcher?

  private var mode = "asleep"
  private var status: String?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)   // menu bar only, no dock icon

    // Drawn before anything can fail, so a broken setup is still visible and
    // still quittable rather than an app with no way in.
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    render()

    let info = Bundle.main.infoDictionary
    switch resolveLaunch(
      repoRoot: info?["OVRepoRoot"] as? String,
      nodePath: info?["OVNodePath"] as? String
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
      startMediaKeys(launch: launch)
      registerLoginItemOnce()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    stream?.cancel()
    mediaKeys?.stop()
    orchestrator?.stop()
  }

  /// Squeeze the headphones to wake it. Every media key seen goes to the log,
  /// whether or not it is the bound one, because which key a given pair of
  /// headphones sends is a question only the hardware can answer.
  private func startMediaKeys(launch: Launch) {
    let binding = mediaKeyBinding(
      inConfigAt: launch.repoRoot.appendingPathComponent("config.json"))
    let watcher = MediaKeyWatcher(binding: binding) { [weak self] message in
      // Appended to the same log node writes, so there is one place to look.
      // The app's own stderr goes to the system log when launchd starts it,
      // which is nowhere a person would think to look.
      self?.appendToLog(message)
    }
    mediaKeys = watcher
    watcher.start()
    if !MediaKeyWatcher.permitted {
      NSLog("opus voice: media keys need Accessibility — see the menu")
    }
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
  }

  private func render() {
    let symbol = menuBarSymbol(mode: mode, status: status, failed: failureMessage != nil)
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "opus voice")
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
            self.render()
          }
        }
      } catch {
        // Cancelled, or the server went away. Either way there is nothing to say.
      }
    }
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
      menu.addItem(withTitle: "Quit opus voice", action: #selector(quit), keyEquivalent: "q").target = self
      return menu
    }

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

    // Named for what is wrong rather than what it does, because a silently
    // denied permission looks identical to headphones that do not work.
    if !MediaKeyWatcher.permitted {
      let grant = NSMenuItem(
        title: "Allow Headphone Wake…", action: #selector(grantMediaKeys), keyEquivalent: "")
      grant.target = self
      menu.addItem(grant)
    }

    let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    login.target = self
    menu.addItem(login)

    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit opus voice", action: #selector(quit), keyEquivalent: "q").target = self
    return menu
  }

  @objc private func openWindow() {
    guard let url = orchestrator?.sessionURL else { return }
    if let window {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let web = WKWebView(frame: .zero, configuration: config)
    web.setValue(false, forKey: "drawsBackground")

    let created = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 700),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    created.title = "opus voice"
    created.titlebarAppearsTransparent = true
    created.titleVisibility = .hidden
    created.backgroundColor = NSColor(red: 0.051, green: 0.055, blue: 0.067, alpha: 1)
    created.appearance = NSAppearance(named: .darkAqua)
    created.minSize = NSSize(width: 480, height: 420)
    created.contentView = web
    created.center()
    created.setFrameAutosaveName("opus-voice")
    created.isReleasedWhenClosed = false   // reopened from the menu, not rebuilt
    created.makeKeyAndOrderFront(nil)
    window = created

    web.load(URLRequest(url: url))
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func setMode(_ sender: NSMenuItem) {
    guard let command = sender.representedObject as? String else { return }
    post(["cmd": "mode", "mode": command])
  }

  @objc private func openProject() {
    let info = Bundle.main.infoDictionary
    guard case .success(let launch) = resolveLaunch(
      repoRoot: info?["OVRepoRoot"] as? String, nodePath: info?["OVNodePath"] as? String)
    else { return }
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: launch.projectDir.path)
  }

  /// Appends one line to the log node is writing. Opened per line and in
  /// O_APPEND mode: this fires a few times a day at most, and a long-lived
  /// second handle with its own offset would overwrite node's output rather
  /// than interleave with it.
  private func appendToLog(_ message: String) {
    guard let log = orchestrator?.logFile else { return }
    guard let data = "opus voice: \(message)\n".data(using: .utf8) else { return }
    // Never truncating: node owns that, and this is the second writer.
    let handle = Orchestrator.openLog(at: log, truncating: false)
    handle.write(data)
    try? handle.close()
  }

  @objc private func grantMediaKeys() {
    MediaKeyWatcher.requestPermission()
    // The grant only applies to a freshly started process, and saying so beats
    // leaving somebody squeezing their headphones at an app that cannot hear.
    let alert = NSAlert()
    alert.messageText = "Restart opus voice after granting"
    alert.informativeText = "Tick opus voice under Privacy & Security \u{203A} Accessibility, then quit and reopen it. macOS only applies the grant to a newly started process."
    alert.runModal()
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
      NSLog("opus voice: could not change the login item: \(error.localizedDescription)")
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
    request.setValue(token, forHTTPHeaderField: "x-opus-token")
    request.httpBody = data
    URLSession.shared.dataTask(with: request).resume()
  }

  /// Registered once, on first launch, and never again — so turning it off in
  /// System Settings stays off instead of being undone at the next launch.
  private func registerLoginItemOnce() {
    let key = "OVDidRegisterLoginItem"
    guard !UserDefaults.standard.bool(forKey: key) else { return }
    UserDefaults.standard.set(true, forKey: key)
    try? SMAppService.mainApp.register()
  }
}

// @main rather than top-level code: this file is compiled alongside three
// others, and only main.swift may carry statements at file scope.
@main
struct OpusVoice {
  static func main() {
    let app = NSApplication.shared
    // Held for the process lifetime; NSApplication does not retain its delegate.
    let delegate = MenuBar()
    app.delegate = delegate
    app.run()
  }
}
