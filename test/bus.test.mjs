import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../src/bus.mjs';

function patches(conversation) {
  const seen = [];
  conversation.on('change', (patch) => seen.push(patch));
  return seen;
}

test('a snapshot describes the whole window', () => {
  const convo = new Conversation();
  convo.you('why is the build slow');
  convo.opus('the cache is cold.', true);
  convo.setMode('chat');

  const snapshot = convo.snapshot();
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.mode, 'chat');
  assert.equal(snapshot.entries[0].role, 'you');
});

test('sentences of one answer join a single entry', () => {
  // Otherwise a four-sentence answer arrives as four stacked bubbles.
  const convo = new Conversation();
  convo.opus('the cache is cold.', true);
  convo.opus('it rebuilds every run.', false);

  assert.equal(convo.entries.length, 1);
  assert.equal(convo.entries[0].text, 'the cache is cold. it rebuilds every run.');
});

test('a new answer starts a new entry', () => {
  const convo = new Conversation();
  convo.opus('first answer.', true);
  convo.you('and the other one?');
  convo.opus('second answer.', true);

  assert.equal(convo.entries.length, 3);
  assert.equal(convo.entries[2].text, 'second answer.');
});

test('a continued sentence emits an append, not a new entry', () => {
  const convo = new Conversation();
  const seen = patches(convo);
  convo.opus('one.', true);
  convo.opus('two.', false);

  assert.deepEqual(seen.map((p) => p.type), ['entry', 'append']);
});

test('interim recognition never enters the transcript', () => {
  const convo = new Conversation();
  convo.hearing('why is the buil');
  convo.hearing('why is the build slow');

  assert.equal(convo.entries.length, 0);
  assert.equal(convo.partial, 'why is the build slow');

  // Committing the question clears whatever was still on the live line.
  convo.you('why is the build slow');
  assert.equal(convo.partial, '');
});

test('repeated state changes are not re-announced', () => {
  // The window redraws on every patch, so a mode set twice would flicker.
  const convo = new Conversation();
  const seen = patches(convo);
  convo.setMode('chat');
  convo.setMode('chat');
  convo.setStatus('thinking');
  convo.setStatus('thinking');

  assert.equal(seen.length, 2);
});

test('interrupting marks the answer that was cut off', () => {
  const convo = new Conversation();
  convo.opus('here is the long version.', true);
  convo.interrupted();

  assert.equal(convo.entries[0].interrupted, true);
});

test('interrupting when nothing was being said does nothing', () => {
  const convo = new Conversation();
  convo.you('stop');
  convo.interrupted();

  assert.equal(convo.entries[0].interrupted, undefined);
});

test('history is bounded but ids keep counting', () => {
  // A machine left running for days must not grow forever, and the window has
  // to be able to tell an old entry from a new one after a trim.
  const convo = new Conversation({ max: 3 });
  for (let i = 0; i < 6; i += 1) convo.you(`line ${i}`);

  assert.equal(convo.entries.length, 3);
  assert.equal(convo.entries[0].text, 'line 3');
  assert.equal(convo.entries[2].id, 6);
});
