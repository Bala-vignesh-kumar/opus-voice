import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechChunker, sanitize } from '../src/chunk.mjs';

/** Feeds text in small random slices, the way deltas actually arrive. */
function stream(text, options) {
  const chunker = new SpeechChunker(options);
  const out = [];
  for (let i = 0; i < text.length; i += 7) {
    out.push(...chunker.push(text.slice(i, i + 7)));
  }
  out.push(...chunker.flush());
  return out;
}

test('splits into sentences regardless of delta boundaries', () => {
  const out = stream('The cache is rebuilding every run. That is most of your build time. Want the fix?');
  assert.deepEqual(out, [
    'The cache is rebuilding every run.',
    'That is most of your build time.',
    'Want the fix?',
  ]);
});

test('does not split on decimals or abbreviations', () => {
  assert.deepEqual(
    stream('It costs 3.50 per unit and Dr. Chen approved it. Done.'),
    ['It costs 3.50 per unit and Dr. Chen approved it.', 'Done.'],
  );
});

test('merges short fragments so the synthesizer never gets a stub', () => {
  const text = 'Yes. No. Maybe. That covers the whole question you asked me today.';
  const out = stream(text);
  // The first chunk takes the fast path and may be short; everything after it
  // is merged up to length so the delivery doesn't turn choppy.
  assert.ok(out.slice(1).every((s) => s.length >= 20), `stub emitted: ${JSON.stringify(out)}`);
  assert.equal(out.join(' '), text, 'no text may be lost while merging');
});

test('first sentence goes out immediately rather than waiting to be merged', () => {
  const chunker = new SpeechChunker();
  // Short opener that would otherwise be held back until the next sentence.
  assert.deepEqual(chunker.push("It's the cache. "), ["It's the cache."]);
});

test('reset restores the fast path for the next reply', () => {
  const chunker = new SpeechChunker();
  chunker.push('It is the cache. ');
  chunker.push('Short. ');                    // merged, not first any more
  chunker.reset();
  assert.deepEqual(chunker.push('New turn. '), ['New turn.']);
});

test('emits the first sentence before the rest has arrived', () => {
  const chunker = new SpeechChunker();
  const early = chunker.push('The answer is the cache, definitely. And also ');
  assert.deepEqual(early, ['The answer is the cache, definitely.']);
});

test('strips markdown rather than speaking it', () => {
  assert.equal(sanitize('**bold** and *italic* and `code`'), 'bold and italic and code');
  assert.equal(sanitize('## Heading here'), 'Heading here');
  assert.equal(sanitize('- first item'), 'first item');
  assert.equal(sanitize('1. numbered item'), 'numbered item');
  assert.equal(sanitize('see [the docs](https://x.com/y)'), 'see the docs');
});

test('never speaks the contents of a code block', () => {
  const out = stream('Here is the fix. ```js\nconst x = 1;\n``` That should do it.').join(' ');
  assert.ok(!out.includes('const x'), `code leaked into speech: ${out}`);
  assert.ok(out.includes('Here is the fix.'));
  assert.ok(out.includes('That should do it.'));
});

test('holds an unclosed code fence instead of speaking half of it', () => {
  const chunker = new SpeechChunker();
  chunker.push('Try this. ```js\nconst x = 1.');
  const spoken = chunker.push(' More code here.').join(' ');
  assert.ok(!spoken.includes('const x'), `spoke inside an open fence: ${spoken}`);
});

test('flush releases an unterminated trailing sentence', () => {
  const chunker = new SpeechChunker();
  chunker.push('All of that is now completely done here.');
  chunker.push(' and this has no period');
  assert.deepEqual(chunker.flush(), ['and this has no period']);
});
