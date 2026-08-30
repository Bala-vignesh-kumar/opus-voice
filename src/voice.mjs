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
  constructor({ locale = 'en-US', echoCancellation = false, micDevice = 'builtin' } = {}) {
    super();
    this.speaking = false;
    this.options = { locale, echoCancellation, micDevice };
    this.#spawn();
  }

  #spawn() {
    const { locale, echoCancellation, micDevice } = this.options;

    this.child = spawn(BINARY, [
      '--locale', locale,
      ...(echoCancellation ? ['--echo-cancellation'] : []),
      // On the command line, not in `configure`: the input device is picked
      // during setup, before any configure command can arrive.
      '--mic-device', micDevice,
    ], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => this.emit('exit', code));
    // Without a listener here, a broken pipe is thrown at the process instead
    // of at us, and the app dies rather than reporting that audio stopped. The
    // exitCode check below cannot cover it: the child can go between the check
    // and the write.
    this.child.stdin.on('error', (err) => this.emit('error', err));

    readline.createInterface({ input: this.child.stdout })
      .on('line', (line) => this.#onLine(line));
  }

  /**
   * Replaces a daemon that has exited.
   *
   * Headphones connecting or disconnecting takes the audio device with them and
   * the daemon dies on it. That used to end the app. It comes back and re-emits
   * `ready`, which is what reconfigures it, so nothing else has to know.
   */
  restart() {
    this.child?.removeAllListeners();
    this.child?.stdin.removeAllListeners();
    try {
      this.child?.kill();
    } catch {
      // Already dead is the case this exists for.
    }
    this.speaking = false;
    this.#spawn();
  }

  #send(command) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch {
      // Raced the child's exit; 'exit' has already been emitted for it.
    }
  }

  configure(options) { this.#send({ cmd: 'configure', ...options }); }

  /** Hands the microphone back to the system, or takes it again. */
  standby(on) { this.#send({ cmd: 'standby', on }); }
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
      // The audio behind the turn, for the second-opinion recognizer. Arrives
      // just before its `final`, so the orchestrator always has it in hand.
      case 'utterance': this.emit('utterance', event); break;
      case 'bargein': this.emit('bargein'); break;
      case 'speech_start': this.speaking = true; this.emit('speech-start', event.text); break;
      case 'speech_end': this.speaking = false; this.emit('speech-end', event.interrupted); break;
      case 'voice': this.emit('voice', event); break;
      // Both directions come down this one event, tagged: the microphone while
      // you talk, the mixer while it does. The whole event goes out because the
      // tag is the half that says which one moved.
      case 'level': this.emit('level', { source: event.source ?? 'in', rms: event.rms ?? 0 }); break;
      case 'recog-error':
      case 'recog_error': this.emit('recog-error', event); break;
      case 'standby': this.emit('standby', event.on); break;
      case 'warn': this.emit('warn', event.message); break;
      case 'error':
        this.emit('error', Object.assign(new Error(event.message), { fatal: event.fatal }));
        break;
      default: break;
    }
  }
}
