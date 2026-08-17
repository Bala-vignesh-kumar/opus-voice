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
  constructor(voiceName) {
    super();
    this.sampleRate = 22050;

    const paths = findVoice(voiceName);
    if (!paths) throw new Error(`piper voice not installed: ${voiceName}`);

    this.child = spawn(PYTHON, [SERVER, paths.model, paths.config], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', (err) => this.emit('error', err));
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

  /** Starts synthesizing; audio streams back tagged with `id`. */
  synthesize(id, text) {
    this.child.stdin.write(`${JSON.stringify({ id, text })}\n`);
  }

  close() {
    this.child.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
    this.child.stdin.end();
    this.child.kill();
  }
}
