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


/// Whether a trailing full stop means the speaker has actually finished.
///
/// The endpoint timer takes a turn sooner when the transcript ends in
/// punctuation, on the reasoning that the recognizer punctuates as it goes and
/// a full stop means a completed thought. That reasoning holds for a sentence
/// and fails badly for a fragment: the transcriber emits "F." a moment into
/// "Fineract", the fast path fires at 400ms, and the turn is taken after the
/// first syllable. Said three times, heard as "F.", "So", "F.".
///
/// So the shortcut is only allowed once there is enough there to be a thought.
func isCompleteThought(_ text: String) -> Bool {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.hasSuffix(".") || trimmed.hasSuffix("?") || trimmed.hasSuffix("!") else {
    return false
  }
  let words = trimmed.split(whereSeparator: { $0 == " " })
  // Two words, or one that is not a single letter. "Yes.", "Stop." and "No!"
  // are real turns; "F." is a syllable the recognizer caught mid-flight. One
  // letter is the line, because that is what the failure actually looked like
  // and anything stricter starts rejecting real answers.
  if words.count >= 2 { return true }
  return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: ".?!")).count >= 2
}
