import Foundation

func runUtteranceTests() -> Int {
  var failures = 0
  func check(_ condition: Bool, _ what: String) {
    if !condition { print("  ✗ \(what)"); failures += 1 }
  }

  // The exact result that reached Claude as a turn and got answered.
  check(!isSpeech("."), "a lone full stop is not speech")
  check(!isSpeech(" . "), "nor is it with whitespace")
  check(!isSpeech("..."), "nor an ellipsis")
  check(!isSpeech("?"), "nor a question mark")
  check(!isSpeech(""), "nor nothing at all")
  check(!isSpeech(" , . ! "), "nor a handful of punctuation")

  check(isSpeech("I"), "a single word is speech")
  check(isSpeech("hello can you hear me"), "a sentence is speech")
  check(isSpeech("what about issue 421?"), "digits count")
  check(isSpeech("ok."), "a short word with punctuation still counts")
  // Not every language this runs in writes with ASCII letters.
  check(isSpeech("வணக்கம்"), "non-latin script counts")

  // A fragment that happens to end in a full stop is not a finished thought.
  // "Fineract" was cut after its first syllable because the transcriber emitted
  // "F." and the fast endpoint believed it.
  check(!isCompleteThought("F."), "a single letter is not a thought")
  check(!isCompleteThought("S."), "nor another one")
  check(!isCompleteThought("So"), "nor a fragment with no punctuation at all")
  // Two letters is deliberately allowed: "No." and "Ok." are real answers, and
  // rejecting them to catch a rarer fragment would cost more than it saves.

  // Short answers are real turns and must still take the fast path.
  check(isCompleteThought("Yes."), "a short word is a thought")
  check(isCompleteThought("Stop."), "so is a command")
  check(isCompleteThought("How are you?"), "so is a question")
  check(isCompleteThought("No!"), "so is an exclamation")
  check(isCompleteThought("what files are in this project?"), "so is a sentence")

  // No punctuation means no shortcut, whatever the length.
  check(!isCompleteThought("what files are in this"), "an unfinished sentence waits")

  if failures == 0 { print("  ✓ utterance filtering") }
  return failures
}
