import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, nextFiller, narrate } from '../src/style.mjs';

test('instructions are told apart from questions', () => {
  assert.equal(classify('open the config file'), 'command');
  assert.equal(classify('run the tests'), 'command');
  assert.equal(classify('please fix the typo'), 'command');
  assert.equal(classify('why is the build slow'), 'question');
  assert.equal(classify('is that the cache?'), 'question');
});

test('a polite instruction still sounds like a question', () => {
  // "can you open it" gets answered like a question, so it gets the same beat.
  assert.equal(classify('can you open the config file'), 'question');
  assert.equal(classify('could you run the tests'), 'question');
});

test('a question mark settles it', () => {
  assert.equal(classify('run the tests?'), 'question');
});

test('anything else falls through without guessing', () => {
  assert.equal(classify('the deploy failed again'), 'other');
  assert.equal(classify(''), 'other');
  assert.equal(classify(undefined), 'other');
});

test('the thinking beat matches what was asked', () => {
  // Twenty samples: enough that a wrong pool would show up, cheap enough to run.
  const pondering = ['mm, let me think', 'hm, good question', 'let me think', 'one sec', 'hang on'];
  for (let i = 0; i < 20; i += 1) {
    assert.ok(pondering.includes(nextFiller('why is the build slow')), 'question filler');
  }
});

test('an instruction is acknowledged, not pondered', () => {
  const acknowledgements = ['sure', 'on it', 'yep, one sec', 'okay', 'doing that now', 'right'];
  for (let i = 0; i < 20; i += 1) {
    assert.ok(acknowledgements.includes(nextFiller('run the tests')), 'command filler');
  }
});

test('nothing is said twice in a row', () => {
  // A repeated tic is what makes a voice sound synthetic.
  let previous = null;
  for (let i = 0; i < 40; i += 1) {
    const filler = nextFiller('why is it slow');
    assert.notEqual(filler, previous);
    previous = filler;
  }
});

test('tool narration knows the common tools and survives the rest', () => {
  assert.ok(['let me look', 'opening it', 'reading it now'].includes(narrate('Read', true)));
  assert.equal(typeof narrate('SomeToolWeHaveNeverSeen', true), 'string');
  assert.ok(['still going', 'still on it', 'nearly there', 'one more thing'].includes(narrate('Read', false)));
});
