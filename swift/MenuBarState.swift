// What the status item draws, given what the conversation is doing.
//
// Split out from the app so it can be tested without a window, a run loop or a
// menu bar — the only part of the app that is a pure decision.

import Foundation

/// The SF Symbol for the current state.
///
/// Ordered by what a person most needs to know: that it is broken, then that it
/// is mid-turn, then which mode it is sitting in.
func menuBarSymbol(mode: String, status: String?, failed: Bool) -> String {
  if failed { return "exclamationmark.triangle" }

  // Any status at all means a turn is in flight — 'thinking', 'speaking', or a
  // tool name. Which one it is belongs in the menu, not in 16 points of glyph.
  if let status, !status.isEmpty { return "waveform.circle.fill" }

  switch mode {
  case "asleep": return "moon.zzz"
  case "note": return "record.circle"
  default: return "waveform"
  }
}
