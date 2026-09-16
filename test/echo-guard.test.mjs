// The cases in here are transcribed from ~/.falcon/falcon.log on 4 Sep 2026,
// where the app spent a whole session answering itself. Output was the laptop
// speakers, input the built-in microphone, and echo cancellation off — so every
// noise it made came straight back down its own microphone as a question.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EchoGuard } from '../src/echo-guard.mjs';

/** A guard with a clock we control, so nothing here waits on real time. */
function guard(window = 8000) {
  let now = 1_000_000;
  const g = new EchoGuard({ window, now: () => now });
  return { g, tick: (ms) => { now += ms; } };
}

test('its own thinking beat does not come back as a question', () => {
  const { g } = guard();
  // What actually happened: "How is falcon?" was asked, the filler played, and
  // "Hang on." arrived as the next turn.
  g.said('hang on');
  assert.ok(g.isEcho('Hang on.'));
});

test('the discuss acknowledgement does not come back as a question', () => {
  const { g } = guard();
  g.said("sure, let's talk.");
  // The recognizer heard the tail of it, twice, in two different shapes.
  assert.ok(g.isEcho("Let's talk."), 'the tail of a sentence is still that sentence');
  assert.ok(g.isEcho(".. let's talk."), 'leading noise does not make it a new turn');
});

test('a run of words out of a longer answer is still the answer', () => {
  const { g } = guard();
  g.said('I will open the config file and read it back to you.');
  assert.ok(g.isEcho('open the config file'));
});

test('what it never said is left alone', () => {
  const { g } = guard();
  g.said('hang on');
  assert.equal(g.isEcho('How is falcon?'), false);
  assert.equal(g.isEcho('run the tests'), false);
});

test('sharing a word with the answer is not an echo', () => {
  const { g } = guard();
  g.said('I will open the config file and read it back to you.');
  // "file" is in both. One word in common is a coincidence, not a loop.
  assert.equal(g.isEcho('what file was that'), false);
});

test('having said nothing, it suspects nothing', () => {
  const { g } = guard();
  assert.equal(g.isEcho('hang on'), false);
  assert.equal(g.isEcho(''), false);
});

test('it stops suspecting once the sound is long gone', () => {
  const { g, tick } = guard(8000);
  g.said('hang on');
  tick(7999);
  assert.ok(g.isEcho('Hang on.'), 'still inside the window');
  tick(2);
  assert.equal(g.isEcho('Hang on.'), false,
    'saying it back a minute later is a person, not the speaker');
});

test('going to sleep forgets what it said', () => {
  const { g } = guard();
  g.said('hang on');
  g.clear();
  assert.equal(g.isEcho('Hang on.'), false);
});

test('punctuation and case are not what tells them apart', () => {
  const { g } = guard();
  g.said('One sec.');
  assert.ok(g.isEcho('one sec'));
  assert.ok(g.isEcho('ONE SEC!'));
});

test('every filler it can pick is caught coming back', async () => {
  // The loop is fed by a known, finite set: these are the noises the app makes
  // before the model has said anything, so they are the ones it hears most.
  const { FILLERS } = await import('../src/style.mjs');
  for (const kind of Object.keys(FILLERS)) {
    for (const filler of FILLERS[kind]) {
      const { g } = guard();
      g.said(filler);
      assert.ok(g.isEcho(`${filler}.`), `"${filler}" came back and was taken for a turn`);
    }
  }
});

test('it remembers more than one thing at a time', () => {
  const { g } = guard();
  g.said('sure');
  g.said('let me think');
  g.said('one sec');
  assert.ok(g.isEcho('Sure.'));
  assert.ok(g.isEcho('let me think'));
  assert.ok(g.isEcho('One sec.'));
});

test('a single short word is not enough to call it an echo', () => {
  const { g } = guard();
  g.said('I will read the file now.');
  // "read" alone is a person giving an instruction, not the answer looping.
  assert.equal(g.isEcho('read'), false);
});

test('a partial cut off mid-word is still its own voice', () => {
  // 16 Sep 2026: it was saying "Sure — I'm talking" when the recognizer's
  // interim text reached "Sure, I" — two words, so barge-in fired, and "i" is
  // not "i'm", so the guard let it through. It cut itself off.
  const { g } = guard();
  g.said("Sure — I'm talking. Want me to keep going?");
  assert.ok(g.isEcho('Sure, I', { partial: true }), 'the partial is on its way to its own sentence');
  // A finished transcript gets no such latitude: "Sure, I" as a whole turn is
  // not what it said.
  assert.equal(g.isEcho('Sure, I'), false);
  // And a partial heading somewhere else is a person.
  assert.equal(g.isEcho('Sure, it', { partial: true }), false);
});
