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

  if failures == 0 { print("  ✓ utterance filtering") }
  return failures
}
