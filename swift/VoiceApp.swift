// The desktop window: a WKWebView pointed at the local server.
//
// Deliberately not Electron. The window is a few hundred kilobytes of AppKit
// that ships with the machine, so `install.sh` does not have to download a
// second browser runtime, and it looks like a Mac app because it is one.
//
// It renders and nothing else. All audio stays in VoiceIO — the voice-processing
// unit only cancels echo from audio rendered through its own engine, so a second
// process making sound would make it interrupt itself.

import AppKit
import WebKit

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  let url: URL
  var window: NSWindow!
  var web: WKWebView!

  init(url: URL) {
    self.url = url
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let config = WKWebViewConfiguration()
    // Nothing is persisted: the conversation lives in the orchestrator, and a
    // window that remembers nothing cannot show a stale one.
    config.websiteDataStore = .nonPersistent()

    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.setValue(false, forKey: "drawsBackground")

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 700),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "opus voice"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.backgroundColor = NSColor(red: 0.051, green: 0.055, blue: 0.067, alpha: 1)
    window.appearance = NSAppearance(named: .darkAqua)
    window.minSize = NSSize(width: 480, height: 420)
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("opus-voice")
    window.makeKeyAndOrderFront(nil)

    web.load(URLRequest(url: url))

    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }

  // Closing the window ends the app; the orchestrator that launched it decides
  // whether that also ends the session.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  // The page is served from loopback and is the only thing allowed to load.
  // Anything else — a stray link, an injected redirect — opens in the real
  // browser instead of taking over the window.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let target = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if target.host == url.host && target.port == url.port {
      decisionHandler(.allow)
    } else {
      decisionHandler(.cancel)
      NSWorkspace.shared.open(target)
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    FileHandle.standardError.write("voiceapp: \(error.localizedDescription)\n".data(using: .utf8)!)
  }
}

let arguments = CommandLine.arguments
guard arguments.count > 1, let target = URL(string: arguments[1]) else {
  FileHandle.standardError.write("usage: voiceapp <url>\n".data(using: .utf8)!)
  exit(2)
}

let app = NSApplication.shared
let delegate = Delegate(url: target)
app.delegate = delegate

// A menu bar is what makes cmd-Q, cmd-W and copy/paste work at all in a bare
// AppKit process.
let menu = NSMenu()
let appItem = NSMenuItem()
menu.addItem(appItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "Hide opus voice", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
appMenu.addItem(withTitle: "Quit opus voice", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu

let editItem = NSMenuItem()
menu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu

app.mainMenu = menu
app.run()
