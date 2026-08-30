# Falcon as a desktop app — design

*30 August 2026. Module 1 of the order set out in the
[module audit](2026-08-30-falcon-module-audit.md). Module 0, the rename, is
done and merged.*

Falcon works today as a background utility: a menu bar item that supervises a
node process, with a window you can summon from its menu. This turns it into an
app — a dock icon, a real main menu, a window that is the primary surface, and a
headphone squeeze that brings it to the front as well as waking it.

It also pays off two things the audit found, because this is the work that
touches them: `FalconApp.swift` doing five jobs, and `VoiceApp.swift`
duplicating the window.

---

## Decisions already taken

These were settled in conversation and are not reopened here.

| Question | Decision |
|---|---|
| What kind of app | Real app with a dock icon; the menu bar item **stays** |
| Closing the window | Hides it. The session keeps running and listening |
| At login | Starts silent — dock icon, no window |
| Squeeze | Wakes the session **and** summons the window |
| Squeeze while the window is already front | Just wakes. One gesture, one meaning |
| Siri wake | Stays invisible — never summons the window |
| App icon | Drawn as part of this work |
| Speaker label | `falcon` (done in module 0) |

**Siri stays invisible** is load-bearing for the shape of this change. The
squeeze is handled inside the Swift app, so summoning a window is a direct
in-process call. A Siri wake arrives in node through `trigger.mjs`, which has no
route back to a Swift window — and you say "hey siri, falcon" precisely when you
are not at the screen. Keeping it invisible means **this step changes no node
code at all**, which removes most of its risk.

---

## What exists now

```
bin/falcon          FalconApp.swift (374 ln)  menu bar item, orchestrator,
                                              squeeze watcher, on-demand window,
                                              SSE client, login item, log writer
bin/falcon-window   VoiceApp.swift  (164 ln)  a second window, near-duplicate
bin/voiceio         VoiceIO.swift             audio; untouched by this work
```

Both windows configure a `WKWebView`, an `NSWindow`, and a navigation policy,
and both use the `falcon` frame autosave name — so they fight over one saved
frame. `FalconApp.swift` is an accessory app: `LSUIElement` in the plist and
`NSApp.setActivationPolicy(.accessory)` at launch.

## What it becomes

```
swift/FalconApp.swift       coordinator: lifecycle, main menu, dock behaviour
swift/StatusItem.swift      the menu bar item and its menu
swift/FalconWindow.swift    the window — compiled into BOTH binaries
swift/SessionClient.swift   the SSE stream and command POSTs
swift/AppLaunch.swift       pure launch decisions, testable
swift/RemoteCommands.swift  a gesture recogniser and nothing else
swift/Orchestrator.swift    unchanged
swift/Environment.swift     unchanged
```

`FalconWindow.swift` compiled into both binaries is what removes the duplication
without breaking `npm run app`. `bin/falcon-window` becomes a thin shell around
the same window the app uses.

---

## 1 · App shell and lifecycle

### Becoming a regular app

Remove `LSUIElement` from the bundle plist in `scripts/bundle.sh`, and remove
the `NSApp.setActivationPolicy(.accessory)` call. A regular app is the default,
so nothing replaces them.

The bundle identifier does **not** change, so the microphone and speech
recognition grants from module 0 survive.

### Silent at login, a window when you ask

macOS distinguishes a launch it started from a launch a person started:
`NSApplication.launchIsDefaultLaunchKey` in the launch notification's `userInfo`
is `false` when the system opened the app — which covers the login item.

```swift
/// Whether this launch should put a window on screen.
///
/// A login launch must not: the app starts with the machine and the point of it
/// is to be there when spoken to, not to open a window nobody asked for. A
/// person double-clicking it means the opposite.
func shouldOpenWindowAtLaunch(isDefaultLaunch: Bool) -> Bool {
  isDefaultLaunch
}
```

It lives in `AppLaunch.swift` beside `menuBarSymbol` for the same reason that
function does: it is a pure decision, and pure decisions get tested.

Nothing calls `NSApp.activate` during launch. A regular app that steals focus at
login is worse than one that does not appear at all.

### Closing hides; quitting quits

- `applicationShouldTerminateAfterLastWindowClosed` returns **false**.
  `VoiceApp.swift` returning true is the behaviour being deleted: closing the
  window would end the session, and since the app starts at login you would not
  get it back until the next one.
- The window is `isReleasedWhenClosed = false` and is reopened, not rebuilt.
- `applicationShouldHandleReopen(_:hasVisibleWindows:)` opens the window when
  there are none. A dock icon that does nothing when clicked reads as a bug.
- Quit stays deliberate: ⌘Q, or the menu bar item's Quit.
  `applicationWillTerminate` already stops the orchestrator and the watcher.

### The main menu

An accessory app has no main menu; a regular one must have a real one, and the
webview's text fields do not get working Cut/Copy/Paste without an Edit menu.

| Menu | Items |
|---|---|
| **Falcon** | About Falcon · Start at Login (checked) · Hide ⌘H · Hide Others ⌥⌘H · Show All · Quit ⌘Q |
| **Edit** | Cut ⌘X · Copy ⌘C · Paste ⌘V · Select All ⌘A |
| **Conversation** | Discuss ⌘D · Take Notes ⌘N · Sleep · Interrupt ⌘. |
| **Session** | Open Project Folder · Open Log |
| **Window** | Minimize ⌘M · Zoom · Close ⌘W · Bring All to Front |

About uses `orderFrontStandardAboutPanel`, which reads the version from the
bundle — no window to build or maintain.

The **status item keeps the menu it has**: the last few things said, Open
Window, the three modes, Open Project Folder, Open Log, Start at Login, Quit.
That menu exists to work when no window is open, which is still most of the
time, so the main menu duplicating some of it is correct rather than redundant
— the same commands reachable from wherever you happen to be.

Every Conversation item posts the same `{"cmd": "mode", …}` to `/command` that
the window's buttons and the menu bar's items already post, so a menu item and a
click are one instruction arriving by different routes. Interrupt posts
`{"cmd": "interrupt"}`.

⌘. does not collide with the window's own Escape-to-interrupt: they are separate
inputs producing the same command, and the command is idempotent.

---

## 2 · The window controller

`FalconWindow.swift` owns everything about the window and nothing about the
conversation.

```swift
final class FalconWindow: NSObject, WKNavigationDelegate {
  /// - Parameter fullScreen: enter full screen when first shown. Only the
  ///   standalone shell passes true; the app never takes the display uninvited.
  init(fullScreen: Bool = false)

  /// Creates the window or brings it forward, and points it at `session`.
  /// Reloads only when the url has actually changed — see `shouldReloadWindow`.
  func show(session: URL)

  func hide()
  var isVisible: Bool { get }
}
```

Carried across from the two existing implementations, unchanged in behaviour:

- a non-persistent `WKWebsiteDataStore`, so a window cannot show a stale session
- `drawsBackground = false`, with the window painting the page's own ground so
  the first frame is not a flash of grey
- the navigation policy: loopback and same port only; anything else is cancelled
  and handed to the real browser
- `.fullScreenPrimary` in the collection behaviour, or the green button zooms
  instead of going full screen
- the `falcon` frame autosave name — now genuinely one window's frame rather
  than two windows sharing one name

`bin/falcon-window` becomes a shell: read the session file, build a
`FalconWindow(fullScreen:)` driven by the existing `FALCON_FULLSCREEN` opt-out
exactly as it reads it today, show it, quit when it closes. Its `sessionURL()` reader moves into `Environment.swift` next to the
other path resolution, so the app and the shell read the session file one way.

---

## 3 · The squeeze

`RemoteCommandWatcher` currently recognises the gesture *and* decides what it
means — `poke()` writes `~/.falcon/wake` directly. It stops doing the second
half:

```swift
init(gesture: WakeGesture,
     forwardToPlayer: Bool,
     onWake: @escaping () -> Void,
     onLog: @escaping (String) -> Void)
```

The app supplies the meaning:

```swift
onWake: { [weak self] in
  // The file first. Waking is the point of the gesture; the window is a
  // courtesy, and a summon that beat the wake would show a window that is
  // still asleep.
  self?.pokeWakeFile()
  self?.window.show(session: url)
  NSApp.activate(ignoringOtherApps: true)
}
```

Ordering is deliberate and stated so it is not "tidied" later.

Squeezing while the window is already front is a no-op for the window —
`show(session:)` on a visible window at the same url reloads nothing — and still
wakes. One gesture, one meaning, whatever is on screen.

This split is also what makes the module testable, which the audit noted it is
not: with the file write gone, mapping an AVRCP command to "this is the wake
gesture" is a pure function.

Unchanged: claiming the Now Playing role, forwarding to Spotify and Music, and
`Keepalive` holding a silent stream open so the buds emit a command at all.

---

## 4 · The icon

Falcon.app currently shows the generic blank bundle icon.

`scripts/make-icon.swift` renders the artwork with CoreGraphics at every size an
iconset needs, and `iconutil` packs it into `assets/Falcon.icns`, which
`bundle.sh` copies in alongside `CFBundleIconFile`. Source in the repository
rather than a binary nobody can edit, and regenerated by one command.

**The artwork is the app's own listening state.** The window draws 130 dots on a
golden-angle spiral in a band, and turns them `#8FD9A8` when it is listening to
you. That is the icon: the same ring, the same green, on the window's own
`#0B0D10` ground, with the soft radial centre the field has — not a bird, and
not a microphone glyph that would make it look like every other audio utility.

- 1024×1024 canvas; squircle of 824 centred, corner radius 185, per the macOS
  icon grid
- the ring at the field's own proportions, dot alpha varying as it does on
  screen, a little brighter on one side so it does not read as a flat washer
- sizes 16, 32, 128, 256, 512 at 1× and 2×
- checked at 16pt, where the ring must still read as a ring rather than mush

---

## 5 · Testing

**Swift**, added to `scripts/test-swift.sh`:

- `shouldOpenWindowAtLaunch(isDefaultLaunch:)` — both directions
- `WakeGesture.named` — each name, and the fallback for an unknown one
- the AVRCP command → is-this-the-wake-gesture mapping, now that it is pure

The window, the status item and the session client stay untested: they are
AppKit lifecycle, which is what the manual pass below is for.

**Node:** the full suite must stay green **without modification**. This step
changes no node code, so a red test means it broke something it had no business
touching.

**Manual, once built and bundled:**

1. Log out and back in → dock icon, no window, menu bar item present, and it
   answers a spoken wake.
2. Click the dock icon → the window opens on the current session.
3. Close the window → it keeps listening; a wake still works; the menu bar item
   still shows mode.
4. Squeeze with the window closed → it wakes and the window comes forward.
5. Squeeze with the window already front → it wakes, nothing jumps.
6. "hey siri, falcon" → wakes, **no window appears**.
7. ⌘D, ⌘N, ⌘. and Sleep drive the session; Edit's Paste works in the window's
   text field.
8. ⌘Q quits: the menu bar item goes, node stops, the microphone is released.
9. The icon reads correctly in the dock, ⌘-Tab, and at 16pt in Finder.

---

## Risks

**A regular app stealing focus at login.** Mitigated by never calling `activate`
during launch. Verified by manual check 1.

**The window summoned before the session exists.** At login the orchestrator
takes a moment to bind a port. `show(session:)` requires a URL, and the existing
code already falls back to reading the session file from disk and shows an
explanatory alert when there is none. That path stays.

**Two windows on one session.** Possible if someone runs `npm run app` while the
app is running. It already is today; both are read-only views of the same event
stream, so it is untidy rather than wrong. Not addressed here.

**Login item registration.** `SMAppService.mainApp` behaves the same for a
regular app; the once-only registration logic is unchanged.

**Frame autosave carrying over.** The saved frame from the old accessory window
is reused, which is what we want — the window should come back where it was.

## Out of scope

A Settings window (it needs the `config.mjs` validation work, which is module 5
in the audit's order), the calendar rail, library search, notarisation or
distribution, and any change to `ui/` or to node.

## Definition of done

The nine manual checks pass, the Swift and node suites are green, `VoiceApp.swift`
no longer exists, and `FalconApp.swift` is a coordinator rather than five jobs in
one file.
