// Wake phrase detection.
//
// Speech recognition mangles names constantly, so the name is matched by edit
// distance and commands by keyword rather than by exact phrase.

const WAKE_WORD = 'falcon';
const WAKE_DISTANCE = 2;

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
 * Parses an utterance for the wake word and a mode command.
 *
 * @returns {{wake: boolean, command: string|null, rest: string}}
 *   `command` is one of stop, summarize, note, chat, or 'ask' when the wake word
 *   is followed by something else entirely, or null when it stands alone.
 */
export function parseWake(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length === 0) return { wake: false, command: null, rest: '' };

  // Only honour the wake word near the start, so "I told Falcon to stop"
  // mid-sentence doesn't trigger a mode change.
  const index = words.slice(0, 3).findIndex((word, i) => isWakeWord(word, i === 0));
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
