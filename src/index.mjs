#!/usr/bin/env node
// opus voice — hands-free spoken conversation with Claude in the terminal.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { ClaudeSession } from './claude.mjs';
import { VoiceIO } from './voice.mjs';
import { SpeechChunker } from './chunk.mjs';
import { nextFiller, narrate } from './style.mjs';
import { Speaker } from './speaker.mjs';
import { Ui } from './ui.mjs';
import { loadConfig, resolveWorkdir } from './config.mjs';
import { parseWake, parseCommand } from './wake.mjs';
import { Notes, SUMMARY_PROMPT, splitSummary } from './notes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const config = loadConfig();
const workdir = resolveWorkdir(config);

const ui = new Ui();
const voice = new VoiceIO({ locale: config.locale });
const claude = new ClaudeSession({
  model: config.model,
  effort: config.effort,
  cwd: workdir,
  permissionMode: config.permissionMode,
});
const speaker = new Speaker(voice, { engine: config.tts, piperVoice: config.piperVoice });
speaker.on('warn', (message) => ui.warn(message));
const chunker = new SpeechChunker();
const notes = new Notes();

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
  if (!silent) ui.you(text);
  chunker.reset();
  turn.spoke = false;
  turn.aborted = false;
  turn.line = '';
  turn.labelled = false;
  turn.tools = 0;
  turn.asked = Date.now();
  claude.send(text);
  ui.spin('thinking');

  // The filler only fires if Opus hasn't produced a first sentence yet, so a
  // fast answer never gets a needless "hmm" in front of it.
  clearTimeout(turn.fillerTimer);
  turn.fillerTimer = setTimeout(() => {
    if (!turn.spoke && !turn.aborted) speaker.say(nextFiller());
  }, config.fillerDelayMs);
}

function say(sentence) {
  if (turn.aborted || !sentence) return;
  if (turn.silent) return;
  // `spoke` gates the thinking filler and narration also sets it; the transcript
  // label is tracked separately so the first real sentence still gets labelled.
  const first = !turn.labelled;
  if (first && TIMING) ui.note(`(first word in ${Date.now() - turn.asked}ms)`);
  turn.labelled = true;
  turn.spoke = true;
  clearTimeout(turn.fillerTimer);
  turn.line = sentence;
  ui.opus(sentence, first);
  ui.spin('speaking');
  speaker.say(sentence);
}

// MARK: modes

function setMode(next, spoken) {
  const changed = mode !== next;
  mode = next;
  // Called on every question to refresh the idle timer, so only announce a
  // genuine transition.
  if (changed) ui.mode(next);
  armSleep();
  if (spoken) speaker.say(spoken);
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
  setMode(MODE.NOTE, "okay, I'm taking notes. Say jarvis stop when you're done.");
}

function finishNotes() {
  if (!notes.active) return;
  if (notes.count === 0) {
    notes.discard();
    setMode(MODE.AWAKE, "I didn't catch anything worth noting.");
    return;
  }
  const transcript = notes.transcript();
  setMode(MODE.AWAKE, null);
  ui.note(`summarizing ${notes.count} utterances…`);
  pendingSummary = true;
  ask(SUMMARY_PROMPT + transcript, { silent: true });
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
    ui.heard(text);
    return;
  }

  if (parsed.wake) {
    switch (parsed.command) {
      case 'note': startNotes(); return;
      case 'chat': setMode(MODE.CHAT, "sure, let's talk."); return;
      case 'stop': setMode(MODE.ASLEEP, 'going to sleep.'); return;
      case 'summarize': setMode(MODE.AWAKE, "there's nothing to summarize yet."); return;
      case 'ask':
        if (mode === MODE.ASLEEP) setMode(MODE.AWAKE, null);
        ask(parsed.rest);
        return;
      default:
        setMode(MODE.AWAKE, 'yes?');
        return;
    }
  }

  // Already listening to you: "go to sleep" should end the conversation rather
  // than become a question about sleep. Asleep is excluded so the room can say
  // "stop" to each other without waking anything.
  if (mode !== MODE.ASLEEP) {
    switch (parseCommand(text)) {
      case 'stop': setMode(MODE.ASLEEP, 'going to sleep.'); return;
      case 'note': startNotes(); return;
      case 'chat': setMode(MODE.CHAT, "sure, let's talk."); return;
      default: break;   // 'summarize' has nothing to summarize outside note mode
    }
  }

  // Typing is deliberate, so it never needs a wake word.
  if (mode === MODE.ASLEEP && !typed) {
    ui.ignored(text);
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
  ui.banner({
    voice: event.voice,
    model: config.model,
    onDevice: event.onDevice,
    workdir,
    engine: speaker.name,
    locale: event.locale,
  });
  if (!event.onDevice) {
    ui.warn('on-device speech model missing — recognition is going over the network');
  }
  if (config.greeting) speaker.say(config.greeting);
  ui.mode(mode);

  started = true;
  const backlog = typedBacklog.splice(0);
  for (const line of backlog) handleUtterance(line, { typed: true });
});

voice.on('partial', (text) => ui.hearing(text));

voice.on('final', (text) => {
  ui.clearLive();
  handleUtterance(text);
});

voice.on('bargein', () => {
  if (!claude.busy && !turn.spoke) return;
  turn.aborted = true;
  clearTimeout(turn.fillerTimer);
  speaker.stop();
  chunker.flush();
  if (turn.line) ui.note('(interrupted)');
});

voice.on('speech-end', () => {
  if (!claude.busy && !voice.speaking) ui.clearLive();
});

voice.on('warn', (message) => ui.warn(message));

// Recognition failing looks identical to nobody talking, so say it out loud
// once rather than leaving the user staring at a prompt that never responds.
let recogReported = false;
voice.on('recog-error', (event) => {
  if (recogReported) return;
  recogReported = true;
  ui.error(`speech recognition failed: ${event.message}`);
  if (/siri|dictation/i.test(event.message)) {
    ui.note('fix: System Settings › Keyboard › Dictation → turn it on, wait for the');
    ui.note('language download to finish, then restart. Run `npm run mic-test` to verify.');
  }
});

voice.on('error', (err) => {
  ui.error(err.message);
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
  ui.spin(`${name.toLowerCase()}…`);
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
  if (!voice.speaking) ui.clearLive();
  // The countdown measures silence after the answer, not after the question —
  // a long answer must not put it to sleep while it is still talking.
  armSleep();

  if (pendingSummary) {
    pendingSummary = false;
    turn.silent = false;
    const { written, spoken } = splitSummary(turn.raw);
    try {
      const file = notes.save(workdir, written);
      ui.note(`notes saved to ${file}`);
      speaker.say(spoken || 'Notes saved.');
    } catch (err) {
      ui.error(`could not save notes: ${err.message}`);
    }
  }

  if (turn.queued) {
    const next = turn.queued;
    turn.queued = null;
    ask(next);
  }
});

claude.on('error', (err) => ui.error(err.message));
claude.on('exit', (code) => {
  ui.error(`claude exited (code ${code})`);
  shutdown(1);
});

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
  ui.close();
  keyboard.close();
  speaker.close();
  voice.close();
  claude.close();
  setTimeout(() => process.exit(code), 100).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
