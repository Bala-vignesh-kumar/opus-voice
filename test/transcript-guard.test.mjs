// test/transcript-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isHallucination, acceptable, MIN_PEAK } from '../src/transcript-guard.mjs';

test('the stock phrases Whisper invents from silence are refused', () => {
  // These are artefacts of its training data, not things anyone said. In a
  // voice assistant they arrive as unprompted turns from nothing — the same
  // class of bug as a bare "." being answered with "Still here."
  for (const text of [
    'Thank you.', 'thank you', 'Thanks for watching!', 'Thanks for watching.',
    'you', 'You', '.', 'Bye.', 'Subtitles by the Amara.org community',
  ]) {
    assert.equal(isHallucination(text), true, `should refuse: ${text}`);
  }
});

test('the same words inside a real sentence are kept', () => {
  // "thank you" is a thing people say. Only the whole-utterance case is a
  // hallucination.
  for (const text of [
    'thank you for checking that',
    'can you thank the team for me',
    'you were right about the cache',
  ]) {
    assert.equal(isHallucination(text), false, `should keep: ${text}`);
  }
});

test('silence is refused whatever the transcript says', () => {
  // The real defence. A phrase list is never complete; the microphone level is.
  assert.equal(acceptable('what files are in this project', 0.0001), false);
  assert.equal(acceptable('what files are in this project', MIN_PEAK + 0.1), true);
});

test('a real utterance at a real level is accepted', () => {
  assert.equal(acceptable('run the tests again', 0.4), true);
});

test('empty text is never acceptable', () => {
  assert.equal(acceptable('', 0.9), false);
  assert.equal(acceptable('   ', 0.9), false);
});

test('a level we cannot read is refused, not waved through', () => {
  // The energy floor is the defence that does not depend on a phrase list, so
  // it has to fail closed. An utterance event without a usable peak — an older
  // daemon, a dropped field, a malformed number — must not be the one path
  // where a hallucinated turn gets in unchecked, which is exactly what a bare
  // `peak < MIN_PEAK` comparison does when peak is undefined or NaN.
  assert.equal(acceptable('what files are in this project', undefined), false);
  assert.equal(acceptable('what files are in this project', null), false);
  assert.equal(acceptable('what files are in this project', NaN), false);
  assert.equal(acceptable('what files are in this project'), false);
});

test('a phrase looped back at us is refused however loud it is', () => {
  // Whisper's other silence artefact is degenerate repetition: it latches onto
  // one phrase and emits it over and over. Room noise puts that above the
  // energy floor, and the repeated string is not in the phrase list, so both
  // guards miss it. Nobody says the same sentence three times to an assistant.
  assert.equal(isHallucination('Thank you. Thank you. Thank you.'), true);
  assert.equal(isHallucination('you you you you'), true);
  assert.equal(acceptable('Thanks for watching. Thanks for watching. Thanks for watching.', 0.5), false);

  // And it stays narrow: real speech that repeats a word is still speech.
  assert.equal(isHallucination('no no, run the tests again'), false);
  assert.equal(isHallucination('that is a very very good point'), false);
});
