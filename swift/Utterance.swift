// What counts as something somebody said.
//
// The recognizer emits bare punctuation between utterances — a lone "." is a
// routine result, not speech. It matters because the endpoint timer treats a
// trailing full stop as "the thought is finished" and takes the turn on the
// fast path, so a stray "." became a whole turn: Claude was asked "." and
// answered "Still here."
//
// Split out so it can be tested without an audio device.

import Foundation

/// Whether there is anything worth taking a turn on.
///
/// Letters or digits in any script, so this does not quietly stop working for
/// a locale whose alphabet is not ASCII.
func isSpeech(_ text: String) -> Bool {
  text.contains { $0.isLetter || $0.isNumber }
}
