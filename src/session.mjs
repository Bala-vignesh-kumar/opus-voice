// Where the current session can be found, for anything that needs to attach to
// it — the menu bar app, the window, a second browser.
//
// A file rather than a command-line argument because the URL carries the token,
// and argv is world-readable: any process on the machine can read it out of
// `ps` and then POST commands to something allowed to edit files and run shell
// commands. Mode 0600 is the point of this module.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIR = path.join(os.homedir(), '.falcon');
export const DEFAULT_FILE = path.join(DIR, 'session.json');

/** Writes the session and returns the path it went to. */
export function write({ url, port, pid = process.pid, file = DEFAULT_FILE }) {
  const body = JSON.stringify({ pid, port, url, started: new Date().toISOString() }, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written through a scratch file so a reader never sees a half-written one,
  // and created 0600 from the start rather than widened and then narrowed.
  const scratch = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(scratch, `${body}\n`, { mode: 0o600 });
  fs.renameSync(scratch, file);
  return file;
}

/** The current session, or null if there isn't one worth trusting. */
export function read({ file = DEFAULT_FILE } = {}) {
  let session;
  try {
    session = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!session?.url) return null;
  // A crashed run leaves its file behind, and pointing a window at a port
  // nothing is listening on looks exactly like the app being broken.
  if (!alive(session.pid)) return null;
  return session;
}

export function clear({ file = DEFAULT_FILE } = {}) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

/** Whether a pid is still running. Signal 0 tests without delivering. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return err.code === 'EPERM';
  }
}
