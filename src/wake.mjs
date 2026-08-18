// Wake phrase detection.
//
// Speech recognition mangles names constantly, so the name is matched by edit
// distance and commands by keyword rather than by exact phrase.
//
// The phrase is two words — "hey falcon" — for the same reason Siri and Alexa
// use one. A lone name has to be recognised out of a stream of unrelated speech,
// and at that job a single short word is hopeless: it competes with every
// similar-sounding word in the language. A greeting in front of it roughly
// doubles the acoustic evidence and, more importantly, the pair almost never
// occurs by accident, so the matcher can afford to be generous about how each
// half is heard without waking on ordinary conversation.

let WAKE_WORD = 'falcon';
let WAKE_DISTANCE = 2;

// Words that can lead the phrase. "hey" comes back as "hay", "a" and "ay" often
// enough to matter, and people naturally say "ok" or "hi" instead.
const PREFIXES = new Set([
  'hey', 'hay', 'hei', 'hi', 'high', 'ok', 'okay', 'hello', 'a', 'ay', 'eh', 'yo',
]);

// Whether the greeting is required. Set from the configured phrase: a two-word
// phrase requires it, a bare name does not.
let REQUIRE_PREFIX = true;

/**
 * Sets the phrase to listen for, e.g. "hey falcon" or just "falcon".
 * Called once at startup from config; the default is what the docs describe.
 */
export function setWakePhrase(phrase) {
  const words = normalize(phrase ?? '').split(' ').filter(Boolean);
  if (words.length === 0) return;
  WAKE_WORD = words[words.length - 1];
  REQUIRE_PREFIX = words.length > 1;
  // A short name needs a tighter radius or it matches half the language, but
  // with a greeting in front there is far less riding on the name alone.
  WAKE_DISTANCE = WAKE_WORD.length <= 4 ? 1 : 2;
}

/** The phrase as configured, for prompts and banners. */
export function wakePhrase() {
  return REQUIRE_PREFIX ? `hey ${WAKE_WORD}` : WAKE_WORD;
}

// Mishearings that sound right but are too far in spelling for edit distance.
// Only honoured as the very first word, since a word that turns up in ordinary
// developer conversation waking it is worse than missing an occasional wake.
const WAKE_ALIASES = new Set([
  'falcon', 'falcons', 'vulcan', 'falken', 'foulcon',
]);

// Real words within the fuzz radius of the name. None of these is worth a false
// wake, and none of them is a plausible way to address it. Checked before the
// edit-distance test, so it overrides the fuzz but never an exact match on the
// name itself.
const NOT_WAKE = new Set([
  'fallen', 'felon', 'talon', 'salon', 'salmon', 'bacon', 'balcony',
  'falls', 'fall', 'falcon punch',
]);

// Longest utterance still treated as a bare command rather than a question.
const MAX_BARE_WORDS = 4;

const COMMANDS = [
  // Order matters: "stop taking notes" must not match `note` first.
  { name: 'stop', keywords: [['stop'], ['sleep'], ['exit'], ['quit'], ['done'], ['that is all'], ["that's all"], ['nevermind'], ['never mind']] },
  { name: 'summarize', keywords: [['summarize'], ['summarise'], ['summary'], ['wrap up'], ['wrap it up']] },
  { name: 'note', keywords: [['listen'], ['take notes'], ['take note'], ['notes'], ['note this'], ['minutes']] },
  { name: 'chat', keywords: [['discuss'], ['lets talk'], ["let's talk"], ['chat'], ['talk']] },
];

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

function isWakeWord(word, first) {
  const bare = word.replace(/'s$/, '');
  if (bare === WAKE_WORD) return true;
  if (NOT_WAKE.has(bare) || NOT_WAKE.has(word)) return false;
  if (distance(bare, WAKE_WORD) <= WAKE_DISTANCE) return true;
  return first && WAKE_ALIASES.has(word);
}

/**
 * Finds where the wake phrase ends, or -1.
 *
 * Only the start of an utterance counts, so "I told Falcon to stop" mid-sentence
 * cannot flip a mode.
 *
 * @returns {number} index of the last word of the phrase
 */
function findWake(words) {
  const window = Math.min(words.length, 3);

  if (REQUIRE_PREFIX) {
    for (let i = 0; i < window; i += 1) {
      // "heyfalcon" — the recognizer sometimes runs the pair together.
      if (isWakeWord(words[i].replace(/^(hey|hi|ok|okay)/, ''), true)
          && /^(hey|hi|ok|okay)/.test(words[i])) return i;
      if (!PREFIXES.has(words[i])) continue;
      const next = words[i + 1];
      if (next && isWakeWord(next, true)) return i + 1;
    }
    return -1;
  }

  for (let i = 0; i < window; i += 1) {
    if (isWakeWord(words[i], i === 0)) return i;
  }
  return -1;
}

/**
 * Parses an utterance for the wake phrase and a mode command.
 *
 * @returns {{wake: boolean, command: string|null, rest: string}}
 *   `command` is one of stop, summarize, note, chat, or 'ask' when the phrase
 *   is followed by something else entirely, or null when it stands alone.
 */
export function parseWake(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length === 0) return { wake: false, command: null, rest: '' };

  const index = findWake(words);
  if (index === -1) return { wake: false, command: null, rest: text.trim() };

  const after = words.slice(index + 1);
  const tail = after.join(' ');
  if (after.length === 0) return { wake: true, command: null, rest: '' };

  for (const { name, keywords } of COMMANDS) {
    for (const [phrase] of keywords) {
      if (tail === phrase || tail.startsWith(`${phrase} `) || tail.includes(` ${phrase}`)) {
        return { wake: true, command: name, rest: '' };
      }
    }
  }

  // Woke it and immediately asked something: "falcon, why is the build slow?"
  return { wake: true, command: 'ask', rest: tail };
}

/**
 * Matches a bare command with no wake word — "go to sleep", "stop".
 *
 * Only for when it is already listening to you: repeating its name to dismiss
 * something you are already talking to is stilted, and saying "go to sleep"
 * only to be told what sleep means is worse.
 *
 * Deliberately strict. A command has to be the whole utterance and nothing
 * else, or "how do I stop the dev server" would put it to sleep mid-question.
 *
 * @returns {string|null} the command name
 */
export function parseCommand(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_BARE_WORDS) return null;

  const phrase = words.join(' ');
  for (const { name, keywords } of COMMANDS) {
    for (const [keyword] of keywords) {
      // Allow only leading filler: "okay stop", "go to sleep", "please stop".
      if (phrase === keyword || phrase.endsWith(` ${keyword}`)) return name;
    }
  }
  return null;
}
