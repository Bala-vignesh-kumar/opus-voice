// End-to-end: boots the real app with a stub daemon and a stub Claude, then
// drives it the way a person does — by typing — and asserts on what it printed
// and on which turns actually reached Claude.
//
// Everything except the audio hardware and the model is the real thing: config
// loading, wake parsing, mode transitions, the speaker queue and the terminal
// view all run as they do in production.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUBS = path.join(ROOT, 'test', 'stubs');

/** Terminal output is full of colour; assertions care about the words. */
const strip = (text) => text.replace(/\[[0-9;]*m/g, '');

class App {
  /** Always runs in a scratch working directory: the app writes todos.json and
   *  notes/ into it, and a test run must never touch the project. */
  constructor({ dir = null, args = [], wakeFile = null, hook = null, whisperMode = null, env = {} } = {}) {
    this.whisperMode = whisperMode;
    this.args = args;
    this.wakeFile = wakeFile;
    // Point at the real hook by default so tests reflect a set-up machine.
    this.hook = hook ?? path.join(ROOT, 'package.json');
    this.dir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'falcon-e2e-'));
    this.log = path.join(this.dir, 'asked.log');
    this.spokenLog = path.join(this.dir, 'spoken.log');
    this.inject = path.join(this.dir, 'speech.txt');
    fs.writeFileSync(this.log, '');
    fs.writeFileSync(this.spokenLog, '');
    this.out = '';
    this.child = spawn(process.execPath, [
      path.join(ROOT, 'src', 'index.mjs'),
      // Asked for by name rather than inherited from the defaults. The stub in
      // test/stubs/claude.mjs stands in for the CLI, so these cases need that
      // backend whatever the default happens to be — and once the default
      // became the gateway, inheriting it meant every case here booted an app
      // that exited for want of an API key.
      '--backend', 'claude',
      '--tts', 'apple',
      '--greeting', '',
      // Long enough that the idle timer never fires mid-test and turns a
      // routing assertion into a timing one.
      '--awake-timeout-ms', '600000',
      '--dir', this.dir,
      // Without this the run files its conversations under the real
      // ~/.falcon/chats, alongside the ones somebody actually had.
      '--chats-dir', path.join(this.dir, 'chats'),
      // Off unless a test asks for it. Otherwise every case would spawn a real
      // Whisper and load a model, to transcribe audio the stub never recorded.
      ...(whisperMode ? [] : ['--stt', 'apple']),
      ...this.args,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        FALCON_IO_BIN: path.join(STUBS, 'voiceio.mjs'),
        FALCON_CLAUDE_BIN: path.join(STUBS, 'claude.mjs'),
        STUB_CLAUDE_LOG: this.log,
        STUB_VOICE_INJECT: this.inject,
        STUB_VOICE_SPOKEN: this.spokenLog,
        ...(this.wakeFile ? { FALCON_WAKE_FILE: this.wakeFile } : {}),
        FALCON_WAKE_HOOK: this.hook,
        FALCON_IGNORE_CONFIG: '1',
        ...(whisperMode ? {
          STUB_WHISPER_MODE: whisperMode,
          FALCON_WHISPER_BIN: process.execPath,
          FALCON_WHISPER_SERVER: path.join(STUBS, 'whisper_server.mjs'),
        } : {}),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d) => { this.out += strip(String(d)); });
    this.child.stderr.on('data', (d) => { this.out += strip(String(d)); });
  }

  type(text) { this.child.stdin.write(`${text}\n`); }

  /** Injects a recognized utterance, so it routes as speech rather than typing.
   *  The stub daemon turns this into the same `final` event a microphone would. */
  speak(text) { fs.appendFileSync(this.inject, `${text}\n`); }

  /** Waits for text to appear in the app's output. */
  async expect(needle, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.out.includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}\n--- output ---\n${this.out}`);
  }

  /**
   * Waits until Claude has actually been asked something matching `needle`.
   *
   * expect() watches the display, which is written before the turn is sent, so
   * asserting on asked() straight after it is a race the fast paths lose.
   */
  async asked_(needle, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.asked().some((t) => t.includes(needle))) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Claude was never asked ${JSON.stringify(needle)}\n--- asked ---\n${JSON.stringify(this.asked(), null, 2)}`);
  }

  /** Everything it said out loud, in order. */
  spoken() {
    return fs.readFileSync(this.spokenLog, 'utf8').split('\n').filter(Boolean);
  }

  /** Everything that was actually sent to Claude, in order. */
  asked() {
    return fs.readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /** The mode it is actually in: the last one it announced. */
  mode() {
    const seen = [...this.out.matchAll(/(asleep|awake|chat|taking notes)/g)].map((m) => m[1]);
    return seen[seen.length - 1] ?? '(none)';
  }

  /**
   * Waits until it is actually in a mode. Not expect(): the word "asleep" is
   * already on screen from the opening banner, so searching the output for it
   * matches instantly and asserts before the transition has happened.
   */
  async waitForMode(name, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.mode() === name) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for mode ${name}, still ${this.mode()}\n--- output ---\n${this.out}`);
  }

  /** Lets any in-flight routing settle before asserting a negative. */
  async settle(ms = 700) { await new Promise((r) => setTimeout(r, ms)); }

  /**
   * Waits for the Nth occurrence of some text.
   *
   * expect() searches output that has been accumulating since launch, so
   * waiting for a line that has already appeared once returns instantly — which
   * silently turns "do this three times" into "do it all at once".
   */
  async expectCount(needle, n, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.out.split(needle).length - 1 >= n) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)} x${n}\n--- output ---\n${this.out}`);
  }

  /** The exit code, for the cases where quitting is the correct behaviour. */
  async exited(timeout = 8000) {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`it never exited\n--- output ---\n${this.out}`)), timeout);
      this.child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
  }

  stop() { this.child.kill('SIGKILL'); }
}

test('starts up and reports the recognizer it is using', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    await app.expect('transcriber');
  } finally { app.stop(); }
});

test('typing a question wakes it and reaches Claude', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('why is my build slow');
    await app.expect('This is the stub answer.');
    assert.deepEqual(app.asked(), ['why is my build slow']);
  } finally { app.stop(); }
});

test('typing stop while asleep goes to sleep instead of asking Claude', async () => {
  // The regression this test exists for: the bare-command check was skipped
  // whenever it was already asleep, so typing "stop" fell through to the
  // question path and asked Claude about the word "stop".
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('stop');
    await app.settle();
    assert.deepEqual(app.asked(), [], 'the word "stop" must never reach Claude');
  } finally { app.stop(); }
});

test('typing sleep while asleep does not ask Claude either', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('go to sleep');
    await app.settle();
    assert.deepEqual(app.asked(), []);
  } finally { app.stop(); }
});

test('typing stop after a question puts it back to sleep', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('what did we decide');
    await app.expect('This is the stub answer.');
    app.type('stop');
    await app.expect('asleep');
    assert.deepEqual(app.asked(), ['what did we decide'], 'only the question is a turn');
  } finally { app.stop(); }
});

test('the wake word alone wakes it without asking anything', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon');
    await app.expect('awake');
    await app.settle();
    assert.deepEqual(app.asked(), []);
  } finally { app.stop(); }
});

test('the name is stripped from a question that carries it', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon, why is my build slow');
    await app.expect('This is the stub answer.');
    assert.deepEqual(app.asked(), ['why is my build slow']);
  } finally { app.stop(); }
});

test('a discussion is summarized into a titled note under a date folder', async () => {
  // The whole note path end to end: enter note mode, capture a few lines, stop,
  // and check what lands on disk — a titled file in a dated folder, carrying the
  // summary and none of the raw speech.
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon listen');
    await app.expect('taking notes');

    app.type('the catch block marks it processed even when it threw');
    app.type('we should look at issue 421 before changing it');
    app.type('hey falcon stop');

    await app.expect('notes saved to');

    const today = new Date();
    const day = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    const folder = path.join(app.dir, 'notes', day);
    assert.ok(fs.existsSync(folder), `expected a folder named ${day}`);

    const files = fs.readdirSync(folder);
    assert.deepEqual(files, ['redis-lock-for-pending-records.md'], 'named after the title');

    const body = fs.readFileSync(path.join(folder, files[0]), 'utf8');
    assert.match(body, /^# redis lock for pending records/);
    assert.ok(body.includes('The job claims each row in Redis before sending.'));
    assert.ok(body.includes('## References'));
    // Markers are plumbing, and the raw speech is not wanted in the file.
    assert.ok(!body.includes('TITLE:'), 'the title marker is stripped');
    assert.ok(!body.includes('SPOKEN:'), 'the spoken marker is stripped');
    assert.ok(!body.includes('the catch block marks it processed'), 'no transcript');
  } finally { app.stop(); }
});

test('the summary request tells Claude to look the ticket up', async () => {
  // Nothing here resolves a real issue — the stub stands in for the model. What
  // is worth asserting is that the instruction and the mention both arrive.
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon listen');
    await app.expect('taking notes');
    app.type('we should look at issue 421 before changing it');
    app.type('hey falcon stop');
    await app.expect('notes saved to');

    const prompt = app.asked().find((t) => t.includes('Transcript:'));
    assert.ok(prompt, 'a summary request was sent');
    assert.match(prompt, /gh issue view/, 'it is told how to look a number up');
    assert.match(prompt, /## References/, 'it is told where to put what it finds');
    assert.ok(prompt.includes('issue 421'), 'the mention reaches the model');
  } finally { app.stop(); }
});

test('note mode never sends the discussion itself to Claude', async () => {
  // Note mode exists to be a fly on the wall. A captured line becoming a
  // question would both answer out loud and leak the room into a turn.
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon listen');
    await app.expect('taking notes');
    app.type('what do you think about the redis approach');
    await app.settle();
    assert.deepEqual(app.asked(), [], 'nothing is asked while capturing');
  } finally { app.stop(); }
});

// ---------------------------------------------------------------- to-dos

/** The list as the app persisted it, read back from the working directory. */
function todosOnDisk(app) {
  const file = path.join(app.dir, 'todos.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')).items;
}

test('a spoken to-do is added without costing a turn', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon, add a todo to ship the redis fix');
    await app.settle();

    const items = todosOnDisk(app);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'ship the redis fix');
    assert.deepEqual(app.asked(), [], 'a list instruction is not a question');
  } finally { app.stop(); }
});

test('to-dos are completed and removed by the number that was read out', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon, add a todo to ship the redis fix');
    app.type('add a todo to write the migration');
    app.type('add a todo to update the docs');
    await app.settle();
    assert.equal(todosOnDisk(app).filter((t) => !t.done).length, 3);

    app.type('todo two is done');
    await app.settle();
    const afterDone = todosOnDisk(app);
    assert.equal(afterDone.find((t) => t.text === 'write the migration').done, true);

    // "todo two" now means what was third, because ordinals count open items.
    app.type('delete todo two');
    await app.settle();
    const afterDelete = todosOnDisk(app);
    assert.ok(!afterDelete.some((t) => t.text === 'update the docs'), 'the second open item went');
    assert.ok(afterDelete.some((t) => t.text === 'ship the redis fix'), 'the first is untouched');

    assert.deepEqual(app.asked(), [], 'none of that reached Claude');
  } finally { app.stop(); }
});

test('an ordinary question is still a question', async () => {
  // The parser sits in front of every utterance, so the thing most worth
  // proving is that it stays out of the way.
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon, can you delete the feature branch');
    await app.expect('This is the stub answer.');
    assert.deepEqual(app.asked(), ['can you delete the feature branch']);
    assert.equal(todosOnDisk(app).length, 0);
  } finally { app.stop(); }
});

test('the list survives a restart', async () => {
  const first = new App();
  const dir = first.dir;
  try {
    await first.expect('Falcon');
    first.type('add a todo to ship the redis fix');
    await first.settle();
  } finally { first.stop(); }

  // A second app in the same working directory must read the same list back and
  // keep numbering from where the first left off.
  const second = new App({ dir });
  try {
    await second.expect('Falcon');
    second.type('add a todo to write the migration');
    await second.settle();
    const items = todosOnDisk(second);
    assert.deepEqual(items.map((t) => t.text), ['ship the redis fix', 'write the migration']);
    assert.deepEqual(items.map((t) => t.id), [1, 2], 'ids continue rather than restarting');
  } finally { second.stop(); }
});

test('action items from a discussion land on the list', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon listen');
    await app.expect('taking notes');
    app.type('the catch block marks it processed even when it threw');
    app.type('hey falcon stop');
    await app.expect('notes saved to');
    await app.settle();

    const items = todosOnDisk(app);
    assert.equal(items.length, 2, 'both ACTION lines became to-dos');
    assert.deepEqual(items.map((t) => t.text), [
      'add a TTL to the redis lock keys',
      'rework the catch block so a failure is marked failed',
    ]);
    assert.ok(items.every((t) => t.source === 'notes'));

    // The markers are plumbing and must not reach the notes file.
    const notesFile = fs.readdirSync(path.join(app.dir, 'notes'))
      .flatMap((d) => fs.readdirSync(path.join(app.dir, 'notes', d))
        .map((f) => path.join(app.dir, 'notes', d, f)))[0];
    const body = fs.readFileSync(notesFile, 'utf8');
    assert.ok(!body.includes('ACTION:'), 'the action marker is stripped');
  } finally { app.stop(); }
});

// ------------------------------------------------------- every road to asleep

// Sleep is the command people reach for most, and it has more entry points than
// anything else: four phrasings, with and without the name, from four modes.
// They are covered together because a fix to one used to leave the others
// broken — note mode in particular ended awake for a long time.
const SLEEP_ROUTES = [
  { mode: 'awake', setup: ['hey falcon'], say: 'stop' },
  { mode: 'awake', setup: ['hey falcon'], say: 'sleep' },
  { mode: 'awake', setup: ['hey falcon'], say: 'go to sleep' },
  { mode: 'awake', setup: ['hey falcon'], say: 'hey falcon stop' },
  { mode: 'chat', setup: ["falcon let's discuss"], say: 'stop' },
  { mode: 'chat', setup: ["falcon let's discuss"], say: 'sleep' },
  { mode: 'chat', setup: ["falcon let's discuss"], say: 'go to sleep' },
  { mode: 'chat', setup: ["falcon let's discuss"], say: 'hey falcon stop' },
];

for (const route of SLEEP_ROUTES) {
  test(`"${route.say}" puts it to sleep from ${route.mode}`, async () => {
    const app = new App();
    try {
      await app.expect('Falcon');
      for (const line of route.setup) app.type(line);
      await app.waitForMode(route.mode);
      app.type(route.say);
      await app.waitForMode('asleep');
    } finally { app.stop(); }
  });
}

test('ending note mode goes to sleep rather than staying awake', async () => {
  // It used to land awake, which left it answering a room that had just been
  // talking to each other — the one thing note mode exists to avoid.
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon listen');
    await app.waitForMode('taking notes');
    app.type('the catch block marks it processed even when it threw');
    app.type('hey falcon stop');
    await app.expect('notes saved to');
    await app.waitForMode('asleep');
  } finally { app.stop(); }
});

test('ending note mode with nothing captured also sleeps', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon listen');
    await app.waitForMode('taking notes');
    app.type('hey falcon stop');
    await app.waitForMode('asleep');
  } finally { app.stop(); }
});

test('speech heard while asleep leaves no trace in the transcript', async () => {
  // Room noise reaches the recognizer constantly. Recording it filled the
  // window with garbled fragments that read as if it were still working.
  // holdMic true so the mic stays open and the Siri setup check stays out of
  // the way — what is under test is ignored speech, not startup advice.
  const app = new App({ args: ['--hold-mic', 'true'] });
  try {
    await app.expect('Falcon');
    await app.waitForMode('asleep');
    const before = app.out.length;

    // Arrives exactly as a recognized utterance does, without the wake word.
    app.speak('you reality I');
    app.speak('so anyway the deploy failed again');
    await app.settle();

    assert.ok(!app.out.includes('you reality I'), 'not printed');
    assert.ok(!app.out.includes('deploy failed again'), 'not printed');
    assert.deepEqual(app.asked(), [], 'and certainly not answered');
    assert.equal(app.mode(), 'asleep', 'and it stays asleep');
    assert.ok(app.out.length - before < 40, 'nothing meaningful was written');
  } finally { app.stop(); }
});

test('showIgnored brings the old behaviour back for debugging', async () => {
  const app = new App({ args: ['--show-ignored'] });
  try {
    await app.expect('Falcon');
    await app.waitForMode('asleep');
    app.speak('you reality I');
    await app.expect('you reality I');
    assert.deepEqual(app.asked(), [], 'shown, but still never answered');
  } finally { app.stop(); }
});

// -------------------------------------------------------- waking without a mic

test('with holdMic off it releases the microphone while asleep', async () => {
  const app = new App({ args: ['--hold-mic', 'false'] });
  try {
    await app.expect('microphone released while asleep');
    await app.waitForMode('asleep');
    assert.ok(app.out.includes('microphone released'), 'the daemon confirmed it');
  } finally { app.stop(); }
});

test('the wake file opens the microphone and wakes it', async () => {
  const wake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'falcon-wake-')), 'wake');
  const app = new App({ args: ['--hold-mic', 'false'], wakeFile: wake });
  try {
    await app.waitForMode('asleep');
    assert.equal(app.mode(), 'asleep');

    // Exactly what the Shortcut does.
    fs.writeFileSync(wake, `${Date.now()}`);

    await app.waitForMode('awake');
    assert.ok(app.out.includes('woken from outside'));
    assert.ok(app.out.includes('microphone open'), 'the mic was taken back');

    // Silently. This wake came from a button, and whoever pressed it already
    // knows they did — an acknowledgement lands on top of their first words,
    // because someone who presses a button to talk starts talking at once.
    await app.settle();
    assert.deepEqual(app.spoken(), [], 'a button wake must not speak over you');
  } finally { app.stop(); }
});

test('a wake file left over from last time does not wake it at startup', async () => {
  // The file persists between runs, so a stale one must not fire on boot.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'falcon-wake-'));
  const wake = path.join(dir, 'wake');
  fs.writeFileSync(wake, 'stale');

  const app = new App({ args: ['--hold-mic', 'false'], wakeFile: wake });
  try {
    await app.waitForMode('asleep');
    await app.settle();
    assert.equal(app.mode(), 'asleep', 'still asleep despite the old file');
  } finally { app.stop(); }
});

test('holdMic true keeps the microphone open', async () => {
  const app = new App({ args: ['--hold-mic', 'true'] });
  try {
    await app.expect('Falcon');
    await app.settle();
    assert.ok(!app.out.includes('microphone released'), 'nothing is released');
  } finally { app.stop(); }
});

test('releasing the mic is the default', async () => {
  const app = new App();
  try {
    await app.expect('microphone released');
    await app.waitForMode('asleep');
  } finally { app.stop(); }
});

test('it says so loudly when nothing can wake it', async () => {
  // Mic released and no Siri hook means the only way in is typing. An app that
  // silently ignores everything you say is the worst outcome here.
  const app = new App({ hook: path.join(os.tmpdir(), 'falcon-no-such-hook') });
  try {
    await app.expect('npm run siri');
    await app.expect('nothing you say can wake it');
  } finally { app.stop(); }
});

test('the asleep line says how it can actually be woken', async () => {
  // With the microphone released the wake phrase cannot reach it, and printing
  // it anyway is a lie the user only discovers by talking to nothing.
  const released = new App();
  try {
    await released.expect('asleep — say "hey siri, falcon" to wake');
  } finally { released.stop(); }

  const holding = new App({ args: ['--hold-mic', 'true'] });
  try {
    await holding.expect('asleep — say "hey falcon" to wake');
  } finally { holding.stop(); }
});

test('the server can be started without opening a window', async () => {
  // A scratch session path: an e2e run must never write over the session the
  // developer is actually using.
  const session = path.join(os.tmpdir(), `falcon-e2e-session-${process.pid}.json`);
  const app = new App({ args: ['--ui', '--spawn-window', 'false', '--session-file', session] });
  try {
    // The no-spawn path says "serving the window at"; the spawning path says
    // "window at". Only one of them can be on screen, which is the assertion.
    // The needle stops before the url because the view wraps long lines.
    await app.expect('serving the window at');
    assert.ok(app.out.includes('http://127.0.0.1:'), 'no url was published');
  } finally {
    app.stop();
    fs.rmSync(session, { force: true });
  }
});

test('the token never travels through argv', async () => {
  // argv is world-readable. A token in it can be lifted out of `ps` by any
  // process on the machine and used to POST commands to something that can
  // edit files and run shell commands.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
  const spawnCall = /spawn\(binary,\s*(\[[^\]]*\])/.exec(source);
  assert.ok(spawnCall, 'could not find where the window is spawned');
  assert.equal(spawnCall[1].replace(/\s/g, ''), '[]',
    'the window is being passed arguments; the session file is how it learns the url');
});

test('a whisper transcription replaces the system recognizer text', async () => {
  // The whole point of the change: Apple hears the accent badly, Whisper hears
  // it well, and Claude is asked what Whisper heard.
  const app = new App({ args: ['--stt', 'whisper', '--wake-word', 'false'], whisperMode: 'ok' });
  try {
    app.speak('what fights are in this project');
    await app.asked_('what files are in this project');
  } finally { app.stop(); }
});

test('a whisper failure falls back to the system recognizer', async () => {
  // A turn is never lost because the better recognizer was unavailable.
  const app = new App({ args: ['--stt', 'whisper', '--wake-word', 'false'], whisperMode: 'error' });
  try {
    app.speak('what fights are in this project');
    await app.asked_('what fights are in this project');
  } finally { app.stop(); }
});

// A five-hour rate limit ends the CLI process mid-turn. That used to end the
// whole app with it: the answer never arrived and the machine you were talking
// to disappeared, which on a screen that starts at login is the worst possible
// way to fail.
test('a claude session that dies mid-turn is replaced, not fatal', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');

    app.type('make it die');
    await app.expect('starting a new session');
    // The reason is on screen rather than discarded, which is what made this
    // undiagnosable in the first place.
    await app.expect('5-hour limit reached');

    // Still alive, still answering: the replacement session takes the next turn.
    app.type('why is my build slow');
    await app.expect('This is the stub answer.');
  } finally { app.stop(); }
});

test('a claude session that dies over and over does end the app', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('make it die');
    await app.expectCount('starting a new session', 1);
    app.type('make it die');
    await app.expectCount('starting a new session', 2);
    app.type('make it die');
    // Bad flags or missing auth fail identically every time; respawning forever
    // would just hide it.
    await app.expect('claude exited');
    const code = await app.exited();
    assert.equal(code, 1);
  } finally { app.stop(); }
});

// Both of these are transcribed from a session on 4 Sep 2026 that spent its
// whole life answering itself, with the account out of quota underneath.

test('it does not take its own answer for the next question', async () => {
  // Laptop speakers, built-in microphone, echo cancellation off — so everything
  // it said arrived back down its own microphone a couple of seconds later.
  const app = new App({ args: ['--echo-window-ms', '600000'] });
  try {
    await app.expect('Falcon');
    app.speak("hey falcon let's discuss");
    await app.waitForMode('chat');
    app.speak('how is the build');
    await app.asked_('how is the build');
    await app.expect('This is the stub answer.');

    // The microphone hears the answer coming out of the speakers.
    app.speak('This is the stub answer.');
    await app.expect('ignored its own voice');
    await app.settle();

    assert.deepEqual(
      app.asked().filter((t) => t.includes('stub answer')), [],
      'it asked itself its own answer back',
    );
  } finally { app.stop(); }
});

test('a usage limit is said out loud once, and the thinking beat stops', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hit the limit');
    await app.expect('spend limit');

    // Whoever asked is not looking at the screen, so a red line is not enough —
    // and a spoken line never reaches the terminal, only the synthesizer.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !app.spoken().some((l) => l.includes('usage limit'))) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await app.settle();

    assert.equal(
      app.spoken().filter((line) => line.includes('usage limit')).length, 1,
      `it should say it once, not once per failed turn: ${JSON.stringify(app.spoken())}`,
    );

    // A second failing turn says nothing more and makes no thinking noise —
    // which through laptop speakers is what fed the loop in the first place.
    const before = app.spoken().length;
    app.type('hit the limit again');
    await app.expectCount('spend limit', 2);
    await app.settle();
    assert.equal(app.spoken().length, before, 'it spoke while it knew it was blocked');
  } finally { app.stop(); }
});

// Astra's review, P1 #3. Reachable by talking normally: ask something, start
// taking notes while it is still answering, then stop. The summary was queued
// behind the answer, and the flag that says "the next turn to end is the
// summary" was already set — so the *answer* was written to disk as the note,
// and the summary prompt, transcript and all, was read out loud.
test('a summary asked for while an answer is in flight is still the summary', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon chat');
    await app.waitForMode('chat');

    app.type('take your time answering this one');
    await app.asked_('take your time');

    // The answer is still in flight from here to the end of the test.
    app.type('hey falcon listen');
    await app.expect('taking notes');
    app.type('the catch block marks it processed even when it threw');
    app.type('hey falcon stop');

    await app.expect('notes saved to', 12000);

    const notesFile = fs.readdirSync(path.join(app.dir, 'notes'))
      .flatMap((d) => fs.readdirSync(path.join(app.dir, 'notes', d))
        .map((f) => path.join(app.dir, 'notes', d, f)))[0];
    const body = fs.readFileSync(notesFile, 'utf8');

    assert.ok(!body.includes('This is the stub answer.'),
      `the answer to an unrelated question was saved as the note:\n${body}`);
    assert.match(body, /redis lock/i);

    // The summary prompt is plumbing. Spoken aloud it reads the entire
    // transcript back at the room it was just recorded from.
    assert.ok(!app.spoken().some((line) => line.includes('Transcript:')),
      `the summary prompt was spoken:\n${app.spoken().join('\n')}`);
  } finally {
    await app.stop();
  }
});

// Astra's review, P2 #12. Quitting kills the children; their exit handlers did
// not know a shutdown was under way, so teardown announced a lost connection
// and spawned a replacement session on its way out the door.
test('quitting does not spawn a replacement on the way out', async () => {
  const app = new App();
  try {
    await app.expect('Falcon');
    app.child.kill('SIGINT');
    await app.exited();

    assert.ok(!app.out.includes('starting a new session'),
      `a new session was started during shutdown:\n${app.out}`);
    assert.ok(!app.out.includes('I lost my connection'),
      `it complained about losing Claude while being told to quit:\n${app.out}`);
  } finally {
    await app.stop();
  }
});

test('calling refuses to start without its key, rather than half-working', async () => {
  // The same bargain the gateway struck. A path off this machine that starts
  // anyway and fails at the moment you need it is worse than one that refuses.
  const app = new App({ args: ['--phone', 'true'], env: { RETELL_API_KEY: '' } });
  try {
    await app.expect('needs RETELL_API_KEY');
    assert.equal(await app.exited(), 1);
  } finally { app.stop(); }
});

test('calling says out loud that it is armed', async () => {
  // A squeeze wakes it silently and a call sends a stranger's voice off the
  // box; the difference has to be audible at startup, not buried in a log.
  const app = new App({ args: ['--phone', 'true'], env: { RETELL_API_KEY: 'k_test' } });
  try {
    await app.expect('calling is armed');
    await app.expect('off this machine');
  } finally { app.stop(); }
});

test('the notes announcement is heard before the microphone is handed back', async () => {
  // Stopping note mode sleeps at once, and sleeping hands the microphone back at
  // once — but the summary arrives seconds later and is announced out loud.
  // Announced into a stopped engine it was never heard, and the engine never
  // said it had finished, so the window sat on "speaking" until the next turn.
  const app = new App();
  try {
    await app.expect('Falcon');
    app.type('hey falcon listen');
    await app.expect('taking notes');
    app.type('the catch block marks it processed even when it threw');
    app.type('hey falcon stop');
    await app.expect('notes saved to');

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !app.spoken().some((l) => /notes|saved|redis/i.test(l))) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const summary = app.spoken().filter((l) => /notes|saved|redis/i.test(l));
    assert.ok(summary.length, `the summary was never announced\n${app.spoken().join('\n')}`);
    assert.ok(
      !summary.some((l) => l.startsWith('(into standby)')),
      `the summary was spoken into a stopped engine:\n${summary.join('\n')}`,
    );
    // And the microphone is still handed back afterwards; sleep is not skipped.
    await app.expect('microphone released');
  } finally { app.stop(); }
});
