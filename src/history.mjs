// Conversations, kept.
//
// Everything else the app produces outlives the session — notes/ on disk,
// todos.json — but the conversations themselves only ever existed in memory,
// so "what did we decide about the build on Tuesday" had no answer. This keeps
// them.
//
// One file per conversation, a day per folder, mirroring how notes/ is laid
// out. They live under ~/.opus-voice rather than in the working directory on
// purpose: notes are written because you asked for them and belong with the
// project, and a transcript of every time you talked to your machine is not
// something to drop into somebody's repository.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slug } from './notes.mjs';

export const DIR = path.join(os.homedir(), '.opus-voice', 'chats');

// A title is the first thing you said, which is nearly always what the
// conversation was about. Long enough to be recognisable in a list, short
// enough not to wrap.
const TITLE_MAX = 64;

/** Cuts at a word boundary rather than mid-word, and never mid-sentence-end. */
function titleOf(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= TITLE_MAX) return clean;
  const cut = clean.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}…`;
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}`,
  };
}

/**
 * The conversation being had, written down as it happens.
 *
 * Flushed on every turn rather than at the end: the process is killed with
 * ctrl-c far more often than it is shut down, and a transcript that only
 * survives a clean exit is one that is missing whenever you actually want it.
 */
export class History {
  constructor({ dir = DIR, workdir = process.cwd() } = {}) {
    this.dir = dir;
    this.workdir = workdir;
    this.record = null;
    this.file = null;
  }

  get open() {
    return this.record !== null;
  }

  /** Starts a conversation if one is not already open. */
  begin(mode = 'chat') {
    if (this.record) return;
    this.record = {
      started: new Date().toISOString(),
      ended: null,
      dir: this.workdir,
      mode,
      title: '',
      turns: [],
    };
    this.file = null;
  }

  you(text) {
    if (!text?.trim()) return;
    this.begin();
    this.record.turns.push({ role: 'you', text: text.trim(), at: Date.now() });
    if (!this.record.title) this.record.title = titleOf(text);
    this.#flush();
  }

  /**
   * A sentence on its way to the synthesizer. Consecutive sentences of one
   * answer join the same turn, for the same reason the window joins them: an
   * answer is a paragraph, not a stack of one-liners.
   */
  opus(text, first) {
    if (!text?.trim()) return;
    if (!this.record) return;   // nothing said to it yet; not a conversation
    const last = this.record.turns[this.record.turns.length - 1];
    if (!first && last?.role === 'opus') {
      last.text = `${last.text} ${text.trim()}`.trim();
    } else {
      this.record.turns.push({ role: 'opus', text: text.trim(), at: Date.now() });
    }
    this.#flush();
  }

  /** Closes the conversation. A record with nothing in it is not written. */
  end() {
    if (!this.record) return;
    if (this.record.turns.length === 0) {
      this.record = null;
      this.file = null;
      return;
    }
    this.record.ended = new Date().toISOString();
    this.#flush();
    this.record = null;
    this.file = null;
  }

  #flush() {
    if (!this.record) return;
    try {
      const at = new Date(this.record.started);
      const { day, time } = stamp(at);
      const folder = path.join(this.dir, day);
      fs.mkdirSync(folder, { recursive: true });
      // The name is fixed on the first flush so later turns rewrite the same
      // file rather than leaving a trail of half-conversations behind.
      if (!this.file) {
        this.file = path.join(folder, `${time}-${slug(this.record.title) || 'conversation'}.json`);
      }
      const scratch = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(scratch, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(scratch, this.file);
    } catch {
      // Losing a transcript must never take down a conversation in progress.
    }
  }
}

/** `2026-08-30/1406-why-the-build-is-slow` — a path, minus the extension. */
function idOf(file, dir) {
  return path.relative(dir, file).replace(/\.json$/, '');
}

/**
 * Recent conversations, newest first, without their turns.
 *
 * Reads every file rather than keeping an index: a year of talking to this
 * thing is a few thousand small files, and an index is one more thing that can
 * disagree with what is actually on disk.
 */
export function list({ dir = DIR, limit = 200 } = {}) {
  let days;
  try {
    days = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return [];
  }

  const out = [];
  for (const day of days) {
    const folder = path.join(dir, day);
    let files;
    try {
      files = fs.readdirSync(folder).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch {
      continue;
    }
    for (const name of files) {
      if (out.length >= limit) return out;
      const file = path.join(folder, name);
      let record;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;   // a half-written file is not worth failing the list over
      }
      const turns = Array.isArray(record.turns) ? record.turns : [];
      const answer = turns.find((t) => t.role === 'opus');
      out.push({
        id: idOf(file, dir),
        day,
        started: record.started,
        ended: record.ended,
        mode: record.mode ?? 'chat',
        dir: record.dir ?? '',
        title: record.title || 'Untitled',
        preview: answer?.text ?? '',
        turns: turns.length,
      });
    }
  }
  return out;
}

/** One conversation in full, or null. */
export function read(id, { dir = DIR } = {}) {
  const file = path.resolve(dir, `${id}.json`);
  // An id arrives from the window, which means it arrives from the network.
  if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { id, ...record };
  } catch {
    return null;
  }
}
