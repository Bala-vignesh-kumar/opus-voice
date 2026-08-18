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
  constructor({ workdir = null } = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e2e-'));
    this.workdir = workdir ? this.dir : ROOT;
    this.log = path.join(this.dir, 'asked.log');
    fs.writeFileSync(this.log, '');
    this.out = '';
    this.child = spawn(process.execPath, [
      path.join(ROOT, 'src', 'index.mjs'),
      '--tts', 'apple',
      '--greeting', '',
      // Long enough that the idle timer never fires mid-test and turns a
      // routing assertion into a timing one.
      '--awake-timeout-ms', '600000',
      '--dir', this.workdir,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        OPUS_VOICE_IO_BIN: path.join(STUBS, 'voiceio.mjs'),
        OPUS_VOICE_CLAUDE_BIN: path.join(STUBS, 'claude.mjs'),
        STUB_CLAUDE_LOG: this.log,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d) => { this.out += strip(String(d)); });
    this.child.stderr.on('data', (d) => { this.out += strip(String(d)); });
  }

  type(text) { this.child.stdin.write(`${text}\n`); }

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
    app.type('falcon');
    await app.expect('awake');
    await app.settle();
    assert.deepEqual(app.asked(), []);
  } finally { app.stop(); }
});

test('the name is stripped from a question that carries it', async () => {
  const app = new App();
  try {
    await app.expect('opus voice');
    app.type('falcon, why is my build slow');
    await app.expect('This is the stub answer.');
    assert.deepEqual(app.asked(), ['why is my build slow']);
  } finally { app.stop(); }
});

test('a discussion is summarized into a titled note under a date folder', async () => {
  // The whole note path end to end: enter note mode, capture a few lines, stop,
  // and check what lands on disk — a titled file in a dated folder, carrying the
  // summary and none of the raw speech.
  const app = new App({ workdir: true });
  try {
    await app.expect('opus voice');
    app.type('falcon listen');
    await app.expect('taking notes');

    app.type('the catch block marks it processed even when it threw');
    app.type('we should look at issue 421 before changing it');
    app.type('falcon stop');

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
  const app = new App({ workdir: true });
  try {
    await app.expect('opus voice');
    app.type('falcon listen');
    await app.expect('taking notes');
    app.type('we should look at issue 421 before changing it');
    app.type('falcon stop');
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
  const app = new App({ workdir: true });
  try {
    await app.expect('opus voice');
    app.type('falcon listen');
    await app.expect('taking notes');
    app.type('what do you think about the redis approach');
    await app.settle();
    assert.deepEqual(app.asked(), [], 'nothing is asked while capturing');
  } finally { app.stop(); }
});
