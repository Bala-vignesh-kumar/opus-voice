// The app.
//
// It coordinates and it supervises; it decides nothing about the conversation.
// Mode comes off the same server-sent events the window reads, so the menu bar
// and the window cannot disagree — the same reason src/view.mjs exists.
//
// The parts it used to hold inline now live beside it: the menu bar item in
// StatusItem.swift, the event stream in SessionClient.swift, the window in
// FalconWindow.swift, the launch decisions in AppLaunch.swift.

import AppKit
import ServiceManagement

final class FalconDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: StatusItem!
  private var session: SessionClient!
  private var orchestrator: Orchestrator?
  private var launchProblem: LaunchProblem?
  private let window = FalconWindow()
  private var headphones: RemoteCommandWatcher?
  /// Somebody opened the app and is waiting to see it, but node has not bound a
  /// port yet. Held until there is a session to point a window at.
  private var windowWanted = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    // A regular app is the default now that LSUIElement is out of the plist,
    // so there is no policy to set — only a menu bar to put up, which an
    // accessory app never had.
    NSApp.mainMenu = falconMainMenu(target: self)

    session = SessionClient(
      onChange: { [weak self] mode, status, statusChanged in
        if let mode { self?.statusItem.set(mode: mode) }
        if statusChanged { self?.statusItem.set(status: status) }
      },
      onEntry: { [weak self] who, text in self?.statusItem.append(who: who, text: text) },
      onReset: { [weak self] in self?.statusItem.clearConversation() }
    )

    statusItem = StatusItem(actions: StatusItem.Actions(
      openWindow: { [weak self] in self?.openWindow() },
      setMode: { [weak self] command in self?.send(["cmd": "mode", "mode": command]) },
      openProject: { [weak self] in self?.openProject() },
      openLog: { [weak self] in self?.openLog() },
      toggleLogin: { [weak self] in self?.toggleLogin() },
      quit: { NSApp.terminate(nil) }
    ))

    let info = Bundle.main.infoDictionary
    switch resolveLaunch(
      repoRoot: info?["FalconRepoRoot"] as? String,
      nodePath: info?["FalconNodePath"] as? String
    ) {
    case .failure(let problem):
      launchProblem = problem
      statusItem.set(failure: problem.message)
    case .success(let launch):
      let orchestrator = Orchestrator(launch: launch) { [weak self] in
        DispatchQueue.main.async { self?.sessionChanged() }
      }
      self.orchestrator = orchestrator
      orchestrator.start()
      startHeadphoneWake(launch: launch)
      registerLoginItemOnce()
    }

    // Who started this. The system did, for a login item — and a window nobody
    // asked for landing on a fresh desktop every morning is exactly what
    // starting at login must not mean.
    let isDefaultLaunch = notification.userInfo?[NSApplication.launchIsDefaultUserInfoKey] as? Bool ?? true
    // Wanted, not opened. At this instant the orchestrator has just cleared the
    // stale session file and node is seconds away from binding a port, so there
    // is nothing to point a window at yet — openWindow here shows "no session
    // to show yet" on every single launch, and an NSAlert raised before the app
    // has finished launching does not reliably appear at all, which is how a
    // double-click ends in nothing whatsoever happening.
    windowWanted = shouldOpenWindowAtLaunch(isDefaultLaunch: isDefaultLaunch)
  }

  /// Closing the window puts Falcon away; it does not stop it.
  ///
  /// The session keeps running and keeps listening, which is the whole point of
  /// something you talk to. Quit is a deliberate act — cmd-Q, or the menu bar's
  /// Quit — not a side effect of tidying your screen.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  /// Clicking the dock icon with no window open opens one. Without this it does
  /// nothing at all, which people reasonably report as the app being broken.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { openWindow() }
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    session?.stop()
    headphones?.stop()
    orchestrator?.stop()
  }

  // MARK: the headphone squeeze

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

  // MARK: the session

  private func sessionChanged() {
    let problem = launchProblem?.message ?? orchestrator?.problem
    statusItem.set(failure: problem)
    // The stream carries the token, so it can only start once there is a
    // session to read it from.
    if let url = orchestrator?.sessionURL { session.follow(session: url) }

    // The window somebody asked for at launch, now that there is something to
    // put in it. If the session is never coming, say so instead — by then the
    // app has finished launching and an alert will actually appear.
    if windowWanted {
      if let url = orchestrator?.sessionURL {
        windowWanted = false
        window.show(session: url)
      } else if problem != nil {
        windowWanted = false
        openWindow()
      }
    }
    // And the window holds the same token. Reconnecting the menu's stream while
    // leaving the window on the old one is how an app ends up looking dead while
    // working perfectly: the page keeps its last frame, its library 403s, and
    // nothing on screen says why.
    showSession()
  }

  /// Points an open window at the current session. A closed one is left closed:
  /// a session restarting is not a reason to put a window on somebody's screen.
  private func showSession() {
    guard window.isVisible, let url = orchestrator?.sessionURL ?? sessionURLOnDisk() else { return }
    window.show(session: url)
  }

  private func send(_ body: [String: String]) {
    guard let url = orchestrator?.sessionURL else { return }
    session.post(body, to: url)
  }

  // MARK: what the menus do

  private func openWindow() {
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

  @objc private func setModeFromMenu(_ sender: NSMenuItem) {
    guard let command = sender.representedObject as? String else { return }
    send(["cmd": "mode", "mode": command])
  }

  @objc private func interruptFromMenu() {
    send(["cmd": "interrupt"])
  }

  @objc private func openProjectFromMenu() { openProject() }
  @objc private func openLogFromMenu() { openLog() }
  @objc private func toggleLoginFromMenu() { toggleLogin() }

  private func openProject() {
    let info = Bundle.main.infoDictionary
    guard case .success(let launch) = resolveLaunch(
      repoRoot: info?["FalconRepoRoot"] as? String, nodePath: info?["FalconNodePath"] as? String)
    else { return }
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: launch.projectDir.path)
  }

  private func openLog() {
    guard let log = orchestrator?.logFile else { return }
    NSWorkspace.shared.open(log)
  }

  private func toggleLogin() {
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {
      NSLog("Falcon: could not change the login item: \(error.localizedDescription)")
    }
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

  /// Registered once, on first launch, and never again — so turning it off in
  /// System Settings stays off instead of being undone at the next launch.
  private func registerLoginItemOnce() {
    let key = "FalconDidRegisterLoginItem"
    guard !UserDefaults.standard.bool(forKey: key) else { return }
    UserDefaults.standard.set(true, forKey: key)
    try? SMAppService.mainApp.register()
  }
}

// @main rather than top-level code: this file is compiled alongside several
// others, and only main.swift may carry statements at file scope.
@main
struct Falcon {
  static func main() {
    let app = NSApplication.shared
    // Held for the process lifetime; NSApplication does not retain its delegate.
    let delegate = FalconDelegate()
    app.delegate = delegate
    app.run()
  }
}
