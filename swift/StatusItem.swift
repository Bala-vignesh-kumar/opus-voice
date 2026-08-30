// The menu bar item.
//
// It draws and it dispatches; it decides nothing. What each item does is handed
// in, because the same commands are reachable from the main menu now and there
// must be one implementation of each rather than two that drift.
//
// This menu is not made redundant by the main menu above it. It is the surface
// that works when no window is open, which is most of the time — the whole
// point of something you talk to.

import AppKit
import ServiceManagement

final class StatusItem: NSObject {
  /// What the menu's items do. Held rather than reached for, so this file never
  /// needs to know about the orchestrator, the session, or the window.
  struct Actions {
    let openWindow: () -> Void
    let setMode: (String) -> Void
    let openProject: () -> Void
    let openLog: () -> Void
    let toggleLogin: () -> Void
    let quit: () -> Void
  }

  private let item: NSStatusItem
  private let actions: Actions

  private var mode = "asleep"
  private var status: String?
  private var failure: String?
  private var recent: [(who: String, text: String)] = []

  init(actions: Actions) {
    self.actions = actions
    // Drawn before anything can fail, so a broken setup is still visible and
    // still quittable rather than an app with no way in.
    self.item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    super.init()
    render()
  }

  // MARK: what it is told

  func set(mode: String) {
    self.mode = mode
    render()
  }

  func set(status: String?) {
    self.status = status
    render()
  }

  func set(failure: String?) {
    self.failure = failure
    render()
  }

  /// One line of conversation, so a whole exchange can happen with the window
  /// closed and still leave something to look at.
  func append(who: String, text: String) {
    recent.append((who: who, text: text))
    if recent.count > 6 { recent.removeFirst(recent.count - 6) }
    render()
  }

  func clearConversation() {
    recent = []
    render()
  }

  // MARK: drawing

  private func render() {
    let symbol = menuBarSymbol(mode: mode, status: status, failed: failure != nil)
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Falcon")
    image?.isTemplate = true
    item.button?.image = image
    item.menu = buildMenu()
  }

  private func buildMenu() -> NSMenu {
    let menu = NSMenu()

    if let failure {
      let problem = NSMenuItem(title: failure, action: nil, keyEquivalent: "")
      problem.isEnabled = false
      menu.addItem(problem)
      menu.addItem(.separator())
      add(to: menu, "Open Log", #selector(openLog))
      add(to: menu, "Quit Falcon", #selector(quit), key: "q")
      return menu
    }

    if recent.isEmpty {
      let empty = NSMenuItem(title: "Nothing said yet", action: nil, keyEquivalent: "")
      empty.isEnabled = false
      menu.addItem(empty)
    } else {
      for line in recent {
        let trimmed = line.text.count > 60 ? String(line.text.prefix(59)) + "…" : line.text
        let entry = NSMenuItem(title: "\(line.who == "you" ? "you" : "falcon")   \(trimmed)",
                               action: nil, keyEquivalent: "")
        entry.isEnabled = false
        menu.addItem(entry)
      }
    }
    menu.addItem(.separator())

    add(to: menu, "Open Window", #selector(openWindow), key: "o")
    menu.addItem(.separator())

    for (title, command) in [("Discuss", "chat"), ("Take Notes", "note"), ("Sleep", "stop")] {
      let entry = NSMenuItem(title: title, action: #selector(setModeFromItem(_:)), keyEquivalent: "")
      entry.representedObject = command
      entry.target = self
      menu.addItem(entry)
    }

    menu.addItem(.separator())
    add(to: menu, "Open Project Folder", #selector(openProject))
    // Everything the terminal surface would have told you. Without this the app
    // is the only surface that cannot explain itself.
    add(to: menu, "Open Log", #selector(openLog))

    let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    login.target = self
    menu.addItem(login)

    menu.addItem(.separator())
    add(to: menu, "Quit Falcon", #selector(quit), key: "q")
    return menu
  }

  private func add(to menu: NSMenu, _ title: String, _ action: Selector, key: String = "") {
    menu.addItem(withTitle: title, action: action, keyEquivalent: key).target = self
  }

  // MARK: dispatch

  @objc private func openWindow() { actions.openWindow() }
  @objc private func openProject() { actions.openProject() }
  @objc private func openLog() { actions.openLog() }
  @objc private func quit() { actions.quit() }

  @objc private func toggleLogin() {
    actions.toggleLogin()
    render()   // the checkmark reflects state this does not own
  }

  @objc private func setModeFromItem(_ sender: NSMenuItem) {
    guard let command = sender.representedObject as? String else { return }
    actions.setMode(command)
  }
}
