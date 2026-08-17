// Chooses how speech gets made, and keeps utterances in order.
//
// Apple synthesis queues inside the daemon, so there is nothing to manage.
// Piper synthesizes here and streams PCM down, which means this owns the queue:
// one utterance is played at a time, and a stale utterance's audio is dropped
// rather than played after an interruption.

import { EventEmitter } from 'node:events';
import { Piper, available as piperAvailable } from './piper.mjs';

export class Speaker extends EventEmitter {
  /**
   * @param {import('./voice.mjs').VoiceIO} voice
   * @param {object} options
   * @param {string} options.engine 'piper' or 'apple'
   * @param {string} options.piperVoice
   */
  constructor(voice, { engine = 'apple', piperVoice = '' } = {}) {
    super();
    this.voice = voice;
    this.engine = 'apple';
    this.queue = [];
    this.busy = false;
    this.nextId = 1;
    this.activeId = null;

    if (engine === 'piper') {
      if (!piperAvailable(piperVoice)) {
        this.emit('warn', `piper voice "${piperVoice}" not installed — run ./scripts/install-piper.sh`);
      } else {
        this.#startPiper(piperVoice);
      }
    }

    // Playback finished in the daemon: release the queue for the next line.
    voice.on('speech-end', () => {
      if (this.engine !== 'piper') return;
      this.busy = false;
      this.activeId = null;
      this.#drain();
    });
  }

  get name() {
    return this.engine === 'piper' ? 'piper' : 'apple';
  }

  #startPiper(voiceName) {
    this.piper = new Piper(voiceName);
    this.engine = 'piper';

    this.piper.on('audio', ({ id, data }) => {
      // Audio from an utterance that was interrupted must never reach the player.
      if (id !== this.activeId) return;
      this.voice.pcm(data);
    });

    this.piper.on('end', (id) => {
      if (id !== this.activeId) return;
      this.voice.pcmEnd();
    });

    this.piper.on('error', (err) => {
      this.emit('warn', `piper: ${err.message} — falling back to system voice`);
      this.#fallback();
    });

    this.piper.on('exit', () => {
      if (this.engine === 'piper') {
        this.emit('warn', 'piper exited — falling back to system voice');
        this.#fallback();
      }
    });
  }

  #fallback() {
    this.engine = 'apple';
    this.piper = null;
    this.busy = false;
    this.activeId = null;
  }

  say(text) {
    const clean = text?.trim();
    if (!clean) return;
    if (this.engine !== 'piper') {
      this.voice.speak(clean);
      return;
    }
    this.queue.push(clean);
    this.#drain();
  }

  #drain() {
    if (this.busy || this.queue.length === 0) return;
    const text = this.queue.shift();
    this.busy = true;
    this.activeId = this.nextId;
    this.nextId += 1;
    this.voice.pcmStart(text, this.piper.sampleRate);
    this.piper.synthesize(this.activeId, text);
  }

  stop() {
    this.queue = [];
    this.busy = false;
    // Bumping the id orphans any audio still streaming from the interrupted line.
    this.activeId = null;
    this.voice.stop();
  }

  close() {
    this.piper?.close();
  }
}
