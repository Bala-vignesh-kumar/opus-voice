// Being woken from outside the app.
//
// With `holdMic: false` the microphone is released while asleep, which means
// nothing this app can hear will wake it — that is the whole point. Something
// else has to do the waking, and on a Mac the only thing allowed to listen
// continuously without holding the microphone is Siri.
//
// So the trigger is a file. A Shortcut named whatever you like touches it, Siri
// runs the Shortcut when you say its name, and this notices. A file rather than
// a port because a Shortcut's shell action is one line either way, and there is
// no token to keep in sync or port to collide.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const DIR = path.join(os.homedir(), '.opus-voice');
export const FILE = process.env.OPUS_VOICE_WAKE_FILE || path.join(DIR, 'wake');

/**
 * Watches the wake file and emits 'wake' when it is touched.
 *
 * fs.watch is unreliable across editors and atomic writes, so the mtime is
 * polled as well. A missed wake is the one failure mode that matters here: it
 * makes the app look broken with nothing to see.
 */
export class Trigger extends EventEmitter {
  constructor({ file = FILE, interval = 250 } = {}) {
    super();
    this.file = file;
    this.last = 0;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });

    // Anything already there predates this run and must not fire immediately.
    try {
      this.last = fs.statSync(this.file).mtimeMs;
    } catch {
      this.last = 0;
    }

    this.timer = setInterval(() => this.#check(), interval);
    this.timer.unref?.();
    try {
      this.watcher = fs.watch(path.dirname(this.file), () => this.#check());
      this.watcher.unref?.();
    } catch {
      // Polling alone is enough; a missing watch is not worth failing over.
    }
  }

  #check() {
    let mtime;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      return;
    }
    if (mtime <= this.last) return;
    this.last = mtime;
    this.emit('wake');
  }

  close() {
    clearInterval(this.timer);
    this.watcher?.close();
  }
}
