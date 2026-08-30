# Falcon Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Falcon from a menu bar utility into a real Mac app — dock icon, main menu, a window that is the primary surface, and a headphone squeeze that summons it as well as waking the session.

**Architecture:** `FalconApp.swift` (374 lines, five jobs) splits into a coordinator plus `StatusItem`, `FalconWindow`, `SessionClient` and `AppLaunch`. `FalconWindow.swift` is compiled into *both* `bin/falcon` and `bin/falcon-window`, which deletes `VoiceApp.swift`'s duplicate window without breaking `npm run app`. `RemoteCommands` stops writing files and becomes a gesture recogniser whose meaning the app supplies.

**Tech Stack:** Swift 5 / AppKit / WebKit / MediaPlayer / ServiceManagement, compiled with `swiftc` directly (no SPM, no XCTest). Node 26 for the orchestrator. CoreGraphics + `iconutil` for the icon.

**Spec:** `docs/superpowers/specs/2026-08-30-falcon-desktop-app-design.md`

## Global Constraints

- **macOS 13.0 minimum** (`LSMinimumSystemVersion` in `scripts/bundle.sh`).
- **No new dependencies.** No SPM manifest, no XCTest, no package manager. Tests are plain functions compiled by `scripts/test-swift.sh` and dispatched from `swift/TestMain.swift`.
- **The bundle identifier stays `local.falcon.app`.** Changing it resets the microphone and speech-recognition grants.
- **No node behaviour changes.** The only node edit in this plan is one path constant in `src/index.mjs` (`bin/voiceapp` → `bin/falcon-window`). The full node suite must stay green *without modification* — a red node test means something was broken that this work had no business touching.
- **The window's frame autosave name is `falcon`** and must stay that string, or everyone's saved window position is lost.
- **Comment style:** this codebase explains *why*, and names the bug a branch exists to prevent. Match it. Do not add comments that restate the code.
- **Run `npm test` before every commit.** It runs the node suite and `scripts/test-swift.sh`.

---

### Task 1: Pure launch decisions

`AppLaunch.swift` holds decisions the app delegate makes at launch, kept pure so they can be tested without a run loop — the same reason `MenuBarState.swift` exists.

**Files:**
- Create: `swift/AppLaunch.swift`
- Create: `swift/AppLaunchTests.swift`
- Modify: `swift/TestMain.swift`
- Modify: `scripts/test-swift.sh`

**Interfaces:**
- Consumes: nothing
- Produces: `func shouldOpenWindowAtLaunch(isDefaultLaunch: Bool) -> Bool`, `func runAppLaunchTests() -> Int`

- [ ] **Step 1: Write the failing test**

Create `swift/AppLaunchTests.swift`:

```swift
// swift/AppLaunchTests.swift
// Compiled together with AppLaunch.swift by scripts/test-swift.sh.
//
// A function rather than top-level code: Swift only allows statements at file
// scope in main.swift, so every test file hands its work to swift/TestMain.swift.

func runAppLaunchTests() -> Int {
  var failures = 0

  func expect(_ actual: Bool, _ wanted: Bool, _ what: String) {
    if actual != wanted {
      print("  ✗ \(what): got \(actual), wanted \(wanted)")
      failures += 1
    }
  }

  // Somebody double-clicked it, or picked it out of Spotlight. They want to see
  // something.
  expect(shouldOpenWindowAtLaunch(isDefaultLaunch: true), true, "a person opened it")

  // The login item. The app comes up with the machine, and a window nobody
  // asked for landing on a fresh desktop every morning is the behaviour this
  // whole check exists to prevent.
  expect(shouldOpenWindowAtLaunch(isDefaultLaunch: false), false, "the system opened it")

  if failures == 0 { print("  ✓ launch decisions") }
  return failures
}
```

- [ ] **Step 2: Add it to the test harness**

In `swift/TestMain.swift`, add the call to the sum:

```swift
    let failures = runMenuBarStateTests() + runEnvironmentTests() + runUtteranceTests() + runTurnAssemblerTests() + runUtteranceBufferTests() + runAppLaunchTests()
```

In `scripts/test-swift.sh`, add the pair to the `swiftc` invocation, before `swift/TestMain.swift`:

```bash
  swift/AppLaunch.swift swift/AppLaunchTests.swift \
```

- [ ] **Step 3: Run it to verify it fails**

Run: `./scripts/test-swift.sh`
Expected: FAIL — `cannot find 'shouldOpenWindowAtLaunch' in scope`

- [ ] **Step 4: Write the implementation**

Create `swift/AppLaunch.swift`:

```swift
// Decisions the app makes at launch, kept away from the delegate that acts on
// them.
//
// Split out for the same reason MenuBarState.swift is: these are the parts of
// starting up that are a choice rather than a side effect, and a choice can be
// tested without a run loop, a window, or a login.

import Foundation

/// Whether this launch should put a window on screen.
///
/// macOS tells an app who started it: `NSApplication.launchIsDefaultLaunchKey`
/// is false when the system did, which is what a login item is.
///
/// A login launch must not open a window. Falcon comes up with the machine so
/// it is there when spoken to, and a window nobody asked for landing on a fresh
/// desktop every morning is the opposite of that. Somebody double-clicking the
/// icon means exactly the reverse, and gets a window.
func shouldOpenWindowAtLaunch(isDefaultLaunch: Bool) -> Bool {
  isDefaultLaunch
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `./scripts/test-swift.sh`
Expected: PASS, including `✓ launch decisions`

- [ ] **Step 6: Commit**

```bash
git add swift/AppLaunch.swift swift/AppLaunchTests.swift swift/TestMain.swift scripts/test-swift.sh
git commit -m "Decide at launch whether anyone asked to see a window"
```

---

### Task 2: The squeeze becomes a gesture recogniser

`RemoteCommandWatcher` currently recognises the gesture *and* decides what it means — `poke()` writes `~/.falcon/wake` itself. Splitting those makes the recognition testable (the audit noted it isn't) and gives the app somewhere to add the summon in Task 6.

**Files:**
- Modify: `swift/RemoteCommands.swift`
- Create: `swift/RemoteCommandsTests.swift`
- Modify: `swift/FalconApp.swift` (the one call site)
- Modify: `swift/TestMain.swift`
- Modify: `scripts/test-swift.sh`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `enum WakeGesture: String { case playPause, next, previous }` with `static func named(_ raw: String?) -> WakeGesture` (unchanged)
  - `func gesture(forCommand name: String) -> WakeGesture?` — maps an AVRCP command name (`"toggle"`, `"play"`, `"pause"`, `"next"`, `"previous"`) to the gesture it represents, or nil
  - `RemoteCommandWatcher.init(gesture:forwardToPlayer:onWake:onLog:)` where `onWake: @escaping () -> Void`
  - `func runRemoteCommandsTests() -> Int`

- [ ] **Step 1: Write the failing test**

Create `swift/RemoteCommandsTests.swift`:

```swift
// swift/RemoteCommandsTests.swift
// The gesture half of the headphone wake, which is a pure mapping and so can
// be tested without headphones, a Bluetooth stack, or the Now Playing role.

func runRemoteCommandsTests() -> Int {
  var failures = 0

  func expect(_ actual: WakeGesture?, _ wanted: WakeGesture?, _ what: String) {
    if actual != wanted {
      print("  ✗ \(what): got \(String(describing: actual)), wanted \(String(describing: wanted))")
      failures += 1
    }
  }

  // Which squeeze sends which command differs by model and by what is set in
  // Bluetooth settings, so all three of these arrive as "one squeeze".
  expect(gesture(forCommand: "toggle"), .playPause, "toggle is one squeeze")
  expect(gesture(forCommand: "play"), .playPause, "play is one squeeze")
  expect(gesture(forCommand: "pause"), .playPause, "pause is one squeeze")
  expect(gesture(forCommand: "next"), .next, "next is two squeezes")
  expect(gesture(forCommand: "previous"), .previous, "previous is three squeezes")

  // Anything else is a command we registered for but do not bind, and must not
  // resolve to a gesture — least of all to the default one.
  expect(gesture(forCommand: "seekForward"), nil, "an unbound command is not a gesture")
  expect(gesture(forCommand: ""), nil, "an empty command is not a gesture")

  func expectNamed(_ raw: String?, _ wanted: WakeGesture, _ what: String) {
    if WakeGesture.named(raw) != wanted {
      print("  ✗ \(what): got \(WakeGesture.named(raw)), wanted \(wanted)")
      failures += 1
    }
  }

  expectNamed("playPause", .playPause, "playPause by name")
  expectNamed("next", .next, "next by name")
  expectNamed("previous", .previous, "previous by name")
  // A typo in config.json must leave the gesture working rather than binding
  // nothing at all, so it falls back to the common case.
  expectNamed("nxt", .playPause, "an unknown name falls back")
  expectNamed(nil, .playPause, "an absent setting falls back")

  if failures == 0 { print("  ✓ headphone gesture mapping") }
  return failures
}
```

- [ ] **Step 2: Add it to the test harness**

In `swift/TestMain.swift` add `+ runRemoteCommandsTests()` to the sum.

In `scripts/test-swift.sh` add before `swift/TestMain.swift`:

```bash
  swift/RemoteCommands.swift swift/RemoteCommandsTests.swift \
```

Note: `RemoteCommands.swift` imports AppKit and MediaPlayer, which the test binary links by default on macOS — no extra `-framework` flag is needed for `swiftc` here.

- [ ] **Step 3: Run it to verify it fails**

Run: `./scripts/test-swift.sh`
Expected: FAIL — `cannot find 'gesture' in scope`

- [ ] **Step 4: Extract the mapping and the file write**

In `swift/RemoteCommands.swift`, add the free function after the `WakeGesture` enum:

```swift
/// The gesture an AVRCP command represents, or nil if it is one we listen for
/// but do not bind.
///
/// Kept as a mapping rather than a switch inside the handler so it can be
/// tested: everything else in this file needs a Bluetooth stack and the Now
/// Playing role to exercise at all.
func gesture(forCommand name: String) -> WakeGesture? {
  switch name {
  case "toggle", "play", "pause": return .playPause
  case "next": return .next
  case "previous": return .previous
  default: return nil
  }
}
```

Change the initializer to take `onWake` and drop the wake-file knowledge. Replace the stored properties and `init`:

```swift
final class RemoteCommandWatcher {
  private let gesture: WakeGesture
  private let forwardToPlayer: Bool
  private let onWake: () -> Void
  private let onLog: (String) -> Void

  init(gesture: WakeGesture,
       forwardToPlayer: Bool,
       onWake: @escaping () -> Void,
       onLog: @escaping (String) -> Void) {
    self.gesture = gesture
    self.forwardToPlayer = forwardToPlayer
    self.onWake = onWake
    self.onLog = onLog
  }
```

Delete the `wakeFile` computed property and the whole `poke()` method. In `register(_:as:named:)`, replace the body's gesture comparison and call:

```swift
  private func register(_ command: MPRemoteCommand, named: String) {
    command.isEnabled = true
    command.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      // Every command is logged, not just the bound one, because which squeeze
      // sends which command differs by model and by the settings in Bluetooth.
      self.onLog("headphone command: \(named)")
      if gesture(forCommand: named) == self.gesture {
        self.onWake()
      }
      if self.forwardToPlayer {
        self.forward(named)
      }
      return .success
    }
  }
```

Update the five `register` calls in `start()` to drop the now-unused `as:` argument:

```swift
    register(center.togglePlayPauseCommand, named: "toggle")
    register(center.playCommand, named: "play")
    register(center.pauseCommand, named: "pause")
    register(center.nextTrackCommand, named: "next")
    register(center.previousTrackCommand, named: "previous")
```

- [ ] **Step 5: Move the meaning into the app**

In `swift/FalconApp.swift`, add the file write that `poke()` used to do, and pass it as `onWake`. Replace `startHeadphoneWake(launch:)`:

```swift
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
```

- [ ] **Step 6: Run the tests and build**

Run: `npm test && ./build.sh`
Expected: all node tests pass, `✓ headphone gesture mapping` appears, and all three binaries build.

- [ ] **Step 7: Commit**

```bash
git add swift/RemoteCommands.swift swift/RemoteCommandsTests.swift swift/FalconApp.swift swift/TestMain.swift scripts/test-swift.sh
git commit -m "Let the watcher recognise the squeeze and the app decide what it means"
```

---

### Task 3: One window, compiled into both binaries

The window exists twice: inline in `FalconApp.swift` and again in `VoiceApp.swift`, both using the `falcon` frame autosave name. This extracts one implementation and deletes the other.

**Files:**
- Create: `swift/FalconWindow.swift`
- Create: `swift/WindowMain.swift`
- Delete: `swift/VoiceApp.swift`
- Modify: `swift/Environment.swift` (gains `sessionURLOnDisk()`)
- Modify: `swift/FalconApp.swift` (uses `FalconWindow`, loses its inline window)
- Modify: `build.sh`
- Modify: `src/index.mjs:785,795` (the binary's new name)
- Modify: `README.md:393`

**Interfaces:**
- Consumes: nothing from Tasks 1–2
- Produces:
  - `func sessionURLOnDisk() -> URL?` in `Environment.swift`
  - `final class FalconWindow: NSObject, WKNavigationDelegate` with `init(fullScreen: Bool = false)`, `func show(session: URL)`, `func hide()`, `var isVisible: Bool`

- [ ] **Step 1: Move the session-file reader into Environment.swift**

Append to `swift/Environment.swift`:

```swift
/// Where the running session says it can be reached.
///
/// Read from a 0600 file rather than taken as an argument, because the URL
/// carries the token that authorises commands, and argv is world-readable: any
/// process on the machine can lift it out of `ps`.
func sessionURLOnDisk() -> URL? {
  let file = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".falcon/session.json")
  guard
    let data = try? Data(contentsOf: file),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let text = json["url"] as? String
  else { return nil }
  return URL(string: text)
}
```

Delete the `static func sessionURLOnDisk()` from `swift/FalconApp.swift` and change its two call sites from `Self.sessionURLOnDisk()` to `sessionURLOnDisk()`.

- [ ] **Step 2: Write the window**

Create `swift/FalconWindow.swift`:

```swift
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
// is what the old VoiceApp.swift was, and they drifted.

import AppKit
import WebKit

final class FalconWindow: NSObject, WKNavigationDelegate {
  private var window: NSWindow?
  private var web: WKWebView?
  /// What the window is currently showing, so a session that was republished
  /// while it was closed is noticed rather than left on a dead token.
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
    // the same colour as the page rather than a flash of grey.
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
  /// restart holds a dead session: /events answers 403, EventSource treats any
  /// non-200 as fatal and never retries, and the page freezes on whatever it
  /// last saw with nothing on screen to say why.
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
```

- [ ] **Step 3: Write the standalone shell and delete the duplicate**

Create `swift/WindowMain.swift`:

```swift
// bin/falcon-window — the window on its own, for `npm run app`.
//
// The app has its own copy of this window and does not use this binary. It
// exists so the node-first workflow still has something to look at without
// installing the bundle, and it is a shell rather than an implementation: the
// window itself is FalconWindow.swift, compiled into both.

import AppKit

/// Full screen at launch, unless told otherwise.
///
/// Opt-out rather than opt-in because this is what the standalone window is
/// for — an ambient display on a spare screen. FALCON_FULLSCREEN=0 is the way
/// back out.
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
  // decides whether that also ends the session.
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
    app.mainMenu = falconMainMenu()
    app.run()
  }
}
```

> `falconMainMenu()` is built in Task 5. Until then, replace that line with
> `app.mainMenu = nil` and revisit it in Task 5 Step 4. Do not leave it calling
> a function that does not exist.

Delete the old file:

```bash
git rm swift/VoiceApp.swift
```

- [ ] **Step 4: Use the window from the app**

In `swift/FalconApp.swift`: delete the `window`, `web` and `loadedURL` stored properties and replace them with one:

```swift
  private let window = FalconWindow()
```

Delete the whole body of `openWindow()` and `showSession()` and replace with:

```swift
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

  /// Points an open window at the current session. A closed one is left closed:
  /// a session restarting is not a reason to put a window on somebody's screen.
  private func showSession() {
    guard window.isVisible, let url = orchestrator?.sessionURL ?? sessionURLOnDisk() else { return }
    window.show(session: url)
  }
```

- [ ] **Step 5: Rename the binary everywhere it is named**

In `build.sh`, replace the `voiceapp` block:

```bash
# The window on its own, for `npm run app`. Separate binary because it is
# optional: the terminal UI works without it, so a failure here must not stop
# the audio daemon shipping.
echo "building falcon-window…"
if swiftc -O \
  -o bin/falcon-window \
  swift/FalconWindow.swift \
  swift/Environment.swift \
  swift/WindowMain.swift \
  -framework AppKit \
  -framework WebKit; then
  codesign --force --sign - bin/falcon-window 2>/dev/null || true
  echo "built bin/falcon-window"
else
  echo "note: falcon-window did not build — 'npm start' still works, 'npm run app' will open your browser"
fi
```

Add `swift/FalconWindow.swift` and `swift/AppLaunch.swift` to the `bin/falcon` build's file list.

In `src/index.mjs`, change both references:

```js
  const binary = path.join(ROOT, 'bin/falcon-window');
```

```js
    view.warn('bin/falcon-window is not built — opening in your browser instead');
```

In `README.md:393`, change `**`bin/voiceapp`**` to `**`bin/falcon-window`**`.

- [ ] **Step 6: Build and test**

Run: `./build.sh && npm test`
Expected: `built bin/falcon-window`, `built bin/falcon`, all tests pass.

Run: `ls bin/` and confirm `voiceapp` is gone (delete it if the old artifact is still there: `rm -f bin/voiceapp`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Build one window and compile it into both binaries"
```

---

### Task 4: FalconApp becomes a coordinator

Pure refactor, no behaviour change. `FalconApp.swift` is carrying the status item and the event stream inline; Task 5 adds a main menu and dock handling on top, and that should land in a file that has room for it.

**Files:**
- Create: `swift/StatusItem.swift`
- Create: `swift/SessionClient.swift`
- Modify: `swift/FalconApp.swift`
- Modify: `build.sh`

**Interfaces:**
- Consumes: `FalconWindow` (Task 3)
- Produces:
  - `final class SessionClient` — `init(onChange: @escaping (String, String?) -> Void, onEntry: @escaping (String, String) -> Void)`, `func follow(session: URL)`, `func stop()`, `func post(_ body: [String: String], to session: URL)`
  - `final class StatusItem` — `init(onCommand: @escaping (String) -> Void, actions: StatusItem.Actions)`, `func render(mode: String, status: String?, failure: String?, recent: [(who: String, text: String)])`

- [ ] **Step 1: Extract the event stream**

Create `swift/SessionClient.swift` holding, moved verbatim from `FalconApp.swift`: the `stream` task, `listen()`, `absorb(_:)`, and `post(_:)`. It reports upward through the two closures rather than touching UI:

```swift
// The session, as the app sees it.
//
// Follows the same server-sent events the window does, so the menu bar reflects
// what actually happened rather than what it last asked for — the same reason
// src/view.mjs exists on the node side.

import Foundation

final class SessionClient {
  /// Mode, and the current status if there is one.
  private let onChange: (String, String?) -> Void
  /// One line of conversation: who said it, and what.
  private let onEntry: (String, String) -> Void
  private var stream: Task<Void, Never>?

  init(onChange: @escaping (String, String?) -> Void,
       onEntry: @escaping (String, String) -> Void) {
    self.onChange = onChange
    self.onEntry = onEntry
  }
  ...
}
```

Move the body of `listen()` in unchanged apart from calling `onChange` / `onEntry` instead of assigning to `self.mode` and `self.recent`, and `post(_:)` in unchanged apart from taking the session URL as a parameter rather than reading `orchestrator?.sessionURL`.

Keep the comment about a dropped connection not being worth surfacing, and the one about `entries` versus `entry`.

- [ ] **Step 2: Extract the status item**

Create `swift/StatusItem.swift` holding the `NSStatusItem`, `render()` and `buildMenu()` moved from `FalconApp.swift`, plus the `@objc` targets for its own menu items. Its `Actions` struct carries the closures the app supplies:

```swift
struct Actions {
  let openWindow: () -> Void
  let openProject: () -> Void
  let openLog: () -> Void
  let toggleLogin: () -> Void
  let quit: () -> Void
}
```

The menu keeps exactly the items it has today: the recent lines, Open Window, the three modes, Open Project Folder, Open Log, Start at Login, Quit — and the failure-only variant that shows the problem, Open Log and Quit.

- [ ] **Step 3: Reduce the delegate**

`FalconApp.swift` keeps only: the stored properties (`orchestrator`, `launchProblem`, `window`, `headphones`, `statusItem`, `session`, and the `mode` / `status` / `recent` state the status item is rendered from), `applicationDidFinishLaunching`, `applicationWillTerminate`, `sessionChanged`, `openWindow`, `showSession`, `startHeadphoneWake`, `wokenByGesture`, `pokeWakeFile`, `appendToLog`, `registerLoginItemOnce`, and the `@main` entry point.

- [ ] **Step 4: Add the new files to the build**

In `build.sh`, add to the `bin/falcon` file list:

```bash
  swift/StatusItem.swift \
  swift/SessionClient.swift \
```

- [ ] **Step 5: Build, test, and check nothing moved**

Run: `./build.sh && npm test`
Expected: everything builds and passes.

Run: `./scripts/bundle.sh && open -a Falcon`
Expected: identical behaviour to before this task — menu bar item appears, its menu works, Open Window shows the session. Quit from the menu when done.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Split the app into the parts it was already made of"
```

---

### Task 5: A real app

**Files:**
- Create: `swift/MainMenu.swift`
- Modify: `swift/FalconApp.swift`
- Modify: `swift/WindowMain.swift` (the deferred `falconMainMenu()` from Task 3)
- Modify: `scripts/bundle.sh`
- Modify: `build.sh`

**Interfaces:**
- Consumes: `shouldOpenWindowAtLaunch` (Task 1), `FalconWindow` (Task 3), `SessionClient.post` (Task 4)
- Produces: `func falconMainMenu(target: AnyObject?) -> NSMenu`

- [ ] **Step 1: Stop being an accessory**

In `scripts/bundle.sh`, delete these two lines from the plist heredoc:

```
  <!-- Menu bar only: no dock icon, no window until one is asked for. -->
  <key>LSUIElement</key><true/>
```

In `swift/FalconApp.swift`, delete this line from `applicationDidFinishLaunching`:

```swift
    NSApp.setActivationPolicy(.accessory)   // menu bar only, no dock icon
```

A regular app is the default; nothing replaces it.

- [ ] **Step 2: Open a window only when a person asked**

At the end of `applicationDidFinishLaunching`, add:

```swift
    // Who started this. The system did, for a login item — and a window nobody
    // asked for landing on a fresh desktop every morning is exactly what the
    // login-item behaviour must not be.
    let isDefaultLaunch = notification.userInfo?[NSApplication.launchIsDefaultLaunchKey] as? Bool ?? true
    if shouldOpenWindowAtLaunch(isDefaultLaunch: isDefaultLaunch) {
      // The session needs a moment to bind a port; openWindow falls back to the
      // file on disk and explains itself if there is nothing to show yet.
      openWindow()
    }
```

Nothing else in launch calls `NSApp.activate` — a regular app that steals focus at login is worse than one that does not appear.

- [ ] **Step 3: Close hides, the dock icon reopens**

Add to `FalconApp.swift`:

```swift
  /// Closing the window puts Falcon away; it does not stop it.
  ///
  /// The session keeps running and keeps listening, which is the whole point of
  /// something you talk to. Quit is ⌘Q or the menu bar's Quit — a deliberate
  /// act, not a side effect of tidying your screen.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  /// Clicking the dock icon with no window open opens one. Without this it does
  /// nothing at all, which people report as the app being broken.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { openWindow() }
    return true
  }
```

- [ ] **Step 4: Build the main menu**

Create `swift/MainMenu.swift`:

```swift
// The menu bar along the top of the screen.
//
// An accessory app has none and does not need one. A regular app does — and not
// only for form: without an Edit menu the webview's text fields have no working
// Cut, Copy or Paste, because those are menu commands before they are anything
// else.
//
// Every conversation command posts the same thing the window's buttons post, so
// a menu item and a click are one instruction arriving by different routes.

import AppKit

/// - Parameter target: receives the conversation and session actions. Passing
///   nil builds a menu with only the standard AppKit responders wired, which is
///   what the standalone window binary wants.
func falconMainMenu(target: AnyObject? = nil) -> NSMenu {
  let menu = NSMenu()

  let appItem = NSMenuItem()
  menu.addItem(appItem)
  let app = NSMenu()
  app.addItem(withTitle: "About Falcon",
              action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
  app.addItem(.separator())
  if let target {
    let login = NSMenuItem(title: "Start at Login",
                           action: NSSelectorFromString("toggleLogin"), keyEquivalent: "")
    login.target = target
    app.addItem(login)
    app.addItem(.separator())
  }
  app.addItem(withTitle: "Hide Falcon", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
  let hideOthers = NSMenuItem(title: "Hide Others",
                              action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
  hideOthers.keyEquivalentModifierMask = [.command, .option]
  app.addItem(hideOthers)
  app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
  app.addItem(.separator())
  app.addItem(withTitle: "Quit Falcon", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
  appItem.submenu = app

  let editItem = NSMenuItem()
  menu.addItem(editItem)
  let edit = NSMenu(title: "Edit")
  edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
  edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
  edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
  edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
  editItem.submenu = edit

  if let target {
    let talkItem = NSMenuItem()
    menu.addItem(talkItem)
    let talk = NSMenu(title: "Conversation")
    for (title, command, key) in [
      ("Discuss", "chat", "d"),
      ("Take Notes", "note", "n"),
      ("Sleep", "stop", ""),
    ] {
      let item = NSMenuItem(title: title, action: NSSelectorFromString("setModeFromMenu:"), keyEquivalent: key)
      item.representedObject = command
      item.target = target
      talk.addItem(item)
    }
    talk.addItem(.separator())
    let interrupt = NSMenuItem(title: "Interrupt",
                               action: NSSelectorFromString("interruptFromMenu"), keyEquivalent: ".")
    interrupt.target = target
    talk.addItem(interrupt)
    talkItem.submenu = talk

    let sessionItem = NSMenuItem()
    menu.addItem(sessionItem)
    let session = NSMenu(title: "Session")
    for (title, selector) in [
      ("Open Project Folder", "openProject"),
      ("Open Log", "openLog"),
    ] {
      let item = NSMenuItem(title: title, action: NSSelectorFromString(selector), keyEquivalent: "")
      item.target = target
      session.addItem(item)
    }
    sessionItem.submenu = session
  }

  let windowItem = NSMenuItem()
  menu.addItem(windowItem)
  let windows = NSMenu(title: "Window")
  windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
  windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
  windows.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
  windows.addItem(.separator())
  windows.addItem(withTitle: "Bring All to Front",
                  action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
  windowItem.submenu = windows
  NSApp.windowsMenu = windows

  return menu
}
```

In `FalconApp.swift`, set it in `applicationDidFinishLaunching` before anything else, and add the two `@objc` targets the menu names:

```swift
    NSApp.mainMenu = falconMainMenu(target: self)
```

```swift
  @objc private func setModeFromMenu(_ sender: NSMenuItem) {
    guard let command = sender.representedObject as? String else { return }
    guard let url = orchestrator?.sessionURL else { return }
    session.post(["cmd": "mode", "mode": command], to: url)
  }

  @objc private func interruptFromMenu() {
    guard let url = orchestrator?.sessionURL else { return }
    session.post(["cmd": "interrupt"], to: url)
  }
```

`toggleLogin`, `openProject` and `openLog` already exist as `@objc` methods from Task 4; change them from `private` to internal so `NSSelectorFromString` can reach them, or mark them `@objc` explicitly if they are not already.

In `swift/WindowMain.swift`, replace the placeholder from Task 3 Step 3 with:

```swift
    app.mainMenu = falconMainMenu()
```

Add `swift/MainMenu.swift` to both binaries' file lists in `build.sh`.

- [ ] **Step 5: Build, bundle, and check by hand**

Run: `npm test && ./build.sh && ./scripts/bundle.sh`

Then:

```bash
open -a Falcon
```

Expected: a dock icon appears, a window opens (this is a user launch), the menu bar along the top shows Falcon / Edit / Conversation / Session / Window, and ⌘D puts it in chat mode.

Close the window with ⌘W. Expected: the app stays running, the menu bar item is still there, and clicking the dock icon brings the window back.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Give Falcon a dock icon, a menu bar, and a window that closes without quitting"
```

---

### Task 6: The squeeze summons the window

**Files:**
- Modify: `swift/FalconApp.swift`

**Interfaces:**
- Consumes: `wokenByGesture()` (Task 2), `FalconWindow.show` (Task 3)
- Produces: nothing new

- [ ] **Step 1: Add the summon**

Replace `wokenByGesture()` from Task 2:

```swift
  /// What a squeeze means. The watcher recognises the gesture; this decides.
  ///
  /// The file first, then the window. Waking is the point of the gesture and
  /// the window is a courtesy — a summon that beat the wake would put a window
  /// on screen that is still asleep, which reads as the squeeze not working.
  ///
  /// Squeezing again while the window is already up is a no-op for the window
  /// and still a wake, so the gesture means one thing whatever is on screen.
  private func wokenByGesture() {
    pokeWakeFile()
    appendToLog("woke by headphone squeeze")
    openWindow()
  }
```

`openWindow()` already reveals an existing window rather than building a second, already falls back to the session file on disk, and already explains itself when there is no session yet.

The Siri Shortcut is deliberately not routed through here: it touches the same wake file directly, from node's side, and summons nothing. You say "hey siri, falcon" when you are not at the screen.

- [ ] **Step 2: Build and check by hand**

Run: `./build.sh && ./scripts/bundle.sh && open -a Falcon`

With AirPods connected and the window closed, squeeze once. Expected: the window comes forward *and* the menu bar glyph leaves `moon.zzz` — both, not either.

Squeeze again with the window front. Expected: it wakes, nothing jumps or reloads.

- [ ] **Step 3: Commit**

```bash
git add swift/FalconApp.swift
git commit -m "Bring the window forward when you squeeze for it"
```

---

### Task 7: The icon

**Files:**
- Create: `scripts/make-icon.swift`
- Create: `assets/Falcon.icns` (generated, committed)
- Modify: `scripts/bundle.sh`
- Modify: `package.json` (an `icon` script)

**Interfaces:**
- Consumes: nothing
- Produces: `assets/Falcon.icns`

- [ ] **Step 1: Write the renderer**

Create `scripts/make-icon.swift`. It draws the app's own listening state — the field from `ui/app.js`: 130 dots on a golden-angle spiral in a band, in the listening green, on the window's ground.

```swift
// Draws the app icon, so it is source rather than a binary nobody can edit.
//
// The artwork is what the window draws when it is listening to you: 130 dots on
// a golden-angle spiral, in the listening green over the window's own ground.
// Not a bird, and not a microphone glyph — those describe the category, and the
// ring is the thing you actually watch while you talk to it.
//
// Run with: swift scripts/make-icon.swift
// Then: iconutil -c icns -o assets/Falcon.icns <work>/Falcon.iconset

import AppKit

let ground = NSColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1)
let green = NSColor(red: 0.561, green: 0.851, blue: 0.659, alpha: 1)   // #8FD9A8

/// One square of artwork at `size` points.
func draw(size: CGFloat) -> NSImage {
  let image = NSImage(size: NSSize(width: size, height: size))
  image.lockFocus()
  defer { image.unlockFocus() }

  guard let ctx = NSGraphicsContext.current?.cgContext else { return image }
  let scale = size / 1024

  // The macOS icon grid: the artwork sits on a squircle inset from the canvas,
  // not edge to edge, or it looks a size larger than every icon beside it.
  let inset = (1024 - 824) / 2 * scale
  let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
  let squircle = NSBezierPath(roundedRect: rect, xRadius: 185 * scale, yRadius: 185 * scale)
  ground.setFill()
  squircle.fill()
  squircle.addClip()

  let centre = CGPoint(x: size / 2, y: size / 2)

  // The soft middle, which is what stops the ring reading as a flat washer.
  if let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                           colors: [green.withAlphaComponent(0.18).cgColor,
                                    green.withAlphaComponent(0).cgColor] as CFArray,
                           locations: [0, 1]) {
    ctx.drawRadialGradient(glow, startCenter: centre, startRadius: 0,
                           endCenter: centre, endRadius: 300 * scale,
                           options: [])
  }

  // The same seeded field the window draws, so the icon and the app agree.
  var seed: UInt64 = 20260830
  func random() -> CGFloat {
    seed = (seed &* 1664525 &+ 1013904223) % 4294967296
    return CGFloat(seed) / 4294967296
  }

  for i in 0..<130 {
    let angle = CGFloat(i) * 2.39996
    let band = (300 + random() * 250) * scale
    let radius = (4 + random() * 11) * scale
    // Brighter on one side, so it reads as lit rather than printed.
    let lean = 0.55 + 0.45 * cos(angle - .pi / 4)
    let alpha = (0.16 + random() * 0.55) * lean

    green.withAlphaComponent(alpha).setFill()
    let dot = CGRect(x: centre.x + cos(angle) * band - radius,
                     y: centre.y + sin(angle) * band - radius,
                     width: radius * 2, height: radius * 2)
    NSBezierPath(ovalIn: dot).fill()
  }

  return image
}

let work = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "./Falcon.iconset"
try? FileManager.default.createDirectory(atPath: work, withIntermediateDirectories: true)

// The sizes an iconset must contain. 16pt is the one that decides whether this
// design works: a ring that turns to mush there is the wrong drawing.
for (points, scales) in [(16, [1, 2]), (32, [1, 2]), (128, [1, 2]), (256, [1, 2]), (512, [1, 2])] {
  for factor in scales {
    let pixels = CGFloat(points * factor)
    let image = draw(size: pixels)
    guard
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:])
    else { continue }
    let suffix = factor == 1 ? "" : "@2x"
    let name = "\(work)/icon_\(points)x\(points)\(suffix).png"
    try? png.write(to: URL(fileURLWithPath: name))
  }
}

print("wrote \(work)")
```

- [ ] **Step 2: Generate it**

```bash
mkdir -p assets
work="$(mktemp -d)/Falcon.iconset"
swift scripts/make-icon.swift "$work"
iconutil -c icns -o assets/Falcon.icns "$work"
```

Expected: `assets/Falcon.icns` exists and is a few hundred KB.

- [ ] **Step 3: Add a script for it**

In `package.json`, add to `scripts`:

```json
    "icon": "swift scripts/make-icon.swift /tmp/Falcon.iconset && iconutil -c icns -o assets/Falcon.icns /tmp/Falcon.iconset",
```

- [ ] **Step 4: Put it in the bundle**

In `scripts/bundle.sh`, after the `mkdir -p "$APP/Contents/MacOS"` line, add:

```bash
mkdir -p "$APP/Contents/Resources"
cp assets/Falcon.icns "$APP/Contents/Resources/Falcon.icns"
```

And in the plist heredoc, after `CFBundleExecutable`:

```
  <key>CFBundleIconFile</key><string>Falcon</string>
```

Add a verification line beside the others:

```bash
check "the icon is in place" test -f "$APP/Contents/Resources/Falcon.icns"
```

- [ ] **Step 5: Look at it**

Run: `./scripts/bundle.sh && open /Applications`

Expected: Falcon shows the ring, not a blank page. Check it at the smallest Finder icon size and in ⌘-Tab. If the ring reads as mush at 16pt, increase the dot radius floor in `draw` and regenerate — that is the size the design has to survive.

- [ ] **Step 6: Commit**

```bash
git add scripts/make-icon.swift assets/Falcon.icns scripts/bundle.sh package.json
git commit -m "Give it a face: the field it draws when it is listening"
```

---

### Task 8: The manual pass

Nothing here is automatable — it is lifecycle, permissions and hardware. Do it in one sitting on a bundled build.

**Files:**
- Modify: `CLAUDE.md` (the architecture table gains the new files)
- Modify: `docs/superpowers/plans/2026-08-30-falcon-desktop-app.md` (tick the boxes)

- [ ] **Step 1: Build clean and bundle**

```bash
./build.sh && npm test && ./scripts/bundle.sh
```

Expected: three binaries, all tests green, bundle verified.

- [ ] **Step 2: Work through the spec's checks**

Run all ten from the spec's Testing section, in order. Write down anything that surprises you rather than fixing it silently — a surprise here is usually a design decision that was wrong, not a bug.

1. Log out and back in → dock icon, no window, menu bar item, answers a spoken wake
2. Click the dock icon → window opens on the current session
3. Close the window → still listening, wake still works, glyph still updates
4. Squeeze, window closed → wakes **and** the window comes forward
5. Squeeze, window front → wakes, nothing jumps
6. "hey siri, falcon" → wakes, **no window**
7. ⌘D / ⌘N / ⌘. / Sleep drive the session; Paste works in the window's field
8. ⌘Q → menu bar item goes, node stops, microphone released
9. The icon reads in the dock, ⌘-Tab, and at 16pt
10. `npm run app` still opens a window

- [ ] **Step 3: Update the working notes**

In `CLAUDE.md`, update the architecture block so the Swift side lists the files as they now are: `FalconApp.swift` (coordinator), `StatusItem.swift`, `FalconWindow.swift`, `SessionClient.swift`, `MainMenu.swift`, `AppLaunch.swift`, and `bin/falcon-window` rather than `bin/voiceapp`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Write down what the app is made of now"
```

---

## Self-review

**Spec coverage.** Section 1 (app shell) → Tasks 1 and 5. Section 2 (window controller) → Task 3. Section 3 (squeeze) → Tasks 2 and 6. Section 4 (icon) → Task 7. Section 5 (testing) → tests inside Tasks 1 and 2, manual pass in Task 8. The file split named in "What it becomes" → Tasks 3, 4 and 5. Definition of done → Task 8.

**Ordering.** The two testable extractions come first so they land under test. The window extraction precedes the coordinator split so the split has less to move. The main menu comes after the split so it lands in a file with room. The squeeze summon comes last of the behaviour work because it needs both the window and the gesture split. The icon is independent and could move anywhere.

**Known deferral.** Task 3 Step 3 writes `app.mainMenu = falconMainMenu()`, which Task 5 creates. The step says so and gives the placeholder to use in the meantime. Whoever executes Task 3 must not invent a `falconMainMenu`.
