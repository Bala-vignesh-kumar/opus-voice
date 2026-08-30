// The menu bar along the top of the screen.
//
// An accessory app has none and does not need one. A regular app does — and not
// only for form: without an Edit menu the window's text fields have no working
// Cut, Copy or Paste, because on a Mac those are menu commands before they are
// anything else, and a field you cannot paste into is the kind of broken nobody
// files a bug about.
//
// Every conversation command posts the same thing the window's buttons post, so
// a menu item, a click and a spoken instruction are one thing arriving by
// different routes.

import AppKit

/// - Parameter target: receives the conversation and session actions. Passing
///   nil builds a menu with only the standard AppKit responders wired, which is
///   what the standalone window binary wants — it has no session to command.
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
                           action: NSSelectorFromString("toggleLoginFromMenu"), keyEquivalent: "")
    login.target = target
    app.addItem(login)
    app.addItem(.separator())
  }
  app.addItem(withTitle: "Hide Falcon", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
  let hideOthers = NSMenuItem(title: "Hide Others",
                              action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
  hideOthers.keyEquivalentModifierMask = [.command, .option]
  app.addItem(hideOthers)
  app.addItem(withTitle: "Show All",
              action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
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
    // Cmd-period is the Mac's "stop that". The window binds Escape to the same
    // command; two inputs, one instruction, and interrupting twice is harmless.
    let interrupt = NSMenuItem(title: "Interrupt",
                               action: NSSelectorFromString("interruptFromMenu"), keyEquivalent: ".")
    interrupt.target = target
    talk.addItem(interrupt)
    talkItem.submenu = talk

    let sessionItem = NSMenuItem()
    menu.addItem(sessionItem)
    let session = NSMenu(title: "Session")
    for (title, selector) in [
      ("Open Project Folder", "openProjectFromMenu"),
      ("Open Log", "openLogFromMenu"),
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
