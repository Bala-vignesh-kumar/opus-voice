// Piper: local neural text-to-speech, streamed.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = path.join(ROOT, 'vendor/py/bin/python');
const SERVER = path.join(ROOT, 'scripts/piper_server.py');
const VOICES = path.join(ROOT, 'vendor/voices');

/** Paths for a voice name, or null if it isn't installed. */
export function findVoice(name) {
  const model = path.join(VOICES, `${name}.onnx`);
  const config = `${model}.json`;
  if (!fs.existsSync(model) || !fs.existsSync(config)) return null;
  return { model, config };
}

/** True when Piper is installed and the named voice is present. */
export function available(name) {
  return fs.existsSync(PYTHON) && fs.existsSync(SERVER) && findVoice(name) !== null;
}

/**
 * Emits: 'ready' (sampleRate), 'audio' ({id, data} base64 PCM), 'end' (id),
 * 'error', 'exit'.
 */
export class Piper extends EventEmitter {
  // Overridable so a test can drive a stub server, the same way Whisper does.
  constructor(voiceName, { python = PYTHON, server = SERVER, voice = null, env = {} } = {}) {
    super();
    this.sampleRate = 22050;

    const paths = voice ?? findVoice(voiceName);
    if (!paths) throw new Error(`piper voice not installed: ${voiceName}`);

    this.child = spawn(python, [server, paths.model, paths.config], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.child.on('error', (err) => this.emit('error', err));
    // The pipe breaks the instant the child goes, and a socket with no error
    // listener throws its error at the process rather than at us. That is how a
    // dead voice took the whole app down from inside shutdown().
    this.child.stdin.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => this.emit('exit', code));
    this.child.stderr.on('data', (data) => {
      const text = String(data).trim();
      if (text) this.emit('stderr', text);
    });

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      switch (message.type) {
        case 'ready':
          this.sampleRate = message.sampleRate;
          this.emit('ready', message.sampleRate);
          break;
        case 'audio': this.emit('audio', message); break;
        case 'end': this.emit('end', message.id); break;
        case 'error': this.emit('error', new Error(message.message)); break;
        default: break;
      }
    });
  }

  /**
   * Writes a line, unless the voice has already gone.
   *
   * Silent when it has: there is nothing useful to say about a synthesizer that
   * exited, and the callers are a speech request and a shutdown, neither of
   * which can do anything about it.
   */
  #send(message) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Raced the child's exit. Same outcome as finding it already gone.
    }
  }

  /** Starts synthesizing; audio streams back tagged with `id`. */
  synthesize(id, text) {
    this.#send({ id, text });
  }

  close() {
    this.#send({ cmd: 'quit' });
    this.child.stdin.end();
    this.child.kill();
  }
}
