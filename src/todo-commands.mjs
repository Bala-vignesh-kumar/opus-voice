// Parsing spoken to-do commands.
//
// Separate from wake.mjs because that file answers one question — is it being
// addressed, and in what mode — while this one answers a different one: is this
// sentence an instruction about the list, and which item does it mean.
//
// Everything here has to survive dictation. Numbers arrive as words ("todo
// two"), "to-do" comes back as "to do" or "two do", and trailing punctuation is
// arbitrary. Matching is therefore loose about form and strict about intent: a
// sentence only counts as a command when it names the list explicitly, so
// "delete the branch" stays a question for Claude.

const NUMBER_WORDS = {
  one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5,
  six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

/** "two" and "2" both mean 2; anything else means no number was said. */
export function toNumber(word) {
  if (word === undefined || word === null) return null;
  const text = String(word).toLowerCase().trim();
  if (/^\d+$/.test(text)) return Number(text);
  return NUMBER_WORDS[text] ?? null;
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "to-do", "to do", "todo", "task", and the mishearing "two do" all name the
// list. Kept as one alternation so every pattern below stays readable.
const LIST = "(?:to[\\s-]?do|two do|task|item)";
const LISTS = `${LIST}s?`;

// Order matters, and `add` goes last. Its pattern is the greedy one — "make a
// todo ..." — so tried first it swallows "make todo two a github issue" and
// files the words "two a github issue" as a new item.
const RULES = [
  {
    action: 'issue',
    // "make todo two a github issue", "file task 2 as an issue", "raise an issue for todo two"
    patterns: [
      new RegExp(`^(?:please\\s+)?(?:make|turn|convert|file|raise|open|create)\\s+${LIST}\\s+(\\w+)\\s+(?:in)?to\\s+(?:an?\\s+)?(?:github\\s+)?issue$`),
      new RegExp(`^(?:please\\s+)?(?:make|turn|convert|file|raise|open|create)\\s+${LIST}\\s+(\\w+)\\s+(?:as\\s+)?(?:an?\\s+)?(?:github\\s+)?issue$`),
      new RegExp(`^(?:please\\s+)?(?:file|raise|open|create)\\s+(?:an?\\s+)?(?:github\\s+)?issue\\s+(?:for|from)\\s+${LIST}\\s+(\\w+)$`),
    ],
    capture: 'index',
  },
  {
    action: 'done',
    patterns: [
      new RegExp(`^(?:please\\s+)?${LIST}\\s+(\\w+)\\s+(?:is\\s+|was\\s+)?(?:done|complete|completed|finished)$`),
      new RegExp(`^(?:please\\s+)?(?:mark|check off|tick off|complete|finish|close)\\s+(?:off\\s+)?${LIST}\\s+(\\w+)(?:\\s+(?:as\\s+)?(?:done|complete|completed|finished))?$`),
      new RegExp(`^(?:please\\s+)?(?:i\\s+)?(?:have\\s+|already\\s+)?(?:did|done|finished)\\s+${LIST}\\s+(\\w+)$`),
    ],
    capture: 'index',
  },
  {
    action: 'remove',
    patterns: [
      new RegExp(`^(?:please\\s+)?(?:delete|remove|drop|forget|scrap)\\s+${LIST}\\s+(\\w+)$`),
    ],
    capture: 'index',
  },
  {
    action: 'add',
    // "add a todo to ship the fix", "new task: ship the fix", "remind me to ship the fix"
    patterns: [
      new RegExp(`^(?:please\\s+)?(?:add|create|make|note|put)\\s+(?:a\\s+|an\\s+|the\\s+)?(?:new\\s+)?${LIST}\\s*(?:that|to|for|about|saying)?\\s+(.+)$`),
      new RegExp(`^(?:please\\s+)?new\\s+${LIST}\\s*(?:that|to|for|about|saying)?\\s+(.+)$`),
      /^(?:please\s+)?remind me to\s+(.+)$/,
    ],
    capture: 'text',
  },
  {
    action: 'list',
    patterns: [
      new RegExp(`^(?:please\\s+)?(?:what(?:'s| is| are)?)\\s+(?:on\\s+)?(?:my\\s+|the\\s+)?${LISTS}(?:\\s+list)?$`),
      new RegExp(`^(?:please\\s+)?(?:list|read|show|tell me|give me)\\s+(?:me\\s+)?(?:my\\s+|the\\s+)?${LISTS}(?:\\s+list)?$`),
      new RegExp(`^(?:please\\s+)?(?:what(?:'s| is)?\\s+)?(?:left|remaining|pending)\\s+(?:on\\s+)?(?:my\\s+|the\\s+)?${LISTS}(?:\\s+list)?$`),
      new RegExp(`^(?:please\\s+)?my\\s+${LISTS}(?:\\s+list)?$`),
      // "what's on my list" names it without ever saying "to-do".
      /^(?:please\s+)?(?:what(?:'s| is)?\s+)?(?:on\s+)?(?:my|the)\s+list$/,
    ],
    capture: null,
  },
];

/**
 * Parses an utterance as a to-do command.
 *
 * @returns {{action: string, index: number|null, text: string}|null}
 *   null when the sentence is not about the list, which is the common case and
 *   must stay cheap — every utterance passes through here.
 */
export function parseTodo(utterance) {
  const text = normalize(utterance);
  if (!text) return null;

  for (const { action, patterns, capture } of RULES) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;

      if (capture === 'text') {
        const body = match[1].trim();
        return body ? { action, index: null, text: body } : null;
      }
      if (capture === 'index') {
        const index = toNumber(match[1]);
        // "mark todo banana done" names no item. Better to fall through and let
        // it be a question than to act on a guess.
        if (index === null) return null;
        return { action, index, text: '' };
      }
      return { action, index: null, text: '' };
    }
  }
  return null;
}
