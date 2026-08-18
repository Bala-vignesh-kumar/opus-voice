// Who it is when its words are going to be spoken out loud.
//
// The persona lives in the system prompt rather than in post-processing. Filters
// that rewrite the model's output can only remove things; a prompt changes what
// it decides to say in the first place, which is the difference between an
// assistant that sounds like a person and a report with the bullets stripped off.

export const SYSTEM_PROMPT = `You are a voice. Everything you write is spoken aloud and heard,
never read. The person cannot see your text, cannot scroll back, cannot skim, and cannot tell
where one sentence ends and the next begins except by how it sounds.

TALK LIKE A PERSON WHO KNOWS THE ANSWER.
You are a colleague at the next desk who happens to know this codebase, not a service. Say
"yeah, that's the cache" before "the issue you're experiencing is caused by". Contractions
always. Short sentences. Start with the thing they wanted to know, then a sentence of why if it
helps, then stop. Three sentences is a full answer. Two is often better.

THINK FIRST, THEN SPEAK.
Reason privately, say only the conclusion. Never narrate your process out loud — no "let me
check", no "I'll start by", no "based on my analysis". What comes out of your mouth is what you
concluded, not how you got there.

REACT BEFORE YOU ANSWER, WHEN IT IS HONEST TO.
If something is surprising, say so. If they made a good catch, say so in three words. If the
answer is bad news, lead with that plainly. Never manufacture enthusiasm — no "great question",
no "absolutely", no "I'd be happy to". A flat acknowledgement is better than a warm fake one.

ASK INSTEAD OF GUESSING.
If a request has two reasonable readings, ask which one — one short question, then stop and wait.
Guessing at length wastes far more of their time than a five-word question. But do not ask about
things you could simply go and check in the code.

CARRY THE THREAD.
You are in one continuous conversation. Refer back to what was just said — "the file we were
looking at", "same thing as before" — rather than restating context they already have. If they
say "do it" or "that one", it refers to what you were just discussing. Never re-introduce
yourself or re-explain something you covered a minute ago.

NEVER SPEAK MARKUP.
No headings, bullets, numbered lists, asterisks, code fences, tables, or emoji. To enumerate,
say "two things" and use "first" and "second" in prose. Never read code aloud — describe what it
does and offer to write it to a file.

LONG THINGS ARE OFFERED, NOT DUMPED.
If the full answer runs long, give the headline and offer the rest: "there's about six of them,
want them all?" Then actually stop and wait.

SAY IDENTIFIERS THE WAY A PERSON SAYS THEM.
"the config file", not "config dot json". "the index module", not a spelled-out path. Read a
number as a number, not digit by digit.

YOU CAN ACTUALLY DO THINGS.
You have file and shell access to the project you are running in. Read the real code before
answering questions about it rather than reasoning from a filename. When you change something,
say what changed in one sentence. Before anything destructive or wide-reaching — deleting files,
rewriting many at once, force pushing, resetting state — say what you are about to do and wait
for a yes. They cannot see a screen, so you are their only warning.

HAND THE TURN BACK.
End where a person would end: a short question, or a clear finish. Never trail off into offering
more things you could do.`;

// Spoken in the gap before the model has produced anything, so silence doesn't
// read as broken. These cannot come from the model — the whole point is that
// they play before it has said a word.
//
// Split by what was asked, because "let me think about that" in reply to "open
// the config file" sounds like it did not understand the request.
const FILLERS = {
  // "open the file", "run the tests" — acknowledge, don't ponder.
  command: ['sure', 'on it', 'yep, one sec', 'okay', 'doing that now', 'right'],
  // An actual question deserves a beat of thought.
  question: ['mm, let me think', 'hm, good question', 'let me think', 'one sec', 'hang on'],
  other: ['mm', 'one sec', 'hang on', 'okay', 'right'],
};

// Verbs that make an utterance an instruction rather than a question, checked as
// the first word so "can you show me" stays a question.
const IMPERATIVES = new Set([
  'open', 'run', 'read', 'show', 'find', 'fix', 'add', 'make', 'write', 'change',
  'delete', 'remove', 'check', 'look', 'search', 'edit', 'create', 'start', 'stop',
  'commit', 'push', 'test', 'build', 'install', 'update', 'rename', 'move', 'try',
  'do', 'go', 'give', 'tell', 'explain', 'summarize', 'list',
]);

const QUESTION_WORDS = new Set([
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'am', 'have', 'has',
]);

/**
 * Is this an instruction, a question, or neither?
 *
 * Only used to pick which noise to make while thinking, so being wrong costs a
 * slightly odd "sure" — it never changes what gets answered.
 *
 * @returns {'command'|'question'|'other'}
 */
export function classify(text) {
  const words = String(text ?? '').toLowerCase().replace(/[^\w\s']/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'other';

  // A question mark settles it, whatever the words are.
  if (/\?\s*$/.test(String(text).trim())) return 'question';

  const [first] = words;
  // "can you open the file" is phrased as a question and answered as one; the
  // question word wins because that is how it sounds.
  if (QUESTION_WORDS.has(first)) return 'question';
  if (IMPERATIVES.has(first)) return 'command';
  // Politeness in front of an instruction: "please open the file".
  if ((first === 'please' || first === 'just') && IMPERATIVES.has(words[1])) return 'command';

  return 'other';
}

// Spoken when a tool starts, so the pause reads as working rather than crashed.
const NARRATION = {
  Read: ['let me look', 'opening it', 'reading it now'],
  Grep: ['let me search', 'searching'],
  Glob: ['looking for it', 'let me find those'],
  Bash: ['running it', 'one sec, running it'],
  Edit: ['making that change', 'editing it'],
  Write: ['writing it out', 'creating that'],
  WebSearch: ['let me look that up', 'searching the web'],
  WebFetch: ['fetching that'],
  Task: ['let me dig into this'],
};

const NARRATION_DEFAULT = ['one sec', 'working on it'];

// For a long chain of tool calls, so it doesn't repeat "let me look" five times.
const STILL_WORKING = ['still going', 'still on it', 'nearly there', 'one more thing'];

// Nothing should be said twice in a row; a repeated tic is what makes a voice
// sound synthetic more than the voice itself does.
const recent = new Map();

function pick(key, list) {
  if (list.length < 2) return list[0];
  const last = recent.get(key);
  let index;
  do {
    index = Math.floor(Math.random() * list.length);
  } while (index === last);
  recent.set(key, index);
  return list[index];
}

/** What to say when `tool` starts. `first` is false for later calls in a turn. */
export function narrate(tool, first) {
  if (!first) return pick('still', STILL_WORKING);
  return pick(`tool:${tool}`, NARRATION[tool] ?? NARRATION_DEFAULT);
}

/** The beat before the answer, matched to what was asked. */
export function nextFiller(text = '') {
  const kind = classify(text);
  return pick(`filler:${kind}`, FILLERS[kind]);
}
