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
