import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '../src/migrate.mjs';

/** A throwaway pair of home-directory paths: the old state and where it goes. */
function beds() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'falcon-migrate-'));
  return { root, from: path.join(root, '.opus-voice'), to: path.join(root, '.falcon') };
}

function chat(dir, name, turns) {
  const day = path.join(dir, 'chats', '2026-08-30');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, name), JSON.stringify({ title: 'why the build is slow', turns }, null, 2));
}

test('does nothing when there is no old directory', () => {
  const { from, to } = beds();
  const result = migrate({ from, to });
  assert.equal(result.migrated, false);
  assert.equal(fs.existsSync(to), false);
});

test('does nothing when the new directory already exists', () => {
  const { from, to } = beds();
  fs.mkdirSync(from, { recursive: true });
  fs.mkdirSync(to, { recursive: true });
  chat(from, '1406-a.json', [{ role: 'you', text: 'hello' }]);

  const result = migrate({ from, to });
  assert.equal(result.migrated, false);
  // The new directory is the one in use; it must not be written over.
  assert.equal(fs.existsSync(path.join(to, 'chats')), false);
});

test('copies conversations across and leaves the old directory as a backup', () => {
  const { from, to } = beds();
  chat(from, '1406-a.json', [{ role: 'you', text: 'why is the build slow' }]);
  chat(from, '1712-b.json', [{ role: 'you', text: 'second' }]);

  const result = migrate({ from, to });

  assert.equal(result.migrated, true);
  assert.equal(result.chats, 2);
  assert.equal(fs.existsSync(path.join(to, 'chats', '2026-08-30', '1406-a.json')), true);
  // The original is the backup, so it stays exactly where it was.
  assert.equal(fs.existsSync(path.join(from, 'chats', '2026-08-30', '1406-a.json')), true);
});

test('rewrites the speaker role inside the copies, not the originals', () => {
  const { from, to } = beds();
  chat(from, '1406-a.json', [
    { role: 'you', text: 'why is the build slow' },
    { role: 'opus', text: 'the cache is cold.' },
  ]);

  migrate({ from, to });

  const moved = JSON.parse(fs.readFileSync(path.join(to, 'chats', '2026-08-30', '1406-a.json'), 'utf8'));
  assert.deepEqual(moved.turns.map((t) => t.role), ['you', 'falcon']);

  const original = JSON.parse(fs.readFileSync(path.join(from, 'chats', '2026-08-30', '1406-a.json'), 'utf8'));
  assert.deepEqual(original.turns.map((t) => t.role), ['you', 'opus']);
});

test('leaves a conversation that is already in the new shape alone', () => {
  const { from, to } = beds();
  chat(from, '1406-a.json', [{ role: 'falcon', text: 'already renamed.' }]);

  migrate({ from, to });

  const moved = JSON.parse(fs.readFileSync(path.join(to, 'chats', '2026-08-30', '1406-a.json'), 'utf8'));
  assert.deepEqual(moved.turns.map((t) => t.role), ['falcon']);
});

test('copies a file it cannot parse rather than dropping it', () => {
  const { from, to } = beds();
  const day = path.join(from, 'chats', '2026-08-30');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'half-written.json'), '{"turns": [{"role": "opu');

  const result = migrate({ from, to });

  assert.equal(result.migrated, true);
  // Unreadable is not the same as unwanted: it is still somebody's conversation.
  assert.equal(fs.existsSync(path.join(to, 'chats', '2026-08-30', 'half-written.json')), true);
});

test('does not carry across the session file or the log', () => {
  const { from, to } = beds();
  chat(from, '1406-a.json', [{ role: 'you', text: 'hello' }]);
  fs.writeFileSync(path.join(from, 'session.json'), '{"url":"http://127.0.0.1:4477/?k=dead"}');
  fs.writeFileSync(path.join(from, 'opus-voice.log'), 'old run');

  migrate({ from, to });

  // Both describe a run that is over. A stale session file in particular would
  // point a window at a port nothing is listening on.
  assert.equal(fs.existsSync(path.join(to, 'session.json')), false);
  assert.equal(fs.existsSync(path.join(to, 'opus-voice.log')), false);
});

test('repoints the Siri hook at the new wake file', () => {
  const { from, to } = beds();
  chat(from, '1406-a.json', [{ role: 'you', text: 'hello' }]);
  fs.writeFileSync(
    path.join(from, 'wake.sh'),
    `#!/bin/bash\nprintf '%s\\n' "$RANDOM" > "${from}/wake" || exit 1\n`,
    { mode: 0o755 },
  );

  const result = migrate({ from, to });

  const hook = fs.readFileSync(path.join(to, 'wake.sh'), 'utf8');
  assert.ok(hook.includes(`${to}/wake`), 'the hook should touch the new wake file');
  assert.ok(!hook.includes(`${from}/wake`), 'no reference to the old one should survive');
  assert.equal(result.hook, true);
  // Still runnable, or Siri wakes nothing.
  assert.equal(fs.statSync(path.join(to, 'wake.sh')).mode & 0o111, 0o111);
});

test('runs once — a second call finds the work already done', () => {
  const { from, to } = beds();
  chat(from, '1406-a.json', [{ role: 'opus', text: 'first.' }]);

  assert.equal(migrate({ from, to }).migrated, true);
  assert.equal(migrate({ from, to }).migrated, false);
});

test('reports a failure instead of throwing', () => {
  const { root, from, to } = beds();
  chat(from, '1406-a.json', [{ role: 'you', text: 'hello' }]);
  // Nothing can be created alongside the old directory, so the copy cannot start.
  fs.chmodSync(root, 0o555);

  try {
    const result = migrate({ from, to });
    assert.equal(result.migrated, false);
    assert.ok(result.problem, 'the caller needs something to warn with');
  } finally {
    fs.chmodSync(root, 0o755);
  }
});
