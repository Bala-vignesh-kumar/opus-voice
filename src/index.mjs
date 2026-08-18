#!/usr/bin/env node
// opus voice — hands-free spoken conversation with Claude in the terminal.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { spawn } from 'node:child_process';

import { ClaudeSession } from './claude.mjs';
import { VoiceIO } from './voice.mjs';
import { SpeechChunker } from './chunk.mjs';
import { nextFiller, narrate } from './style.mjs';
import { Speaker } from './speaker.mjs';
import { Ui } from './ui.mjs';
import { Conversation } from './bus.mjs';
import { makeView } from './view.mjs';
import { UiServer } from './server.mjs';
import { loadConfig, resolveWorkdir } from './config.mjs';
import { parseWake, parseCommand, setWakePhrase, wakePhrase } from './wake.mjs';
import { Notes, SUMMARY_PROMPT, splitSummary } from './notes.mjs';
import { Todos } from './todos.mjs';
import { parseTodo } from './todo-commands.mjs';
import { createIssue } from './github.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const config = loadConfig();
const workdir = resolveWorkdir(config);
setWakePhrase(config.wakePhrase);

const ui = new Ui();
// The conversation as data. The terminal renders it as it happens; the window
// needs to be able to ask for all of it at once, so it is kept rather than
// printed and forgotten.
const conversation = new Conversation();
const view = makeView(ui, conversation);
const voice = new VoiceIO({ locale: config.locale });
const claude = new ClaudeSession({
  model: config.model,
  effort: config.effort,
  cwd: workdir,
  permissionMode: config.permissionMode,
});
const speaker = new Speaker(voice, { engine: config.tts, piperVoice: config.piperVoice });
speaker.on('warn', (message) => view.warn(message));
const chunker = new SpeechChunker();
const notes = new Notes();
const todos = new Todos(workdir);

// asleep  ignores everything but the wake word
// awake   answers questions, sleeps again after a spell of silence
// chat    answers questions, stays awake until told to stop
// note    captures the discussion and never replies
const MODE = { ASLEEP: 'asleep', AWAKE: 'awake', CHAT: 'chat', NOTE: 'note' };
// With the wake word off it behaves as it did before: always listening.
let mode = config.wakeWord ? MODE.ASLEEP : MODE.CHAT;
let sleepTimer = null;
let pendingSummary = false;

let started = false;            // voiceio has finished audio setup
const typedBacklog = [];

const turn = {
  spoke: false,       // has any real answer been sent to the synthesizer yet
  aborted: false,     // user interrupted, discard the rest of this generation
  fillerTimer: null,
  queued: null,       // utterance that arrived while Opus was still answering
  line: '',           // accumulated text for the transcript display
  labelled: false,    // has the transcript printed the "opus" prefix this turn
  tools: 0,           // tool calls so far this turn
  lastNarration: 0,
  asked: 0,
  silent: false,      // suppress speech; used while summarizing notes
  raw: '',            // unmodified model output, for writing to disk
};

// OPUS_VOICE_TIMING=1 reports how long until the first real word is spoken,
// which is the number that actually decides whether this feels live.
const TIMING = Boolean(process.env.OPUS_VOICE_TIMING);

// MARK: turn lifecycle

function ask(text, { silent = false } = {}) {
  if (claude.busy) {
    turn.queued = text;
    return;
  }
  turn.silent = silent;
  turn.raw = '';
  if (!silent) view.you(text);
  chunker.reset();
  turn.spoke = false;
  turn.aborted = false;
  turn.line = '';
  turn.labelled = false;
  turn.tools = 0;
  turn.asked = Date.now();
  claude.send(text);
  view.spin('thinking');

  // The filler only fires if Opus hasn't produced a first sentence yet, so a
  // fast answer never gets a needless "hmm" in front of it.
  clearTimeout(turn.fillerTimer);
  turn.fillerTimer = setTimeout(() => {
    // Matched to what was asked: "sure" for an instruction, a thinking beat for
    // a question. "Let me think about that" in reply to "open the file" sounds
    // like it misheard.
    if (!turn.spoke && !turn.aborted) speaker.say(nextFiller(text));
  }, config.fillerDelayMs);
}

function say(sentence) {
  if (turn.aborted || !sentence) return;
  if (turn.silent) return;
  // `spoke` gates the thinking filler and narration also sets it; the transcript
  // label is tracked separately so the first real sentence still gets labelled.
  const first = !turn.labelled;
  if (first && TIMING) view.note(`(first word in ${Date.now() - turn.asked}ms)`);
  turn.labelled = true;
  turn.spoke = true;
  clearTimeout(turn.fillerTimer);
  turn.line = sentence;
  view.opus(sentence, first);
  view.spin('speaking');
  speaker.say(sentence);
}

// MARK: modes

function setMode(next, spoken) {
  const changed = mode !== next;
  mode = next;
  // Called on every question to refresh the idle timer, so only announce a
  // genuine transition.
  if (changed) view.mode(next);
  armSleep();
  if (spoken) speaker.say(spoken);
}

/**
 * Goes to sleep, announcing it only if it was awake. Being told "going to
 * sleep" by something that was already asleep reads like it ignored you.
 */
function sleep() {
  setMode(MODE.ASLEEP, mode === MODE.ASLEEP ? null : 'going to sleep.');
}

/**
 * Restarts the idle countdown. Awake and chat both sleep on silence — being
 * woken and then forgotten shouldn't leave it answering the room all day.
 * Note mode is exempt: it exists to sit through a long discussion.
 */
function armSleep() {
  clearTimeout(sleepTimer);
  if (mode !== MODE.AWAKE && mode !== MODE.CHAT) return;
  sleepTimer = setTimeout(() => setMode(MODE.ASLEEP, 'going back to sleep'), config.awakeTimeoutMs);
}

function startNotes() {
  notes.start();
  setMode(MODE.NOTE, `okay, I'm taking notes. Say ${wakePhrase()} stop when you're done.`);
}

function finishNotes() {
  if (!notes.active) return;
  if (notes.count === 0) {
    notes.discard();
    setMode(MODE.ASLEEP, "I didn't catch anything worth noting.");
    return;
  }
  const transcript = notes.transcript();
  // "falcon stop" means stop, in note mode as much as anywhere else. Landing
  // awake here left it answering a room that had just finished talking to each
  // other, which is the one situation note mode exists to avoid. Silent,
  // because the spoken summary a moment later is the acknowledgement.
  setMode(MODE.ASLEEP, null);
  view.note(`summarizing ${notes.count} utterances…`);
  pendingSummary = true;
  ask(SUMMARY_PROMPT + transcript, { silent: true });
}

/** Publishes the list after anything changes it. */
function pushTodos() {
  view.todos(todos.snapshot());
}

/**
 * Runs a to-do instruction. Shared by speech, typing and the window's buttons,
 * so all three behave identically and there is one place to get it right.
 *
 * @returns {boolean} whether the utterance was a to-do command at all
 */
function handleTodo(parsed) {
  if (!parsed) return false;

  if (parsed.action === 'add') {
    const item = todos.add(parsed.text);
    pushTodos();
    speaker.say(item ? `Added. That's ${todos.open.length} on your list.` : 'There was nothing to add.');
    return true;
  }

  if (parsed.action === 'list') {
    speaker.say(todos.spoken());
    view.note(todos.open.map((item, i) => `${i + 1}. ${item.text}`).join('\n') || 'list is empty');
    return true;
  }

  const item = todos.byOrdinal(parsed.index);
  if (!item) {
    // Saying which numbers exist beats "not found" when you cannot see a screen.
    const count = todos.open.length;
    speaker.say(count === 0 ? 'Your list is empty.' : `I only have ${count} on the list.`);
    return true;
  }

  if (parsed.action === 'done') {
    todos.complete(item.id);
    pushTodos();
    speaker.say(`Done: ${item.text}.`);
    return true;
  }

  if (parsed.action === 'remove') {
    todos.remove(item.id);
    pushTodos();
    speaker.say(`Removed: ${item.text}.`);
    return true;
  }

  if (parsed.action === 'issue') {
    fileIssue(item.id);
    return true;
  }

  return false;
}

/**
 * Files a to-do as a GitHub issue. Never called on its own — only from an
 * explicit instruction or a button press, because an issue is public and
 * awkward to withdraw.
 */
async function fileIssue(id) {
  const item = todos.get(id);
  if (!item) return;
  if (item.issue) {
    speaker.say(`That is already issue ${item.issue.number}.`);
    return;
  }

  view.note(`filing "${item.text}" as a GitHub issue…`);
  try {
    const issue = await createIssue({
      title: item.text,
      body: 'Filed by opus voice from a spoken to-do.',
      cwd: workdir,
    });
    todos.linkIssue(item.id, issue);
    pushTodos();
    view.note(`filed ${issue.url}`);
    speaker.say(`Filed as issue ${issue.number}.`);
  } catch (err) {
    view.error(`could not file the issue: ${err.message}`);
    speaker.say(`I could not file that — ${err.message}.`);
  }
}

function handleUtterance(text, { typed = false } = {}) {
  const parsed = parseWake(text);

  // While taking notes the only thing worth listening for is the stop phrase.
  if (mode === MODE.NOTE) {
    if (parsed.wake && (parsed.command === 'stop' || parsed.command === 'summarize')) {
      finishNotes();
      return;
    }
    notes.add(text);
    view.heard(text);
    return;
  }

  if (parsed.wake) {
    switch (parsed.command) {
      case 'note': startNotes(); return;
      case 'chat': setMode(MODE.CHAT, "sure, let's talk."); return;
      case 'stop': sleep(); return;
      case 'summarize': setMode(MODE.AWAKE, "there's nothing to summarize yet."); return;
      case 'ask':
        if (mode === MODE.ASLEEP) setMode(MODE.AWAKE, null);
        // A list instruction is not a question, and must not cost a turn.
        if (handleTodo(parseTodo(parsed.rest))) { armSleep(); return; }
        ask(parsed.rest);
        return;
      default:
        setMode(MODE.AWAKE, 'yes?');
        return;
    }
  }

  // Already listening to you: "go to sleep" should end the conversation rather
  // than become a question about sleep. Asleep is excluded for speech so the
  // room can say "stop" to each other without waking anything — but typing is
  // deliberate. Without the `typed` escape, typing "stop" at a sleeping app
  // falls through to the question path below and asks Claude about the word
  // "stop", which is the exact opposite of what was asked for.
  if (mode !== MODE.ASLEEP || typed) {
    if (handleTodo(parseTodo(text))) {
      if (mode === MODE.ASLEEP) setMode(MODE.AWAKE, null);
      else armSleep();
      return;
    }
    switch (parseCommand(text)) {
      case 'stop': sleep(); return;
      case 'note': startNotes(); return;
      case 'chat': setMode(MODE.CHAT, "sure, let's talk."); return;
      default: break;   // 'summarize' has nothing to summarize outside note mode
    }
  }

  // Typing is deliberate, so it never needs a wake word.
  if (mode === MODE.ASLEEP && !typed) {
    // Asleep means asleep. Every stray sentence in the room reaches here, and
    // recording them filled the transcript with garbled half-heard noise that
    // read as if it were still working. The interim line already shows what the
    // microphone is picking up and clears itself, so nothing is hidden by
    // keeping the transcript to things actually addressed to it.
    if (config.showIgnored) view.ignored(text);
    return;
  }
  if (mode === MODE.ASLEEP) setMode(MODE.AWAKE, null);

  // Awake or chatting: an ordinary question.
  armSleep();
  ask(text);
}

// MARK: voice events

voice.on('ready', (event) => {
  voice.configure({
    voice: config.voice,
    rate: config.rate,
    pitch: config.pitch,
    endpointMs: config.endpointMs,
    endpointFastMs: config.endpointFastMs,
    bargeInWords: config.bargeInWords,
  });
  view.banner({
    voice: event.voice,
    model: config.model,
    onDevice: event.onDevice,
    workdir,
    engine: speaker.name,
    locale: event.locale,
    recognizer: event.recognizer,
    wakePhrase: wakePhrase(),
  });
  if (!event.onDevice) {
    view.warn('on-device speech model missing — recognition is going over the network');
  }
  pushTodos();
  if (config.greeting) speaker.say(config.greeting);
  view.mode(mode);

  started = true;
  const backlog = typedBacklog.splice(0);
  for (const line of backlog) handleUtterance(line, { typed: true });
});

voice.on('partial', (text) => {
  // Asleep it shows nothing at all. A live transcript of the room scrolling past
  // is exactly the "it is still listening" feeling that sleeping exists to
  // remove, and there is nothing to report until the phrase arrives.
  if (mode === MODE.ASLEEP && !config.showIgnored) return;
  view.hearing(text);
});

voice.on('final', (text) => {
  view.clearLive();
  handleUtterance(text);
});

voice.on('bargein', () => {
  if (!claude.busy && !turn.spoke) return;
  turn.aborted = true;
  clearTimeout(turn.fillerTimer);
  speaker.stop();
  chunker.flush();
  if (turn.line) view.interrupted();
});

voice.on('speech-start', () => view.speaking(true));

voice.on('speech-end', () => {
  view.speaking(false);
  if (!claude.busy && !voice.speaking) view.clearLive();
});

voice.on('warn', (message) => view.warn(message));

// Recognition failing looks identical to nobody talking, so say it out loud
// once rather than leaving the user staring at a prompt that never responds.
let recogReported = false;
voice.on('recog-error', (event) => {
  if (recogReported) return;
  recogReported = true;
  view.error(`speech recognition failed: ${event.message}`);
  if (/siri|dictation/i.test(event.message)) {
    view.note('fix: System Settings › Keyboard › Dictation → turn it on, wait for the');
    view.note('language download to finish, then restart. Run `npm run mic-test` to verify.');
  }
});

voice.on('error', (err) => {
  view.error(err.message);
  if (err.fatal) shutdown(1);
});

voice.on('exit', () => shutdown(1));

// MARK: model events

// A tool call is dead air with no spinner to look at, so it gets narrated. Later
// calls in the same turn only speak if the silence has actually dragged on.
claude.on('tool', (name) => {
  if (turn.aborted) return;
  const first = turn.tools === 0;
  turn.tools += 1;
  view.tool(name);
  clearTimeout(turn.fillerTimer);

  if (!config.narrateTools) return;
  if (!first && Date.now() - turn.lastNarration < 6000) return;
  turn.lastNarration = Date.now();
  turn.spoke = true;              // suppress the "let me think" beat
  speaker.say(narrate(name, first));
});

claude.on('delta', (text) => {
  if (turn.aborted) return;
  // Kept verbatim: the notes file wants the model's real markdown, not the
  // stripped-down version built for the synthesizer.
  turn.raw += text;
  for (const sentence of chunker.push(text)) say(sentence);
});

// End of a text block: speak whatever is buffered rather than holding it until
// after the next tool call.
claude.on('text-end', () => {
  for (const sentence of chunker.flush()) say(sentence);
});

claude.on('turn-end', () => {
  for (const sentence of chunker.flush()) say(sentence);
  clearTimeout(turn.fillerTimer);
  if (!voice.speaking) view.clearLive();
  // The countdown measures silence after the answer, not after the question —
  // a long answer must not put it to sleep while it is still talking.
  armSleep();

  if (pendingSummary) {
    pendingSummary = false;
    turn.silent = false;
    const { title, actions, written, spoken } = splitSummary(turn.raw);
    try {
      const file = notes.save(workdir, written, title);
      view.note(`notes saved to ${file}`);

      // Action items become to-dos rather than a paragraph you have to reread.
      // They are added, never filed as issues — that stays an explicit act.
      const added = actions.filter((text) => todos.add(text, { source: 'notes' })).length;
      if (added) {
        pushTodos();
        view.note(`${added} action item${added === 1 ? '' : 's'} added to your list`);
      }

      const tail = added ? ` I put ${added === 1 ? 'one action item' : `${added} action items`} on your list.` : '';
      speaker.say(`${spoken || 'Notes saved.'}${tail}`);
    } catch (err) {
      view.error(`could not save notes: ${err.message}`);
    }
  }

  if (turn.queued) {
    const next = turn.queued;
    turn.queued = null;
    ask(next);
  }
});

claude.on('error', (err) => view.error(err.message));
claude.on('exit', (code) => {
  view.error(`claude exited (code ${code})`);
  shutdown(1);
});

// MARK: the window

// The window is another way in, not another brain: everything it sends lands in
// the same handleUtterance the microphone feeds, so there is one set of rules
// about what wakes it, what it answers, and when it sleeps.
let server = null;
let shell = null;

function handleCommand(command) {
  switch (command?.cmd) {
    case 'say':
      // Typed from the window: deliberate, so it skips the wake word exactly as
      // typing into the terminal does.
      if (typeof command.text === 'string' && command.text.trim()) {
        handleUtterance(command.text.trim(), { typed: true });
      }
      break;
    case 'mode':
      if (command.mode === 'chat') setMode(MODE.CHAT, "sure, let's talk.");
      else if (command.mode === 'note') startNotes();
      else if (command.mode === 'stop') {
        if (mode === MODE.NOTE) finishNotes();
        else sleep();
      }
      break;
    case 'todo':
      // The window sends real ids, not spoken ordinals: it can see the list, so
      // there is nothing to resolve and nothing to mis-hear.
      if (command.action === 'add' && typeof command.text === 'string') {
        if (todos.add(command.text, { source: 'window' })) pushTodos();
      } else if (command.action === 'done') {
        if (todos.complete(command.id)) pushTodos();
      } else if (command.action === 'reopen') {
        if (todos.reopen(command.id)) pushTodos();
      } else if (command.action === 'remove') {
        if (todos.remove(command.id)) pushTodos();
      } else if (command.action === 'issue') {
        fileIssue(command.id);
      }
      break;

    case 'interrupt':
      // The same thing talking over it does, for when you would rather not.
      turn.aborted = true;
      clearTimeout(turn.fillerTimer);
      speaker.stop();
      chunker.flush();
      if (turn.line) view.interrupted();
      break;
    default:
      break;
  }
}

async function openWindow() {
  server = new UiServer(conversation, handleCommand, { port: config.uiPort });
  const url = await server.listen();

  const binary = path.join(ROOT, 'bin/voiceapp');
  if (fs.existsSync(binary)) {
    shell = spawn(binary, [url], { stdio: 'ignore' });
    // Closing the window ends the session — it is the whole interface when you
    // launched it this way.
    shell.on('exit', () => shutdown(0));
    shell.on('error', () => view.warn(`window failed to open — visit ${url}`));
  } else {
    view.warn('bin/voiceapp is not built — opening in your browser instead');
    spawn('open', [url], { stdio: 'ignore' });
  }
  // Printed so a second window, or a browser, can be pointed at the same
  // session — the token is what makes the URL work.
  view.note(`window at ${url}`);
  return url;
}

// MARK: typed input + shutdown

const keyboard = readline.createInterface({ input: process.stdin, terminal: false });
keyboard.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  // Audio setup takes a moment; holding early input keeps the banner from
  // landing in the middle of a turn.
  if (!started) typedBacklog.push(text);
  else handleUtterance(text, { typed: true });
});

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(turn.fillerTimer);
  view.close();
  server?.close();
  shell?.kill();
  keyboard.close();
  speaker.close();
  voice.close();
  claude.close();
  setTimeout(() => process.exit(code), 100).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Opened before the audio device is ready so there is a window to look at while
// permissions and the recognizer come up, rather than ten seconds of nothing.
if (config.ui) {
  openWindow().catch((err) => view.error(`could not open the window: ${err.message}`));
}
