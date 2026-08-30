// test/claude.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSession, resolveClaudeBin } from '../src/claude.mjs';

/** A directory holding an executable file of the given name. */
function binDir(name = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

test('an explicit path wins over everything else', () => {
  const dir = binDir();
  const bin = path.join(dir, 'claude');
  assert.equal(resolveClaudeBin(bin, { env: { PATH: '/usr/bin' }, fallbacks: [] }), bin);
});

test('PATH is searched when there is no explicit path', () => {
  const dir = binDir();
  assert.equal(
    resolveClaudeBin(null, { env: { PATH: `/nowhere:${dir}` }, fallbacks: [] }),
    path.join(dir, 'claude'),
  );
});

// The bug this exists for: launched from the Finder or at login, the app
// inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin, and Homebrew is not on it.
test('a Homebrew install is found with the login PATH', () => {
  const dir = binDir();
  assert.equal(
    resolveClaudeBin(null, {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      fallbacks: [path.join(dir, 'claude')],
    }),
    path.join(dir, 'claude'),
  );
});

test('a directory on PATH that does not exist is skipped, not thrown on', () => {
  const dir = binDir();
  assert.equal(
    resolveClaudeBin(null, { env: { PATH: `/does/not/exist:${dir}` }, fallbacks: [] }),
    path.join(dir, 'claude'),
  );
});

test('nothing found still yields a name, so the failure names the binary', () => {
  assert.equal(resolveClaudeBin(null, { env: { PATH: '/does/not/exist' }, fallbacks: [] }), 'claude');
});

// A binary that cannot be spawned used to leave `busy` set forever: the first
// question hung on "thinking" and every later one was dropped without a word.
test('a session that cannot start reports it and does not wedge', async () => {
  const claude = new ClaudeSession({ bin: '/does/not/exist/claude' });
  const exit = new Promise((resolve) => claude.once('exit', (code, reason) => resolve(reason)));
  claude.on('error', () => {});   // otherwise EventEmitter throws it

  assert.equal(claude.send('are you there'), true);
  const reason = await exit;

  assert.match(reason, /ENOENT/);
  assert.equal(claude.busy, false, 'a later turn can still be sent');
});
