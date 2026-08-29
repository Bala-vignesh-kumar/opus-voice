import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { write, read, clear } from '../src/session.mjs';

/** A scratch path so a test run never touches a real session. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-session-'));
  return path.join(dir, 'session.json');
}

test('the session is written only for its owner to read', () => {
  const file = scratch();
  write({ url: 'http://127.0.0.1:4477/?k=abc', port: 4477, file });
  // The token is in this file. Group and world must not be able to read it,
  // which is the entire reason it is a file and not a command-line argument.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('what was written is what comes back', () => {
  const file = scratch();
  write({ url: 'http://127.0.0.1:4477/?k=abc', port: 4477, file });
  const session = read({ file });
  assert.equal(session.url, 'http://127.0.0.1:4477/?k=abc');
  assert.equal(session.port, 4477);
  assert.equal(session.pid, process.pid);
  assert.ok(session.started);
});

test('a session from a process that is gone is not a session', () => {
  const file = scratch();
  write({ url: 'http://127.0.0.1:4477/?k=abc', port: 4477, pid: 999999999, file });
  // A crashed run leaves its file behind. Trusting it would point the window at
  // a port nothing is listening on.
  assert.equal(read({ file }), null);
});

test('missing and corrupt files read as no session', () => {
  const file = scratch();
  assert.equal(read({ file }), null);
  fs.writeFileSync(file, 'not json at all');
  assert.equal(read({ file }), null);
});

test('clearing is safe whether or not there is anything to clear', () => {
  const file = scratch();
  write({ url: 'http://127.0.0.1:4477/?k=abc', port: 4477, file });
  clear({ file });
  assert.equal(fs.existsSync(file), false);
  clear({ file });   // must not throw
});
