// test/voice.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.FALCON_IO_BIN = path.join(ROOT, 'test', 'stubs', 'voiceio.mjs');
const { VoiceIO } = await import('../src/voice.mjs');

const ready = (v) => new Promise((r) => v.once('ready', r));

// Unplugging headphones takes the audio daemon down with the device. That used
// to end the app: `voice.on('exit', () => shutdown(1))`. Losing a microphone is
// not a reason to stop being an assistant.
test('a restarted daemon comes back ready', async () => {
  const voice = new VoiceIO({});
  voice.on('error', () => {});
  await ready(voice);

  const again = ready(voice);
  voice.restart();
  await again;                                   // resolves only if it respawned

  assert.equal(voice.child.exitCode, null, 'the new child is running');
  voice.child.kill();
});

test('speaking to a dead daemon does not throw', async () => {
  const voice = new VoiceIO({});
  voice.on('error', () => {});
  await ready(voice);
  const gone = new Promise((r) => voice.child.once('exit', () => setTimeout(r, 50)));
  voice.child.kill();
  await gone;
  assert.doesNotThrow(() => voice.speak('anybody there'));
  voice.child.kill();
});

test('the microphone preference reaches the daemon as an argument', async () => {
  const voice = new VoiceIO({ micDevice: 'default' });
  voice.on('error', () => {});
  await ready(voice);
  assert.ok(voice.child.spawnargs.includes('--mic-device'), 'flag is passed');
  assert.ok(voice.child.spawnargs.includes('default'), 'value is passed');
  voice.child.kill();
});
