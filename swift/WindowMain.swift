// bin/falcon-window — the window on its own, for `npm run app`.
//
// The app has its own FalconWindow and does not use this binary. This exists so
// the node-first workflow still has something to look at without installing the
// bundle, and it is a shell rather than an implementation: the window itself is
// FalconWindow.swift, compiled into both.

import AppKit

/// Full screen at launch, unless told otherwise.
///
/// Opt-out rather than opt-in because this is what the standalone window is
/// for — an ambient display on a spare screen. FALCON_FULLSCREEN=0 is the way
/// back out of a machine that boots into a screen you did not want.
func wantsFullScreen() -> Bool {
  let flag = ProcessInfo.processInfo.environment["FALCON_FULLSCREEN"]
  return !(flag == "0" || flag == "false" || flag == "no")
}

final class WindowOnly: NSObject, NSApplicationDelegate {
  private let window: FalconWindow
  private let session: URL

  init(session: URL) {
    self.session = session
    self.window = FalconWindow(fullScreen: wantsFullScreen())
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    window.show(session: session)
  }

  // Closing the window ends this process; the orchestrator that launched it
  // decides whether that also ends the session. The app proper does the
  // opposite — see applicationShouldTerminateAfterLastWindowClosed there.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

@main
struct FalconWindowMain {
  static func main() {
    // An explicit argument still wins, so the window can be pointed at a
    // session by hand while debugging.
    let given = CommandLine.arguments.count > 1 ? URL(string: CommandLine.arguments[1]) : nil
    guard let session = given ?? sessionURLOnDisk() else {
      FileHandle.standardError.write(
        "falcon-window: no session — start Falcon first, or pass a url\n".data(using: .utf8)!)
      exit(2)
    }

    let app = NSApplication.shared
    // Held for the process lifetime; NSApplication does not retain its delegate.
    let delegate = WindowOnly(session: session)
    app.delegate = delegate
    // A menu bar is what makes cmd-Q, cmd-W and copy/paste work at all in a
    // bare AppKit process. No target, so it carries no session commands: this
    // binary is a window and has nothing to command.
    app.mainMenu = falconMainMenu()
    app.run()
  }
}
