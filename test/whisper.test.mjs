// test/whisper.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Whisper } from '../src/whisper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = path.join(ROOT, 'test', 'stubs', 'whisper_server.mjs');

/** Base64 of a few float32 samples; contents do not matter to the stub. */
const PCM = Buffer.from(new Float32Array([0.1, -0.2, 0.3]).buffer).toString('base64');
/** Two utterances the stub can tell apart, for the crossed-replies test. */
const PCM_ONE = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
const PCM_TWO = Buffer.from(new Float32Array([2, 0, 0]).buffer).toString('base64');

function open(mode = 'ok', options = {}) {
  return new Whisper({ bin: process.execPath, server: STUB, env: { STUB_WHISPER_MODE: mode }, ...options });
}

test('a transcription comes back', async () => {
  const w = open();
  try {
    assert.equal(await w.transcribe(PCM, 16000), 'what files are in this project');
  } finally { w.close(); }
});

test('an engine error is not an exception', async () => {
  // Losing a turn because the nicer recognizer failed is worse than a less
  // accurate turn, so failure is an empty string and the caller falls back.
  const w = open('error');
  try {
    assert.equal(await w.transcribe(PCM, 16000), '');
  } finally { w.close(); }
});

test('a hang gives up rather than holding the turn open', async () => {
  const w = open('hang', { timeoutMs: 300 });
  try {
    const started = Date.now();
    assert.equal(await w.transcribe(PCM, 16000), '');
    assert.ok(Date.now() - started < 2000, 'timed out promptly');
  } finally { w.close(); }
});

test('empty text is a failure, not an answer', async () => {
  const w = open('empty');
  try {
    assert.equal(await w.transcribe(PCM, 16000), '');
  } finally { w.close(); }
});

test('a dead process does not take the app with it', async () => {
  const w = open('crash');
  const warnings = [];
  w.on('warn', (m) => warnings.push(m));
  try {
    const started = Date.now();
    assert.equal(await w.transcribe(PCM, 16000), '');
    // Noticing the death, not waiting out the timeout: the default timeout
    // would answer this eventually, and three silent seconds per turn is the
    // failure this is supposed to avoid.
    assert.ok(Date.now() - started < 1000, 'gave up as soon as the process died');
    assert.ok(warnings.some((m) => m.includes('exited')),
      `the exit was reported rather than swallowed: ${warnings.join(' | ')}`);
  } finally { w.close(); }
});

test('two transcriptions in flight do not cross', async () => {
  // The stub answers the second request first, with text derived from each
  // request's own audio, so a reply routed to the wrong caller shows up here.
  const w = open('echo');
  try {
    const [a, b] = await Promise.all([
      w.transcribe(PCM_ONE, 16000),
      w.transcribe(PCM_TWO, 16000),
    ]);
    assert.equal(a, 'heard 1');
    assert.equal(b, 'heard 2');
  } finally { w.close(); }
});
