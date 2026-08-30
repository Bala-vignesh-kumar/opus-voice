// test/piper.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Piper } from '../src/piper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = path.join(ROOT, 'test', 'stubs', 'piper_server.mjs');

function open(mode) {
  return new Piper('stub', { python: process.execPath, server: STUB, voice: { model: 'm', config: 'c' }, env: { STUB_PIPER_MODE: mode } });
}

/** Waits for the child to be gone, so the next write really does hit a dead pipe. */
function dead(piper) {
  return new Promise((resolve) => piper.child.once('exit', () => setTimeout(resolve, 50)));
}

test('a voice that is not installed is refused', () => {
  assert.throws(() => new Piper('no-such-voice'), /not installed/);
});

// The crash this exists for: closing after the child had already gone threw
// EPIPE out of a socket with no error listener, which takes the whole process
// down — and it happened inside shutdown(), so the app died on its way out
// instead of putting the microphone back.
test('closing a dead piper does not throw', async () => {
  const p = open('die');
  p.on('error', () => {});
  await dead(p);
  assert.doesNotThrow(() => p.close());
});

test('speaking to a dead piper does not throw', async () => {
  const p = open('die');
  p.on('error', () => {});
  await dead(p);
  assert.doesNotThrow(() => p.synthesize(1, 'anybody there'));
});

test('closing twice is harmless', async () => {
  const p = open('ok');
  p.on('error', () => {});
  p.close();
  assert.doesNotThrow(() => p.close());
});
