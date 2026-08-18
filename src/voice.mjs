// Node-side wrapper around the Swift voiceio daemon.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Overridable so an end-to-end test can drive the app with a stub daemon
// instead of real hardware; nothing else should set it.
const BINARY = process.env.OPUS_VOICE_IO_BIN || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bin/voiceio',
);

/**
 * Emits: 'ready', 'partial', 'final', 'bargein', 'speech-start', 'speech-end',
 * 'warn', 'error', 'exit'.
 */
export class VoiceIO extends EventEmitter {
  constructor({ locale = 'en-US' } = {}) {
    super();
    this.speaking = false;

    this.child = spawn(BINARY, ['--locale', locale], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => this.emit('exit', code));

    readline.createInterface({ input: this.child.stdout })
      .on('line', (line) => this.#onLine(line));
  }

  #send(command) {
    if (this.child.exitCode === null) this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  configure(options) { this.#send({ cmd: 'configure', ...options }); }
  speak(text) { this.#send({ cmd: 'speak', text }); }

  // Externally synthesized audio, played through the same engine so echo
  // cancellation still has its reference signal.
  pcmStart(text, sampleRate) { this.#send({ cmd: 'pcm_start', text, sampleRate }); }
  pcm(data) { this.#send({ cmd: 'pcm', data }); }
  pcmEnd() { this.#send({ cmd: 'pcm_end' }); }
  stop() { this.#send({ cmd: 'stop' }); }
  listen(on) { this.#send({ cmd: 'listen', on }); }
  close() { this.#send({ cmd: 'quit' }); }

  #onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    switch (event.type) {
      case 'ready': this.emit('ready', event); break;
      case 'partial': this.emit('partial', event.text); break;
      case 'final': this.emit('final', event.text); break;
      case 'bargein': this.emit('bargein'); break;
      case 'speech_start': this.speaking = true; this.emit('speech-start', event.text); break;
      case 'speech_end': this.speaking = false; this.emit('speech-end', event.interrupted); break;
      case 'voice': this.emit('voice', event); break;
      case 'level': this.emit('level', event.rms); break;
      case 'recog-error':
      case 'recog_error': this.emit('recog-error', event); break;
      case 'warn': this.emit('warn', event.message); break;
      case 'error':
        this.emit('error', Object.assign(new Error(event.message), { fatal: event.fatal }));
        break;
      default: break;
    }
  }
}
