// The to-do list.
//
// Kept as a plain JSON file in the working directory rather than a database:
// it belongs to the project you are talking about, it should survive the app
// being killed, and you should be able to read it without this app.
//
// Ordinals, not ids, are what you say out loud — "todo two is done". They are
// positions in the open list in creation order, which is also the order it
// reads them back, so what you heard is what you can refer to.

import fs from 'node:fs';
import path from 'node:path';

export const FILE = 'todos.json';

export class Todos {
  constructor(dir) {
    this.file = path.join(dir, FILE);
    this.items = [];
    this.nextId = 1;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(raw.items) ? raw.items : [];
      this.nextId = Number(raw.nextId) || this.items.length + 1;
    } catch {
      // No file yet, or one we cannot read. Either way we start clean rather
      // than refusing to run: a corrupt list must not take the app down.
      this.items = [];
      this.nextId = 1;
    }
    return this;
  }

  #save() {
    const body = JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${body}\n`, 'utf8');
  }

  get open() {
    return this.items.filter((item) => !item.done);
  }

  /** The nth open item, 1-based — the number spoken back when listing. */
  byOrdinal(n) {
    const index = Number(n);
    if (!Number.isInteger(index) || index < 1) return null;
    return this.open[index - 1] ?? null;
  }

  get(id) {
    return this.items.find((item) => item.id === Number(id)) ?? null;
  }

  add(text, { source = 'voice' } = {}) {
    const clean = String(text).trim().replace(/\s+/g, ' ');
    if (!clean) return null;
    const item = {
      id: this.nextId++,
      text: clean,
      done: false,
      source,
      created: new Date().toISOString(),
      issue: null,
    };
    this.items.push(item);
    this.#save();
    return item;
  }

  complete(id) {
    const item = this.get(id);
    if (!item || item.done) return null;
    item.done = true;
    item.completed = new Date().toISOString();
    this.#save();
    return item;
  }

  reopen(id) {
    const item = this.get(id);
    if (!item || !item.done) return null;
    item.done = false;
    delete item.completed;
    this.#save();
    return item;
  }

  remove(id) {
    const at = this.items.findIndex((item) => item.id === Number(id));
    if (at === -1) return null;
    const [item] = this.items.splice(at, 1);
    this.#save();
    return item;
  }

  /** Records the issue a to-do became, so it is never filed twice. */
  linkIssue(id, issue) {
    const item = this.get(id);
    if (!item) return null;
    item.issue = issue;
    this.#save();
    return item;
  }

  /** What the window renders. */
  snapshot() {
    return this.items.map((item, i) => ({ ...item, ordinal: this.open.indexOf(item) + 1 || null, index: i }));
  }

  /**
   * How the list is read aloud. Numbered so the numbers can be said back, and
   * capped because a spoken list past a handful of items is unusable.
   */
  spoken(limit = 5) {
    const open = this.open;
    if (open.length === 0) return 'Your list is empty.';
    const head = open.slice(0, limit)
      .map((item, i) => `${i + 1}. ${item.text}`)
      .join(' ');
    const rest = open.length > limit ? ` And ${open.length - limit} more.` : '';
    const count = open.length === 1 ? 'one to-do' : `${open.length} to-dos`;
    return `You have ${count}. ${head}${rest}`;
  }
}
