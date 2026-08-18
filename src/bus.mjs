// The conversation as data, so more than one surface can render it.
//
// The terminal UI writes lines as they happen and forgets them. A window has to
// be able to show the whole conversation to a client that connected halfway
// through, so the state lives here and both surfaces read from it. Nothing in
// this file knows about sockets, ANSI codes or the DOM.

import { EventEmitter } from 'node:events';

// Enough history to scroll back through a long session without letting a
// machine that has been running for days grow without limit.
const MAX_ENTRIES = 400;

/**
 * Holds the conversation and the current status, and announces every change.
 *
 * Emits 'change' with a small serializable patch: `{ type, ... }`. A client that
 * connects late calls `snapshot()` once and then follows the patches.
 */
export class Conversation extends EventEmitter {
  constructor({ max = MAX_ENTRIES } = {}) {
    super();
    this.max = max;
    this.entries = [];
    this.nextId = 1;
    this.mode = 'asleep';
    this.status = null;      // 'thinking', 'speaking', a tool name, or null
    this.partial = '';       // what it is hearing right now, not yet final
    this.speaking = false;
    this.info = {};          // banner details: model, voice, workdir
    this.todos = [];         // the list, mirrored for the window
  }

  /** Everything a freshly connected client needs to draw the whole window. */
  snapshot() {
    return {
      type: 'snapshot',
      entries: this.entries,
      mode: this.mode,
      status: this.status,
      partial: this.partial,
      speaking: this.speaking,
      info: this.info,
      todos: this.todos,
    };
  }

  #push(entry) {
    const full = { id: this.nextId++, at: Date.now(), ...entry };
    this.entries.push(full);
    // Trim from the front; ids keep increasing so a client can tell what is new.
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.emit('change', { type: 'entry', entry: full });
    return full;
  }

  banner(info) {
    this.info = info;
    this.emit('change', { type: 'info', info });
  }

  /** Interim recognition — replaced constantly, never part of the transcript. */
  hearing(text) {
    if (this.partial === text) return;
    this.partial = text;
    this.emit('change', { type: 'partial', text });
  }

  clearHearing() {
    if (!this.partial) return;
    this.partial = '';
    this.emit('change', { type: 'partial', text: '' });
  }

  /** A finished question from the user. */
  you(text) {
    this.clearHearing();
    return this.#push({ role: 'you', text });
  }

  /**
   * A sentence on its way to the synthesizer. Consecutive sentences of one
   * answer join the same entry, so the window shows a paragraph growing rather
   * than a stack of one-line bubbles.
   */
  opus(text, first) {
    const last = this.entries[this.entries.length - 1];
    if (!first && last?.role === 'opus') {
      last.text = `${last.text} ${text}`.trim();
      this.emit('change', { type: 'append', id: last.id, text });
      return last;
    }
    return this.#push({ role: 'opus', text });
  }

  /** Speech captured in note mode, which is never answered. */
  heard(text) { return this.#push({ role: 'heard', text }); }

  /** Speech ignored because it is asleep — shown so it doesn't look broken. */
  ignored(text) { return this.#push({ role: 'ignored', text }); }

  system(text) { return this.#push({ role: 'system', text }); }
  warn(text) { return this.#push({ role: 'warn', text }); }
  error(text) { return this.#push({ role: 'error', text }); }

  /** A tool call, shown inline so a pause reads as working rather than stuck. */
  tool(name) { return this.#push({ role: 'tool', text: name }); }

  /** Marks the answer that was cut off, rather than silently truncating it. */
  interrupted() {
    const last = this.entries[this.entries.length - 1];
    if (last?.role !== 'opus' || last.interrupted) return;
    last.interrupted = true;
    this.emit('change', { type: 'interrupted', id: last.id });
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit('change', { type: 'mode', mode });
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('change', { type: 'status', status });
  }

  /** The whole list, resent on every change — it is small and never partial. */
  setTodos(todos) {
    this.todos = todos;
    this.emit('change', { type: 'todos', todos });
  }

  setSpeaking(speaking) {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.emit('change', { type: 'speaking', speaking });
  }
}
