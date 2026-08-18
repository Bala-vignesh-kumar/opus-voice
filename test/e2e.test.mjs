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
  constructor({ dir = null, args = [], wakeFile = null, hook = null } = {}) {
    this.args = args;
    this.wakeFile = wakeFile;
    // Point at the real hook by default so tests reflect a set-up machine.
    this.hook = hook ?? path.join(ROOT, 'package.json');
    this.dir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e2e-'));
    this.log = path.join(this.dir, 'asked.log');
    this.inject = path.join(this.dir, 'speech.txt');
    fs.writeFileSync(this.log, '');
    this.out = '';
    this.child = spawn(process.execPath, [
      path.join(ROOT, 'src', 'index.mjs'),
      '--tts', 'apple',
      '--greeting', '',
      // Long enough that the idle timer never fires mid-test and turns a
      // routing assertion into a timing one.
      '--awake-timeout-ms', '600000',
      '--dir', this.dir,
      ...this.args,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        OPUS_VOICE_IO_BIN: path.join(STUBS, 'voiceio.mjs'),
        OPUS_VOICE_CLAUDE_BIN: path.join(STUBS, 'claude.mjs'),
        STUB_CLAUDE_LOG: this.log,
        STUB_VOICE_INJECT: this.inject,
        ...(this.wakeFile ? { OPUS_VOICE_WAKE_FILE: this.wakeFile } : {}),
        OPUS_VOICE_WAKE_HOOK: this.hook,
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

  stop() { this.child.kill('SIGKILL'); }
}

test('starts up and reports the recognizer it is using', async () => {
  const app = new App();
  try {
    await app.expect('opus voice');
    await app.expect('transcriber');
  } finally { app.stop(); }
});

test('typing a question wakes it and reaches Claude', async () => {
  const app = new App();
  try {
    await app.expect('opus voice');
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
    await app.expect('opus voice');
    app.type('stop');
    await app.settle();
    assert.deepEqual(app.asked(), [], 'the word "stop" must never reach Claude');
  } finally { app.stop(); }
});

test('typing sleep while asleep does not ask Claude either', async () => {
  const app = new App();
  try {
    await app.expect('opus voice');
    app.type('go to sleep');
    await app.settle();
    assert.deepEqual(app.asked(), []);
  } finally { app.stop(); }
});

test('typing stop after a question puts it back to sleep', async () => {
  const app = new App();
  try {
    await app.expect('opus voice');
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
    await app.expect('opus voice');
    app.type('hey falcon');
    await app.expect('awake');
    await app.settle();
    assert.deepEqual(app.asked(), []);
  } finally { app.stop(); }
});

test('the name is stripped from a question that carries it', async () => {
  const app = new App();
  try {
    await app.expect('opus voice');
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
    await app.expect('opus voice');
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
    await app.expect('opus voice');
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
    await app.expect('opus voice');
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
    await app.expect('opus voice');
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
    await app.expect('opus voice');
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
    await app.expect('opus voice');
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
    await first.expect('opus voice');
    first.type('add a todo to ship the redis fix');
    await first.settle();
  } finally { first.stop(); }

  // A second app in the same working directory must read the same list back and
  // keep numbering from where the first left off.
  const second = new App({ dir });
  try {
    await second.expect('opus voice');
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
    await app.expect('opus voice');
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
      await app.expect('opus voice');
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
    await app.expect('opus voice');
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
    await app.expect('opus voice');
    app.type('hey falcon listen');
    await app.waitForMode('taking notes');
    app.type('hey falcon stop');
    await app.waitForMode('asleep');
  } finally { app.stop(); }
});

test('speech heard while asleep leaves no trace in the transcript', async () => {
  // Room noise reaches the recognizer constantly. Recording it filled the
  // window with garbled fragments that read as if it were still working.
  const app = new App();
  try {
    await app.expect('opus voice');
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
    await app.expect('opus voice');
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
  const wake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opus-wake-')), 'wake');
  const app = new App({ args: ['--hold-mic', 'false'], wakeFile: wake });
  try {
    await app.waitForMode('asleep');
    assert.equal(app.mode(), 'asleep');

    // Exactly what the Shortcut does.
    fs.writeFileSync(wake, `${Date.now()}`);

    await app.waitForMode('awake');
    assert.ok(app.out.includes('woken by Siri'));
    assert.ok(app.out.includes('microphone open'), 'the mic was taken back');
  } finally { app.stop(); }
});

test('a wake file left over from last time does not wake it at startup', async () => {
  // The file persists between runs, so a stale one must not fire on boot.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-wake-'));
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
    await app.expect('opus voice');
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
  const app = new App({ hook: path.join(os.tmpdir(), 'opus-no-such-hook') });
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
