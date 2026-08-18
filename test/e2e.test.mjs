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
  constructor() {
    this.log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e2e-')), 'asked.log');
    fs.writeFileSync(this.log, '');
    this.out = '';
    this.child = spawn(process.execPath, [
      path.join(ROOT, 'src', 'index.mjs'),
      '--tts', 'apple',
      '--greeting', '',
      // Long enough that the idle timer never fires mid-test and turns a
      // routing assertion into a timing one.
      '--awake-timeout-ms', '600000',
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
    return fs.readFileSync(this.log, 'utf8').split('\n').filter(Boolean);
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
