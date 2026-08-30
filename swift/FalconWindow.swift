// The window: a WKWebView pointed at the local server.
//
// Deliberately not Electron. It is a few hundred kilobytes of AppKit that ships
// with the machine, so install.sh does not have to download a second browser
// runtime, and it looks like a Mac app because it is one.
//
// It renders and nothing else. All audio stays in VoiceIO — the voice
// processing unit only cancels echo from audio rendered through its own engine,
// so a second process making sound would make the app interrupt itself.
//
// Compiled into both bin/falcon and bin/falcon-window. Two copies of this file
// is what the app and the old VoiceApp.swift were, and they had already drifted
// apart on the background colour while sharing one frame autosave name.

import AppKit
import WebKit

final class FalconWindow: NSObject, WKNavigationDelegate {
  private var window: NSWindow?
  private var web: WKWebView?
  /// What the window is currently showing, so a session republished while it
  /// was closed is noticed rather than left on a dead token.
  private var loadedURL: URL?
  private let fullScreen: Bool

  /// - Parameter fullScreen: enter full screen the first time it is shown. Only
  ///   the standalone shell passes true — the app never takes the display
  ///   uninvited, because it starts at login and that is when you can least
  ///   afford it to.
  init(fullScreen: Bool = false) {
    self.fullScreen = fullScreen
  }

  var isVisible: Bool { window?.isVisible ?? false }

  /// Creates the window or brings it forward, pointed at `session`.
  func show(session: URL) {
    if let window {
      // Reopened, not rebuilt — so this is also the moment to notice that the
      // session it is showing died while it was closed.
      point(at: session)
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    let config = WKWebViewConfiguration()
    // Nothing is persisted: the conversation lives in the orchestrator, and a
    // window that remembers nothing cannot show a stale one.
    config.websiteDataStore = .nonPersistent()
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.setValue(false, forKey: "drawsBackground")
    self.web = web

    let created = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 700),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    created.title = "Falcon"
    created.titlebarAppearsTransparent = true
    created.titleVisibility = .hidden
    // The ground the page paints, so the half-second before the first frame is
    // the same colour as the page rather than a flash of something else.
    created.backgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1)
    created.appearance = NSAppearance(named: .darkAqua)
    created.minSize = NSSize(width: 480, height: 420)
    // Without this the green button zooms instead of going full screen, and
    // toggleFullScreen below does nothing at all.
    created.collectionBehavior.insert(.fullScreenPrimary)
    created.contentView = web
    created.center()
    created.setFrameAutosaveName("falcon")
    // Closing puts it away; it is reopened rather than rebuilt.
    created.isReleasedWhenClosed = false
    window = created

    point(at: session)
    created.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    if fullScreen {
      // After activation, not before: a window that is not yet key slides into
      // its Space without taking focus, and you land on an empty desktop with
      // the app full screen somewhere to the right.
      created.toggleFullScreen(nil)
    }
  }

  func hide() {
    window?.orderOut(nil)
  }

  /// Loads the session, if it is not the one already loaded.
  ///
  /// The url carries the token that authorises every request the page makes,
  /// and node mints a fresh one each time it starts. A window that outlives a
  /// restart therefore holds a dead session: /events answers 403, EventSource
  /// treats any non-200 as fatal and never retries, and the page freezes on
  /// whatever it last saw with nothing on screen to say why.
  private func point(at session: URL) {
    guard shouldReloadWindow(loaded: loadedURL, current: session) else { return }
    loadedURL = session
    web?.load(URLRequest(url: session))
  }

  // The page is served from loopback and is the only thing allowed to load.
  // Anything else — a stray link, an injected redirect — opens in the real
  // browser instead of taking over the window.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let target = navigationAction.request.url, let loaded = loadedURL else {
      decisionHandler(.cancel)
      return
    }
    if target.host == loaded.host && target.port == loaded.port {
      decisionHandler(.allow)
    } else {
      decisionHandler(.cancel)
      NSWorkspace.shared.open(target)
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    FileHandle.standardError.write("falcon-window: \(error.localizedDescription)\n".data(using: .utf8)!)
  }
}
