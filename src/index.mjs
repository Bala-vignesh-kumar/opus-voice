#!/usr/bin/env node
// Falcon — hands-free spoken conversation with Claude in the terminal.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { spawn } from 'node:child_process';

import { ClaudeSession } from './claude.mjs';
import { GatewaySession } from './gateway.mjs';
import { VoiceIO } from './voice.mjs';
import { SpeechChunker } from './chunk.mjs';
import { nextFiller, narrate, SYSTEM_PROMPT } from './style.mjs';
import { Speaker } from './speaker.mjs';
import { Ui } from './ui.mjs';
import { Conversation } from './bus.mjs';
import { makeView } from './view.mjs';
import { UiServer } from './server.mjs';
import { loadConfig, resolveWorkdir } from './config.mjs';
import { parseWake, parseCommand, setWakePhrase, wakePhrase } from './wake.mjs';
import { Notes, SUMMARY_PROMPT, splitSummary } from './notes.mjs';
import { History } from './history.mjs';
import { Todos } from './todos.mjs';
import { parseTodo } from './todo-commands.mjs';
import { createIssue } from './github.mjs';
import { Whisper, available as whisperAvailable } from './whisper.mjs';
import { acceptable } from './transcript-guard.mjs';
import { EchoGuard } from './echo-guard.mjs';
import { Trigger, FILE as WAKE_FILE, HOOK } from './trigger.mjs';
import { checkShortcut } from './siri.mjs';
import { migrate } from './migrate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const config = loadConfig();
const workdir = resolveWorkdir(config);
setWakePhrase(config.wakePhrase);

const ui = new Ui();
// The conversation as data. The terminal renders it as it happens; the window
// needs to be able to ask for all of it at once, so it is kept rather than
// printed and forgotten.
const conversation = new Conversation();
const history = new History({ dir: config.chatsDir || undefined, workdir: config.dir });
const view = makeView(ui, conversation, history);

// This app used to be called opus voice, and everything it remembered lived
// under ~/.opus-voice. Carried across on the first run under the new name; the
// old directory is left alone as the backup.
//
// Skipped when `chatsDir` points somewhere else. That is either a test run or
// somebody who has deliberately moved their conversations, and neither has
// anything to bring over from a default location they are not using.
if (!config.chatsDir) {
  const carried = migrate();
  if (carried.problem) {
    view.warn(`could not carry the old conversations across: ${carried.problem}`);
    view.warn('they are still in ~/.opus-voice — nothing was lost');
  } else if (carried.migrated) {
    const many = carried.chats === 1 ? 'conversation' : 'conversations';
    view.note(`carried ${carried.chats} ${many} over from ~/.opus-voice, which is kept as a backup`);
    if (carried.hook) view.note('the Siri hook now points at the new wake file');
  }
}

const voice = new VoiceIO({
  locale: config.locale,
  echoCancellation: config.echoCancellation,
  micDevice: config.micDevice,
});
// Named `claude` throughout because everything downstream only knows the
// interface: same events, same four methods, whichever one answers.
const usingGateway = config.backend === 'gateway';
if (usingGateway && !process.env.EXPLABS_API_KEY) {
  view.error('--backend gateway needs EXPLABS_API_KEY in the environment');
  process.exit(1);
}
const claude = usingGateway
  ? new GatewaySession({
    url: config.gatewayUrl,
    model: config.gatewayModel,
    apiKey: process.env.EXPLABS_API_KEY,
    systemPrompt: SYSTEM_PROMPT,
  })
  : new ClaudeSession({
    model: config.model,
    effort: config.effort,
    cwd: workdir,
    permissionMode: config.permissionMode,
    bin: config.claudeBin || process.env.FALCON_CLAUDE_BIN,
  });
// Said out loud once at startup rather than buried in a log: this is the one
// mode where what you say leaves the machine, and it should never be a surprise.
if (usingGateway) view.warn(`answering with ${config.gatewayModel} over the network — it cannot read your code, and your words leave this machine`);
const speaker = new Speaker(voice, {
  engine: config.tts,
  piperVoice: config.piperVoice,
  // Passed in rather than attached afterwards: a missing Piper voice is
  // reported from inside the constructor, so a later listener misses it.
  onWarn: (message) => view.warn(message),
});

// What it has said out loud lately, so it can refuse to hear it back. Fed from
// the speaker itself rather than from the seventeen places that call it.
const echo = new EchoGuard({ window: config.echoWindowMs });
speaker.on('said', (text) => echo.said(text));
// Local Whisper supplies the text that reaches Claude; Apple's recognizer keeps
// driving partials, barge-in and endpointing, which is what it is good at. Not
// installed means we use Apple's text everywhere, exactly as before this existed.
let whisper = null;
if (config.stt === 'whisper') {
  if (whisperAvailable() || process.env.FALCON_WHISPER_SERVER) {
    whisper = new Whisper({
      model: config.whisperModel,
      timeoutMs: config.whisperTimeoutMs,
      // The project's own name is the word most likely to be said and least
      // likely to be known, so it is seeded automatically.
      vocabulary: [...new Set([...(config.vocabulary || []), path.basename(workdir)])].filter(Boolean),
      bin: process.env.FALCON_WHISPER_BIN,
      server: process.env.FALCON_WHISPER_SERVER,
    });
    whisper.on('warn', (message) => view.warn(message));
  } else {
    view.warn('whisper is not installed — run npm run install-whisper');
  }
}

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

let started = false;            // voiceio has finished audio setup
const typedBacklog = [];

const turn = {
  spoke: false,       // has any real answer been sent to the synthesizer yet
  aborted: false,     // user interrupted, discard the rest of this generation
  fillerTimer: null,
  queued: null,       // request that arrived while Opus was still answering
  // Whether the turn now running is the note summary. On the turn rather than
  // in a module-level flag: set globally, it was already true while an earlier
  // answer was still in flight, and that answer's turn-end claimed it and was
  // written to disk as the note.
  summary: false,
  line: '',           // accumulated text for the transcript display
  labelled: false,    // has the transcript printed the "falcon" prefix this turn
  tools: 0,           // tool calls so far this turn
  lastNarration: 0,
  asked: 0,
  silent: false,      // suppress speech; used while summarizing notes
  raw: '',            // unmodified model output, for writing to disk
};

// Whether the CLI has told us it is out of quota.
//
// Not a transient error: it will answer nothing at all until the limit resets,
// and every failed turn still spoke a thinking beat on its way to failing —
// which through laptop speakers is what fed the echo loop. So it is said once,
// out loud, and the beat stops. Cleared by the first real sentence of an answer,
// which is the only proof that the limit has lifted.
let quotaBlocked = false;

/** The shapes the CLI reports a limit in. */
const QUOTA = /\b(?:spend|usage|rate) limit\b|\blimit reached\b|\bquota\b/i;

// FALCON_TIMING=1 reports how long until the first real word is spoken,
// which is the number that actually decides whether this feels live.
const TIMING = Boolean(process.env.FALCON_TIMING);

// MARK: turn lifecycle

function ask(text, { silent = false, summary = false } = {}) {
  if (claude.busy) {
    // The whole request, not just its words. Queueing the text alone dropped
    // `silent`, so a summary that had to wait was read out loud — prompt,
    // transcript and all — to the room it had just been recorded from.
    turn.queued = { text, silent, summary };
    return;
  }
  turn.silent = silent;
  turn.summary = summary;
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
    if (!turn.spoke && !turn.aborted && !quotaBlocked) speaker.say(nextFiller(text));
  }, config.fillerDelayMs);
}

function say(sentence) {
  if (turn.aborted || !sentence) return;
  if (turn.silent) return;
  // `spoke` gates the thinking filler and narration also sets it; the transcript
  // label is tracked separately so the first real sentence still gets labelled.
  // It answered, so whatever was stopping it has lifted.
  quotaBlocked = false;
  const first = !turn.labelled;
  if (first && TIMING) view.note(`(first word in ${Date.now() - turn.asked}ms)`);
  turn.labelled = true;
  turn.spoke = true;
  clearTimeout(turn.fillerTimer);
  turn.line = sentence;
  view.falcon(sentence, first);
  view.spin('speaking');
  speaker.say(sentence);
}

// MARK: modes

function setMode(next, spoken) {
  const changed = mode !== next;
  mode = next;
  // With holdMic off the microphone is handed back whenever it sleeps, so the
  // app leaves no trace of listening at all between conversations. Nothing it
  // can hear will wake it after that — the Shortcut does that instead.
  if (changed && !config.holdMic && started) voice.standby(next === MODE.ASLEEP);
  // Called on every question to refresh the idle timer, so only announce a
  // genuine transition.
  if (changed) view.mode(next);
  // The conversation is over; nothing it said is still in the air. Before the
  // line below, so that one is remembered.
  if (changed && next === MODE.ASLEEP) echo.clear();
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
  ask(SUMMARY_PROMPT + transcript, { silent: true, summary: true });
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
      body: 'Filed by Falcon from a spoken to-do.',
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
      case 'summarize':
        // Note mode is handled above, so reaching here with a discussion still
        // held means an earlier summary was interrupted. Retry it.
        if (notes.active) { finishNotes(); return; }
        setMode(MODE.AWAKE, "there's nothing to summarize yet.");
        return;
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
      case 'summarize':
        // Only means anything if an interrupted summary is still waiting.
        if (notes.active) { finishNotes(); return; }
        break;
      default: break;
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
    micDevice: config.micDevice,
    trace: config.trace,
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
    // How it can actually be woken right now. With the microphone released the
    // wake phrase cannot reach it, and printing it anyway is a lie the user
    // discovers by talking to something that is not listening.
    wakeHint: config.holdMic ? `"${wakePhrase()}"` : `"hey siri, ${config.siriPhrase}"`,
  });
  if (!event.onDevice) {
    view.warn('on-device speech model missing — recognition is going over the network');
  }
  pushTodos();
  if (!config.holdMic) {
    voice.standby(mode === MODE.ASLEEP);
    // Releasing the mic means nothing it can hear will wake it. If the Siri
    // hook is not installed there is then no way in but typing, and an app that
    // silently ignores you is the worst possible outcome — so say so loudly.
    if (fs.existsSync(HOOK)) {
      view.note(`microphone released while asleep — say "hey siri, ${config.siriPhrase}" to wake it`);
      // The hook existing proves half of it. Siri finds a Shortcut by name and
      // nothing else, so a correct Shortcut under the wrong name is invisible
      // and the app just seems to ignore you.
      checkShortcut(config.siriPhrase).then(({ ok, message }) => {
        if (ok || !message) return;
        view.warn(message);
        view.warn('rename it, or set "siriPhrase" to match');
      });
    } else {
      view.warn('mic released, but no Siri hook — nothing you say can wake it');
      view.warn('run:  npm run siri');
      view.warn('or set "holdMic": true to listen for the wake phrase instead');
    }
  }
  if (config.greeting) speaker.say(config.greeting);
  view.mode(mode);

  started = true;
  const backlog = typedBacklog.splice(0);
  for (const line of backlog) handleUtterance(line, { typed: true });
});

// The last thing it heard but has not finished hearing, kept so barge-in can be
// asked whether the voice interrupting is its own.
let lastPartial = '';

voice.on('partial', (text) => {
  lastPartial = text;
  // Asleep it shows nothing at all. A live transcript of the room scrolling past
  // is exactly the "it is still listening" feeling that sleeping exists to
  // remove, and there is nothing to report until the phrase arrives.
  if (mode === MODE.ASLEEP && !config.showIgnored) return;
  view.hearing(text);
});

// The audio behind the turn, kept only until its `final` arrives.
let lastUtterance = null;
voice.on('utterance', (event) => {
  lastUtterance = event;
  // FALCON_DUMP_AUDIO=/tmp/dump writes each turn's audio as a wav, so what
  // the second recognizer was actually handed can be listened to rather than
  // reasoned about.
  // Config as well as env, because the bundled app is launched by macOS and
  // never sees a shell environment.
  if (config.dumpAudio || process.env.FALCON_DUMP_AUDIO) dumpUtterance(event);
});

/** Writes one turn's audio to <prefix>-N.wav. Debug only. */
let dumpCount = 0;
function dumpUtterance(event) {
  // Buffer.from() allocates out of a shared pool, so .buffer is the whole pool
  // and slicing from zero reads somebody else's bytes. The offset and length
  // are not optional here — without them this wrote silence and I nearly
  // diagnosed a live bug from it.
  const raw = Buffer.from(event.pcm, 'base64');
  const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const rate = event.sampleRate || 16000;
  const pcm16 = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    pcm16.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm16.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm16.length, 40);
  const prefix = config.dumpAudio || process.env.FALCON_DUMP_AUDIO;
  const file = `${prefix}-${++dumpCount}.wav`;
  fs.writeFileSync(file, Buffer.concat([header, pcm16]));
  view.note(`audio dumped to ${file} (${(samples.length / rate).toFixed(1)}s, peak ${event.peak?.toFixed(3)})`);
}

voice.on('final', async (text) => {
  view.clearLive();
  lastPartial = '';
  const audio = lastUtterance;
  lastUtterance = null;

  let heard = text;
  if (whisper && audio?.pcm) {
    const better = await whisper.transcribe(audio.pcm, audio.sampleRate);
    // Only take Whisper's word for it when what came back is plausibly speech.
    // It invents stock phrases out of silence, and a turn nobody spoke is worse
    // than a turn transcribed less well.
    if (acceptable(better, audio.peak)) heard = better;
  }

  // Its own voice, back down its own microphone. Said in the transcript rather
  // than dropped quietly: a microphone that swallows turns without saying so is
  // the one failure this app has no way to explain afterwards. It also keeps
  // the app from taking its own "going to sleep." for an instruction.
  if (echo.isEcho(heard)) {
    view.note(`ignored its own voice: "${heard}"`);
    return;
  }

  handleUtterance(heard);
});

voice.on('bargein', () => {
  if (!claude.busy && !turn.spoke) return;
  // Two words are enough to count as an interruption, and "hang on" is two
  // words. Without this it hears its own thinking beat and cuts itself off to
  // listen to itself.
  if (echo.isEcho(lastPartial)) return;
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

voice.on('level', ({ source, rms }) => view.level(source, rms));

voice.on('standby', (on) => view.note(on ? 'microphone released' : 'microphone open'));
voice.on('note', (message) => view.note(message));
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

// Losing the audio daemon used to end the app, which meant that unplugging
// headphones — the device goes, the daemon goes with it — killed an assistant
// that was otherwise perfectly able to keep working. It is replaced instead.
// Three deaths in a minute is a real fault rather than a route change, and that
// still stops, because respawning into a broken device forever is worse.
let voiceRestarts = [];
voice.on('exit', () => {
  // Same reason as the Claude session below: a daemon we killed ourselves is
  // not a daemon that died, and restarting it here reopens the microphone
  // during the teardown whose job is to hand it back.
  if (closing) return;
  const now = Date.now();
  voiceRestarts = voiceRestarts.filter((at) => now - at < 60_000);
  voiceRestarts.push(now);
  if (voiceRestarts.length > 3) {
    view.error('the audio daemon keeps dying — stopping');
    shutdown(1);
    return;
  }
  view.warn('audio device changed — restarting the microphone');
  voice.restart();
});

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

  if (turn.summary) {
    turn.summary = false;
    turn.silent = false;
    // Interrupted mid-summary, or the model produced nothing. The discussion is
    // still held — writing an empty file over it, and then clearing it, would
    // lose the one thing note mode exists to keep. Say so and leave it staged
    // so "hey falcon summarize" can try again.
    if (turn.aborted || !turn.raw.trim()) {
      view.warn('the summary was interrupted — the discussion is still held');
      view.note(`say "${wakePhrase()} summarize" to write it`);
      speaker.say('I did not finish those notes. Say summarize when you want them.');
    } else {
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
  }

  if (turn.queued) {
    const next = turn.queued;
    turn.queued = null;
    ask(next.text, { silent: next.silent, summary: next.summary });
  }
});

claude.on('error', (err) => view.error(err.message));

// The reason it died, which used to be dropped on the floor: the CLI reports
// rate limits and expired auth here and then exits, and without this the app
// went down with nothing on screen but an exit code.
claude.on('stderr', (text) => {
  const line = text.split('\n')[0].slice(0, 200);
  view.warn(line);
  // Whoever asked is not looking at the screen — a red line they cannot see is
  // the same as silence, and silence from this reads as the app being broken.
  if (!QUOTA.test(line) || quotaBlocked) return;
  quotaBlocked = true;
  clearTimeout(turn.fillerTimer);
  speaker.say("I've hit the Claude usage limit, so I can't answer until it resets.");
});

// A session that exits used to take the whole app with it. That was survivable
// when this was a terminal program you had just typed into; it is not, now that
// it starts at login and owns the screen — the machine you were talking to
// simply vanishes, most often because a five-hour rate limit ran out.
//
// So the session is replaced instead. Twice in quick succession means it is not
// coming back (bad flags, no auth), and that does end the app rather than
// respawning forever.
let claudeRestarts = [];
claude.on('exit', (code, reason) => {
  // Shutting down kills this on purpose. Without the guard, quitting announced
  // a lost connection and spawned a replacement session on its way out.
  if (closing) return;
  const now = Date.now();
  claudeRestarts = claudeRestarts.filter((at) => now - at < 60_000);
  claudeRestarts.push(now);

  const detail = reason ? ` — ${reason}` : '';
  if (claudeRestarts.length > 2) {
    view.error(`claude exited (code ${code})${detail}`);
    shutdown(1);
    return;
  }

  view.error(`claude exited (code ${code})${detail} — starting a new session`);
  // The same cleanup an interruption does: the half-finished turn is not coming
  // back, and its filler timer would otherwise fire into the new session.
  turn.aborted = true;
  clearTimeout(turn.fillerTimer);
  chunker.flush();
  if (turn.line) view.interrupted();
  claude.restart();
  // Said out loud because the whole point of this thing is that you are not
  // looking at it: an answer that never arrives is otherwise indistinguishable
  // from it having ignored you.
  speaker.say("I lost my connection to Claude, so I've started a new session. That last answer is gone.");
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
  server = new UiServer(conversation, handleCommand, {
    port: config.uiPort,
    sessionFile: config.sessionFile || undefined,
    workdir: config.dir,
    chatsDir: history.dir,
  });
  const url = await server.listen();

  // The menu bar app is the parent when it launched us, and it opens the window
  // itself on demand. Spawning one here would put a window on screen at every
  // login, which is the thing a menu bar app exists to avoid.
  if (!config.spawnWindow) {
    view.note(`serving the window at ${url}`);
    return url;
  }

  const binary = path.join(ROOT, 'bin/falcon-window');
  if (fs.existsSync(binary)) {
    // No arguments: the window reads the session file, because the url carries
    // the token and argv is world-readable.
    shell = spawn(binary, [], { stdio: 'ignore' });
    // Closing the window ends the session — it is the whole interface when you
    // launched it this way.
    shell.on('exit', () => shutdown(0));
    shell.on('error', () => view.warn(`window failed to open — visit ${url}`));
  } else {
    view.warn('bin/falcon-window is not built — opening in your browser instead');
    spawn('open', [url], { stdio: 'ignore' });
  }
  // Printed so a second window, or a browser, can be pointed at the same
  // session — the token is what makes the URL work.
  view.note(`window at ${url}`);
  return url;
}

// Woken from outside: a Siri Shortcut, a hotkey, anything that can touch a file.
const trigger = new Trigger();
trigger.on('wake', () => {
  if (mode === MODE.NOTE) return;
  view.note('woken from outside');
  // Silent on purpose. This wake came from a button — a squeeze, a Shortcut, a
  // hotkey — and whoever pressed it already knows they did. Saying "yes?" back
  // lands on top of the first words out of their mouth, because a person who
  // presses a button to talk starts talking immediately.
  //
  // Speaking still makes sense for the spoken wake phrase, which stays as it
  // was: there, "yes?" is what tells you it heard its name.
  if (mode === MODE.ASLEEP) setMode(MODE.AWAKE, config.wakeAck || null);
  else armSleep();
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
  clearTimeout(sleepTimer);
  // Closes the conversation that was still open, so a session ended with ctrl-c
  // is filed under when it ended rather than left looking like it never did.
  history.end();
  view.close();
  server?.close();
  shell?.kill();
  keyboard.close();
  speaker.close();
  whisper?.close();
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
