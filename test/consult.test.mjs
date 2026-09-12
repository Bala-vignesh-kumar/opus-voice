// test/consult.test.mjs — the one route reachable from off this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UiServer } from '../src/server.mjs';
import { Conversation } from '../src/bus.mjs';

// Each test gets its own port, for the reason server.test.mjs explains: a
// pooled socket to a closed server comes back as ECONNRESET on the next one.
let nextPort = 18600;

async function server(options = {}) {
  const s = new UiServer(new Conversation(), () => {}, {
    port: nextPort++,
    sessionFile: null,
    ...options,
  });
  await s.listen();
  return s;
}

function post(s, body, { token = s.token, path = '/consult' } = {}) {
  return fetch(`http://127.0.0.1:${s.port}${path}?k=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CALL = { call_id: 'call_1', secret: 's3cret' };

function expecting(s, handler) {
  s.expectConsult({ secret: CALL.secret, callId: CALL.call_id, handler });
}

function ask(question = 'They offer 8pm. Accept?') {
  return { call_id: CALL.call_id, metadata: { secret: CALL.secret }, args: { question } };
}

test('between calls the route does not exist at all', async () => {
  // A leaked tunnel URL is inert rather than merely unauthorised.
  const s = await server();
  try {
    const res = await post(s, ask());
    assert.equal(res.status, 404);
  } finally { s.close(); }
});

test('a consult reaches the handler and its answer goes back to the agent', async () => {
  const s = await server();
  try {
    let asked = '';
    expecting(s, async (question) => { asked = question; return 'yes, book it'; });
    const res = await post(s, ask());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { response: 'yes, book it' });
    assert.equal(asked, 'They offer 8pm. Accept?');
  } finally { s.close(); }
});

test('the response is held open until you answer', async () => {
  // This is what keeps the far end on the line rather than hearing dead air.
  const s = await server();
  try {
    let release;
    expecting(s, () => new Promise((r) => { release = r; }));
    const pending = post(s, ask());
    await new Promise((r) => setTimeout(r, 50));
    let done = false;
    pending.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(done, false, 'it answered before the decision was made');
    release('eight is fine');
    assert.deepEqual(await (await pending).json(), { response: 'eight is fine' });
  } finally { s.close(); }
});

test('the wrong session token is refused', async () => {
  const s = await server();
  try {
    expecting(s, async () => 'yes');
    const res = await post(s, ask(), { token: 'not-the-token' });
    assert.equal(res.status, 403);
  } finally { s.close(); }
});

test('the right token with the wrong call secret is refused', async () => {
  // The token is in the tunnel URL, which the provider has. The secret proves
  // the callback came from the call we actually placed.
  const s = await server();
  try {
    expecting(s, async () => 'yes');
    const res = await post(s, { ...ask(), metadata: { secret: 'guessed' } });
    assert.equal(res.status, 403);
  } finally { s.close(); }
});

test('a callback for a different call is refused', async () => {
  const s = await server();
  try {
    expecting(s, async () => 'yes');
    const res = await post(s, { ...ask(), call_id: 'call_from_yesterday' });
    assert.equal(res.status, 403);
  } finally { s.close(); }
});

test('a handler that throws still answers the agent, honestly', async () => {
  // Leaving the provider hanging is worse: the agent improvises instead.
  const s = await server();
  try {
    expecting(s, async () => { throw new Error('the microphone is gone'); });
    const res = await post(s, ask());
    assert.equal(res.status, 200);
    assert.match((await res.json()).response, /cannot check right now/);
  } finally { s.close(); }
});

test('clearing the consult closes the door again', async () => {
  const s = await server();
  try {
    expecting(s, async () => 'yes');
    s.clearConsult();
    assert.equal((await post(s, ask())).status, 404);
  } finally { s.close(); }
});

test('rubbish in the body is a bad request, not a crash', async () => {
  const s = await server();
  try {
    expecting(s, async () => 'yes');
    const res = await fetch(`http://127.0.0.1:${s.port}/consult?k=${s.token}`, {
      method: 'POST', body: 'not json',
    });
    assert.equal(res.status, 400);
  } finally { s.close(); }
});
