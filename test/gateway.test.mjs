// test/gateway.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewaySession } from '../src/gateway.mjs';
import { loadConfig } from '../src/config.mjs';

/**
 * A fetch that replays the given SSE lines as one streamed response.
 *
 * The real gateway sends `data: {json}` per token and `data: [DONE]` to close.
 * Chunk boundaries are deliberately not aligned to lines in some tests: the
 * network splits wherever it likes and the parser has to cope.
 */
function stubFetch(chunks, { ok = true, status = 200, body = '' } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options, sent: JSON.parse(options.body) });
    if (!ok) return { ok, status, text: async () => body };
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const chunk of chunks) yield new TextEncoder().encode(chunk);
      })(),
    };
  };
  fetch.calls = calls;
  return fetch;
}

/** The SSE frame the gateway sends for one token of spoken text. */
const delta = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
const done = (reason = 'stop') =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;

/** Resolves with everything the session emitted under `event` for one turn. */
function collect(session, event) {
  const seen = [];
  session.on(event, (value) => seen.push(value));
  return seen;
}

const settled = (session) => new Promise((resolve) => session.once('turn-end', resolve));

function makeSession(fetch, options = {}) {
  return new GatewaySession({
    url: 'https://gateway.test/v1',
    model: 'test-model',
    apiKey: 'test-key',
    systemPrompt: 'BE BRIEF.',
    fetch,
    ...options,
  });
}

test('spoken text arrives as deltas, in order', async () => {
  const session = makeSession(stubFetch([delta('Yeah, '), delta('that is the cache.'), done()]));
  const deltas = collect(session, 'delta');

  session.send('why is it slow');
  await settled(session);

  assert.deepEqual(deltas, ['Yeah, ', 'that is the cache.']);
});

// The network splits a stream wherever it likes. A frame cut down the middle
// used to be parsed as two broken ones and dropped, losing words mid-sentence.
test('a frame split across chunks is still one delta', async () => {
  const frame = delta('hello');
  const session = makeSession(stubFetch([frame.slice(0, 20), frame.slice(20), done()]));
  const deltas = collect(session, 'delta');

  session.send('hi');
  await settled(session);

  assert.deepEqual(deltas, ['hello']);
});

// The chunker flushes on this. Without it the last sentence of one answer is
// glued to the first of the next.
test('the end of the text is announced before the turn ends', async () => {
  const session = makeSession(stubFetch([delta('done'), done()]));
  const order = [];
  session.on('text-end', () => order.push('text-end'));
  session.on('turn-end', () => order.push('turn-end'));

  session.send('anything');
  await settled(session);

  assert.deepEqual(order, ['text-end', 'turn-end']);
});

// The CLI kept history inside its own process. Nothing does that here, so the
// session has to carry the conversation itself or every turn starts cold.
test('the conversation is carried into the next turn', async () => {
  const fetch = stubFetch([delta('Blue.'), done()]);
  const session = makeSession(fetch);

  session.send('favourite colour');
  await settled(session);
  session.send('why');
  await settled(session);

  assert.deepEqual(fetch.calls[1].sent.messages, [
    { role: 'system', content: 'BE BRIEF.' },
    { role: 'user', content: 'favourite colour' },
    { role: 'assistant', content: 'Blue.' },
    { role: 'user', content: 'why' },
  ]);
});

test('the persona leads every request', async () => {
  const fetch = stubFetch([delta('hi'), done()]);
  const session = makeSession(fetch);

  session.send('hello');
  await settled(session);

  assert.equal(fetch.calls[0].sent.messages[0].role, 'system');
  assert.equal(fetch.calls[0].sent.messages[0].content, 'BE BRIEF.');
  assert.equal(fetch.calls[0].sent.stream, true);
  assert.equal(fetch.calls[0].sent.model, 'test-model');
});

test('the key travels in the authorization header, never in the url', async () => {
  const fetch = stubFetch([delta('hi'), done()]);
  const session = makeSession(fetch);

  session.send('hello');
  await settled(session);

  assert.equal(fetch.calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.ok(!fetch.calls[0].url.includes('test-key'));
});

test('a second turn is refused while one is in flight', async () => {
  const session = makeSession(stubFetch([delta('one'), done()]));

  assert.equal(session.send('first'), true);
  assert.equal(session.send('second'), false);
  await settled(session);
  assert.equal(session.send('third'), true);
});

// The failure that wedges the app: a turn that errors without clearing `busy`
// leaves every later question dropped in silence.
test('a refused request reports the error and does not wedge', async () => {
  const session = makeSession(
    stubFetch([], { ok: false, status: 429, body: '{"error":"daily limit"}' }),
  );
  const errors = [];
  session.on('error', (err) => errors.push(err.message));

  session.send('hello');
  await settled(session);

  assert.equal(session.busy, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /429/);
  assert.match(errors[0], /daily limit/);
});

test('a stream that dies mid-answer is reported and does not wedge', async () => {
  const fetch = async () => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield new TextEncoder().encode(delta('half a sen'));
      throw new Error('socket hang up');
    })(),
  });
  const session = makeSession(fetch);
  const errors = [];
  session.on('error', (err) => errors.push(err.message));

  session.send('hello');
  await settled(session);

  assert.equal(session.busy, false);
  assert.match(errors[0], /socket hang up/);
});

// A failed turn must not leave a user message with no answer after it: the next
// request would carry two user turns in a row, which some models refuse.
test('a failed turn is dropped from the history rather than left dangling', async () => {
  let fail = true;
  const good = stubFetch([delta('fine'), done()]);
  const fetch = async (url, options) => {
    if (fail) {
      fail = false;
      return { ok: false, status: 500, text: async () => 'boom' };
    }
    return good(url, options);
  };
  const session = makeSession(fetch);
  session.on('error', () => {});

  session.send('first');
  await settled(session);
  session.send('second');
  await settled(session);

  assert.deepEqual(good.calls[0].sent.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(good.calls[0].sent.messages[1].content, 'second');
});

// Left unbounded, a long conversation grows until the gateway refuses it.
test('an overlong conversation loses its oldest turns, never the persona', async () => {
  const fetch = stubFetch([delta('ok'), done()]);
  const session = makeSession(fetch, { maxTurns: 1 });

  for (const text of ['one', 'two', 'three']) {
    session.send(text);
    await settled(session);
  }

  const sent = fetch.calls[2].sent.messages;
  assert.equal(sent[0].role, 'system');
  assert.equal(sent.length, 1 + 2 * 1 + 1);   // persona, one whole turn, the new question
  assert.equal(sent[1].content, 'two');       // 'one' has aged out
  assert.equal(sent.at(-1).content, 'three');
});

test('restarting forgets the conversation but keeps the persona', async () => {
  const fetch = stubFetch([delta('ok'), done()]);
  const session = makeSession(fetch);

  session.send('remember this');
  await settled(session);
  session.restart();
  session.send('do you');
  await settled(session);

  assert.deepEqual(fetch.calls[1].sent.messages, [
    { role: 'system', content: 'BE BRIEF.' },
    { role: 'user', content: 'do you' },
  ]);
});

// Reasoning models put their private thinking in a separate field. It is
// surfaced for the display and must never reach the synthesizer.
test('reasoning is emitted as thinking, not as speech', async () => {
  const reasoning = `data: ${JSON.stringify({
    choices: [{ delta: { reasoning_content: 'the user means the cache' }, finish_reason: null }],
  })}\n\n`;
  const session = makeSession(stubFetch([reasoning, delta('The cache.'), done()]));
  const deltas = collect(session, 'delta');
  const thinking = collect(session, 'thinking');

  session.send('why');
  await settled(session);

  assert.deepEqual(thinking, ['the user means the cache']);
  assert.deepEqual(deltas, ['The cache.']);
});

test('closing mid-turn stops the stream and clears busy', async () => {
  const session = makeSession(stubFetch([delta('one'), done()]));
  session.send('hello');
  session.close();
  await settled(session);
  assert.equal(session.busy, false);
});

// --- the switch that chooses a backend -------------------------------------

test('the local backend is the default, so nothing leaves the machine unasked', () => {
  process.env.FALCON_IGNORE_CONFIG = '1';
  assert.equal(loadConfig([]).backend, 'claude');
});

test('the gateway is reachable by flag, with a model and a url to go with it', () => {
  process.env.FALCON_IGNORE_CONFIG = '1';
  const config = loadConfig(['--backend', 'gateway', '--gateway-model', 'gpt-5.4']);
  assert.equal(config.backend, 'gateway');
  assert.equal(config.gatewayModel, 'gpt-5.4');
  assert.match(config.gatewayUrl, /^https:\/\//);
});
