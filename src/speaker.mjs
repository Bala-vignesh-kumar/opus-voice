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
   * @param {(message: string) => void} [options.onWarn] Registered before
   *   anything else, because a missing Piper voice is reported from inside this
   *   constructor — a listener attached afterwards never hears it, and the user
   *   gets the robotic fallback voice with no explanation for it.
   */
  constructor(voice, { engine = 'apple', piperVoice = '', onWarn = null } = {}) {
    super();
    if (onWarn) this.on('warn', onWarn);
    this.voice = voice;
    this.engine = 'apple';
    this.queue = [];
    this.busy = false;
    this.nextId = 1;
    this.activeId = null;
    // Lines handed over that have not finished playing, oldest first,
    // whichever engine. Apple queues inside the daemon where nothing here can
    // see it, so this is the only record that a queued announcement is still
    // to come — and the only way to say them again if the player wedges.
    this.unfinished = [];

    if (engine === 'piper') {
      if (!piperAvailable(piperVoice)) {
        this.emit('warn', `piper voice "${piperVoice}" not installed — run ./scripts/install-piper.sh`);
      } else {
        this.#startPiper(piperVoice);
      }
    }

    // Playback finished in the daemon: release the queue for the next line.
    voice.on('speech-end', () => {
      this.unfinished.shift();
      if (this.engine !== 'piper') return;
      this.busy = false;
      this.activeId = null;
      this.#drain();
    });
  }

  get name() {
    return this.engine === 'piper' ? 'piper' : 'apple';
  }

  /** Nothing playing and nothing waiting to. */
  get idle() {
    return this.unfinished.length === 0 && this.queue.length === 0 && !this.busy;
  }

  #startPiper(voiceName) {
    this.piper = new Piper(voiceName);
    this.engine = 'piper';

    this.piper.on('audio', ({ id, data }) => {
      // Audio from an utterance that was interrupted must never reach the player.
      if (id !== this.activeId) return;
      // The first chunk is when playback can genuinely be expected. pcm_start
      // goes out before Piper has synthesized anything, and on a cold start
      // that gap is long enough to look like a dead player to anyone timing
      // from there.
      if (!this.delivered) {
        this.delivered = true;
        this.emit('playing');
      }
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
      // On the way out piper is *supposed* to exit; warning about it there just
      // puts a scary line under an ordinary ctrl-c.
      if (this.closing) return;
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
    // Every sentence the app says out loud passes through here, which is what
    // makes this the one place worth announcing it from — there are seventeen
    // callers and a list kept at each of them would be wrong within a week.
    // src/echo-guard.mjs is what listens, and says why anything needs to know.
    this.emit('said', clean);
    this.unfinished.push(clean);
    if (this.engine !== 'piper') {
      // The daemon synthesizes this itself, so it is playing as soon as it is sent.
      this.voice.speak(clean);
      this.emit('playing');
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
    this.delivered = false;
    this.voice.pcmStart(text, this.piper.sampleRate);
    this.piper.synthesize(this.activeId, text);
  }

  stop() {
    this.queue = [];
    this.busy = false;
    this.unfinished = [];
    // Bumping the id orphans any audio still streaming from the interrupted line.
    this.activeId = null;
    this.voice.stop();
  }

  close() {
    this.closing = true;
    this.piper?.close();
  }
}
