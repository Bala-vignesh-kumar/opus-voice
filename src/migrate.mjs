// Carrying the old state across when the app was renamed.
//
// Everything the app remembers lived under ~/.opus-voice: the conversations, the
// wake file, and the Siri hook that touches it. The name changed; those are
// still somebody's conversations.
//
// It copies rather than moves, on purpose. A move that goes wrong halfway has
// taken the only copy with it, and there is no version of this worth losing a
// year of transcripts to. What is left behind is the backup, and deleting it is
// a decision for the person whose files they are.
//
// Nothing here throws. A failed migration means an empty library, which is sad;
// an app that will not start is worse.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OLD_DIR = path.join(os.homedir(), '.opus-voice');
export const NEW_DIR = path.join(os.homedir(), '.falcon');

/** What the assistant used to be called in a conversation on disk. */
const OLD_ROLE = 'opus';
const NEW_ROLE = 'falcon';

/**
 * Copies conversations and the Siri hook from the old directory to the new one.
 *
 * Runs at startup, before anything reads state. Doing nothing is the normal
 * outcome — there is no old directory, or the new one already exists, which
 * between them cover every run after the first.
 *
 * @returns {{migrated: boolean, chats: number, hook: boolean, problem: string|null}}
 */
export function migrate({ from = OLD_DIR, to = NEW_DIR } = {}) {
  const idle = { migrated: false, chats: 0, hook: false, problem: null };

  // The new directory existing means this already ran, or the app has been
  // running under the new name all along. Either way its contents are current
  // and the old ones are not, so copying over them would be a downgrade.
  if (!exists(from) || exists(to)) return idle;

  try {
    fs.mkdirSync(to, { recursive: true });
    const chats = copyChats(path.join(from, 'chats'), path.join(to, 'chats'));
    const hook = copyHook(from, to);
    return { migrated: true, chats, hook, problem: null };
  } catch (err) {
    return { ...idle, problem: err.message };
  }
}

/**
 * Copies every conversation across, rewriting the speaker's name as it goes.
 *
 * Deliberately not `cp -r`: the whole directory also holds a session file
 * describing a server that is not running and a log describing a run that is
 * over. A stale session file is the worse of the two — it points a window at a
 * port nothing is listening on, which looks exactly like the app being broken.
 *
 * @returns {number} how many conversations were carried across
 */
function copyChats(from, to) {
  if (!exists(from)) return 0;

  let count = 0;
  for (const day of readdir(from)) {
    const source = path.join(from, day);
    if (!isDirectory(source)) continue;
    const target = path.join(to, day);
    fs.mkdirSync(target, { recursive: true });

    for (const name of readdir(source)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(source, name);
      if (!isFile(file)) continue;
      fs.writeFileSync(path.join(target, name), renamed(fs.readFileSync(file, 'utf8')), { mode: 0o600 });
      count += 1;
    }
  }
  return count;
}

/**
 * One conversation with the speaker renamed.
 *
 * A file that will not parse is copied through untouched rather than dropped.
 * It is half a conversation somebody had — being unable to rename it is not a
 * reason to lose it, and `history.list()` already skips what it cannot read.
 */
function renamed(body) {
  let record;
  try {
    record = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(record?.turns)) return body;

  let touched = false;
  for (const turn of record.turns) {
    if (turn?.role !== OLD_ROLE) continue;
    turn.role = NEW_ROLE;
    touched = true;
  }
  return touched ? `${JSON.stringify(record, null, 2)}\n` : body;
}

/**
 * Copies the Siri hook, repointed at the new wake file.
 *
 * This is the half of the migration that is easy to forget and impossible to
 * notice. The hook is a script Shortcuts runs; it writes to an absolute path
 * that was baked in when it was created. Carried across unchanged it keeps
 * touching the old wake file, nothing is watching that any more, and "hey siri,
 * falcon" quietly stops working — with no error anywhere, because from the
 * app's side nobody ever asked for anything.
 *
 * @returns {boolean} whether there was a hook to repoint
 */
function copyHook(from, to) {
  const source = path.join(from, 'wake.sh');
  if (!isFile(source)) return false;

  const script = fs.readFileSync(source, 'utf8').split(from).join(to);
  fs.writeFileSync(path.join(to, 'wake.sh'), script, { mode: 0o755 });
  return true;
}

// Every probe answers false rather than throwing: a path that cannot be
// examined is one this should skip, not one it should die on.

function exists(target) {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function readdir(target) {
  try {
    return fs.readdirSync(target).sort();
  } catch {
    return [];
  }
}
