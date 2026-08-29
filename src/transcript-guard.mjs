// src/transcript-guard.mjs
// Refusing turns nobody spoke.
//
// Whisper hallucinates on silence and noise. Fed a near-silent buffer it
// confidently returns stock phrases from its training data — "Thank you.",
// "Thanks for watching!", subtitle credits. In a voice assistant those arrive
// as unprompted turns from nothing, which is the same failure as the bare "."
// that once reached Claude and was answered with "Still here."
//
// Two guards, and the order matters: the level check is the real defence,
// because a phrase list is never complete.

/** Below this microphone peak, nothing was said loudly enough to be a turn. */
export const MIN_PEAK = 0.02;

// Whole-utterance only. "thank you" inside a sentence is a person being polite.
const STOCK = new Set([
  'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'you', 'bye', 'goodbye', 'okay', 'so',
  'subtitles by the amara.org community', 'subtitles by the amara org community',
  'transcription by castingwords',
]);

/** The transcript reduced to the form the phrase list is written in. */
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether the transcript is one phrase looped back at us.
 *
 * Whisper's other artefact on silence is degenerate repetition: it latches onto
 * a phrase and emits it over and over. The repeated string is in no phrase list,
 * and room noise carries it over the energy floor, so it needs its own guard.
 *
 * Deliberately narrow. Saying a word twice — "no no, run it again" — is speech;
 * emitting the same sentence three times, or the same single word four times,
 * is a decoder that came unstuck.
 */
function isLooped(bare) {
  const sentences = bare.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length >= 3 && sentences.every((s) => s === sentences[0])) return true;
  const words = bare.split(' ').filter(Boolean);
  return words.length >= 4 && words.every((w) => w === words[0]);
}

/** Whether the whole transcript is a phrase Whisper invents from silence. */
export function isHallucination(text) {
  const bare = normalize(text);
  if (!bare) return true;
  // Punctuation on its own is not speech, whatever produced it.
  if (!/[a-z0-9]/.test(bare)) return true;
  if (STOCK.has(bare)) return true;
  return isLooped(bare);
}

/**
 * Whether a Whisper transcription should become a turn.
 *
 * @param {string} text  what Whisper returned
 * @param {number} peak  the loudest sample in the utterance, 0..1
 */
export function acceptable(text, peak) {
  if (!String(text).trim()) return false;
  // Fail closed on a level we cannot read. `peak < MIN_PEAK` is false for
  // undefined and NaN, which would make a missing field the one way a turn
  // nobody spoke gets past the guard that does not depend on a phrase list.
  const level = Number(peak);
  if (!Number.isFinite(level) || level < MIN_PEAK) return false;
  return !isHallucination(text);
}
