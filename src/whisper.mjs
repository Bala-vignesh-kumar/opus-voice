// src/whisper.mjs
// Local Whisper, as a long-lived subprocess.
//
// Loading the model costs seconds, so it happens once at startup rather than
// per turn — the same reason scripts/piper_server.py stays resident.
//
// Every failure here resolves to an empty string rather than rejecting. The
// caller falls back to Apple's text, because losing a turn to a recognizer
// being unavailable is worse than a turn transcribed less well.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = path.join(ROOT, 'vendor/py/bin/python');
const SERVER = path.join(ROOT, 'scripts/whisper_server.py');

/** Whether local Whisper is installed at all. */
export function available() {
  return fs.existsSync(PYTHON) && fs.existsSync(SERVER);
}

export class Whisper extends EventEmitter {
  constructor({ model = 'base', timeoutMs = 3000, vocabulary = [], bin = PYTHON, server = SERVER, env = {} } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();     // id -> resolve
    this.nextId = 1;
    this.dead = false;

    // Passed at startup rather than per turn: the model loads once, and these
    // are properties of the project you are talking about, not of one sentence.
    this.child = spawn(bin, [server, model, ...vocabulary], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    this.child.on('error', (err) => this.#die(`whisper: ${err.message}`));
    this.child.on('exit', (code) => {
      // Expected on the way out; only worth reporting if it was not asked for.
      if (!this.closing) this.#die(`whisper exited (code ${code})`);
      this.emit('exit', code);
    });
    // Writing to a process that has already died is how we find out it died.
    // Node reports that as an error event on the pipe, and an unhandled one
    // would take down the app this exists to keep running.
    this.child.stdin.on('error', () => this.#die('whisper stopped accepting audio'));
    this.child.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) this.emit('stderr', text);
    });

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'ready') { this.emit('ready'); return; }
      const settle = this.pending.get(message.id);
      if (!settle) return;
      this.pending.delete(message.id);
      // An empty transcription is a failure, not an answer: it would send
      // Claude nothing where Apple had heard something.
      settle(message.type === 'text' ? String(message.text || '').trim() : '');
    });
  }

  /**
   * @param {string} pcm base64 float32 little-endian mono
   * @returns {Promise<string>} the transcription, or '' on any failure
   */
  transcribe(pcm, sampleRate) {
    if (this.dead || !pcm) return Promise.resolve('');
    const id = this.nextId++;
    return new Promise((resolve) => {
      // Resolved exactly once, whichever of answer, timeout or death lands first.
      let done = false;
      const settle = (text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(text);
      };
      const timer = setTimeout(() => {
        // The turn is already waiting on this. Better a less accurate turn now
        // than a perfect one after the moment has passed.
        this.emit('warn', 'whisper timed out — using the system recognizer for that turn');
        settle('');
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, settle);
      try {
        this.child.stdin.write(`${JSON.stringify({ id, pcm, sampleRate })}\n`);
      } catch {
        settle('');
      }
    });
  }

  #die(message) {
    if (this.dead) return;
    this.dead = true;
    this.emit('warn', `${message} — using the system recognizer from here`);
    for (const settle of this.pending.values()) settle('');
    this.pending.clear();
  }

  close() {
    this.closing = true;
    try { this.child.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`); } catch { /* already gone */ }
    this.child.stdin.end();
    this.child.kill();
  }
}
