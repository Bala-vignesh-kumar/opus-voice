// src/echo-guard.mjs
// Refusing the turns it spoke itself.
//
// When the answer plays out of the laptop speakers and the microphone is the
// laptop's own, there is an open acoustic path from the one to the other. Echo
// cancellation would close it, but it is off by default here and refused
// outright on bluetooth output — see docs/DECISIONS.md and EchoPolicy.swift —
// so the loop has to be closed in software as well.
//
// Measured, 4 Sep 2026, from a session that spent its whole life answering
// itself: it said the thinking beat "hang on", heard "Hang on." two seconds
// later, took it for a question, asked it, said "one sec" while thinking about
// it, heard that too, and so on. `bargeInWords` is 2 and "hang on" is two
// words, so it also counted as the user interrupting: it cut itself off to
// listen to itself.
//
// Nothing else could have caught it. The peak floor in transcript-guard.mjs is
// 0.02 and its own voice arrives at 0.03 to 0.39; the stock-phrase list there
// is aimed at what Whisper invents out of silence, and holds one of the app's
// own phrases by coincidence. What was missing is the only thing the app
// actually knows for certain: exactly what it just said.

/** How long a sentence stays worth suspecting, from when it was handed over. */
export const DEFAULT_WINDOW_MS = 8000;

/** The text reduced to the words alone: case, punctuation and spacing gone. */
function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Whether `heard` is a contiguous run of words out of `said`.
 *
 * One direction only, and deliberately. What comes back is always some part of
 * what went out — the recognizer catches the tail of a sentence, or drops a
 * word — so `said` is the haystack every time. Testing it the other way round
 * would make "sure" match "are you sure about that", which is a person asking a
 * question.
 */
function runOf(heard, said, { partial = false } = {}) {
  if (heard.length === 0 || heard.length > said.length) return false;
  const last = heard.length - 1;
  for (let i = 0; i + heard.length <= said.length; i += 1) {
    let hit = true;
    for (let j = 0; j < heard.length; j += 1) {
      const same = said[i + j] === heard[j]
        // A partial is cut mid-word: "Sure, I" is on its way to "Sure, I'm".
        || (partial && j === last && said[i + j].startsWith(heard[j]));
      if (!same) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * What the app has said out loud lately, so it can refuse to hear it back.
 *
 * Fed from the one place every spoken sentence passes through — there are
 * seventeen callers of `speaker.say`, and a list maintained at each of them
 * would be wrong within a week.
 */
export class EchoGuard {
  #window;
  #now;
  #recent = [];

  /**
   * @param {object}   [options]
   * @param {number}   [options.window]  ms a sentence stays suspect
   * @param {function} [options.now]     clock, injectable for the tests
   */
  constructor({ window = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.#window = window;
    this.#now = now;
  }

  /** Records a sentence on its way to the synthesizer. */
  said(text) {
    const said = words(text);
    if (said.length === 0) return;
    this.#recent.push({ said, at: this.#now() });
  }

  /**
   * Whether this transcript is something the app said, coming back.
   *
   * A single word only counts when it is the whole of what was said — "sure"
   * looping is the app, but "read" out of "I will read the file now" is a
   * person giving an instruction that happens to share a verb.
   *
   * `partial` is for the recognizer's interim text, which stops mid-word: the
   * barge-in that cut the app off on 16 Sep 2026 fired on "Sure, I" while it
   * was saying "Sure — I'm talking", and "i" is not "i'm" until the word ends.
   */
  isEcho(text, { partial = false } = {}) {
    const heard = words(text);
    if (heard.length === 0) return false;
    this.#prune();
    return this.#recent.some(({ said }) =>
      runOf(heard, said, { partial }) && (heard.length === said.length || heard.length >= 2));
  }

  /** Forgets everything. The conversation is over; nothing is still in the air. */
  clear() {
    this.#recent = [];
  }

  #prune() {
    const cutoff = this.#now() - this.#window;
    this.#recent = this.#recent.filter((entry) => entry.at >= cutoff);
  }
}
