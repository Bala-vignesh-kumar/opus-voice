// test/phone.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Phone, callPrompt, available, DISCLOSURE, TOOL_TIMEOUT_MS } from '../src/phone.mjs';

/** A fetch that records what it was asked and replies with whatever you gave it. */
function recorder(reply = { call_id: 'call_1' }, status = 201) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: status < 400,
      status,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    };
  };
  return { calls, fetchImpl };
}

function phone(options = {}) {
  const { calls, fetchImpl } = recorder(options.reply, options.status);
  const p = new Phone({
    apiKey: 'k_test',
    fromNumber: '+15550000000',
    fetch: fetchImpl,
    ...options,
  });
  return { p, calls };
}

test('it will not dial without a key', () => {
  assert.equal(available({ RETELL_API_KEY: '' }), false);
  assert.equal(available({ RETELL_API_KEY: 'k_test' }), true);
});

test('dialing returns the provider call id', async () => {
  const { p, calls } = phone();
  const id = await p.dial({ number: '+15107096913', objective: 'a table for three at seven', webhook: 'https://x/y', secret: 's' });
  assert.equal(id, 'call_1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /create-phone-call$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k_test');
  assert.equal(calls[0].body.to_number, '+15107096913');
  assert.equal(calls[0].body.from_number, '+15550000000');
});

test('every outbound call says out loud that it is an assistant', async () => {
  // Not configurable, and asserted here rather than trusted to a prompt nobody
  // reads again. Somebody picks up a phone expecting a person.
  const { p, calls } = phone();
  await p.dial({ number: '+1', objective: 'x', webhook: 'https://x/y', secret: 's', callerName: 'Vignesh' });
  const sent = JSON.stringify(calls[0].body);
  assert.ok(sent.includes(DISCLOSURE), 'the disclosure line is missing from the prompt');
  assert.ok(sent.includes('Vignesh'), 'the caller name is missing from the prompt');
});

test('the prompt tells the agent to consult rather than commit', () => {
  const prompt = callPrompt({ objective: 'a table for three at seven', callerName: 'Vignesh' });
  assert.ok(prompt.includes(DISCLOSURE));
  assert.match(prompt, /ask_my_boss/);
  assert.match(prompt, /never agree|do not agree|without checking/i);
  assert.match(prompt, /a table for three at seven/);
});

test('the consult tool is wired to our webhook and speaks while it waits', async () => {
  // Silence is what makes a held human hang up.
  const { p, calls } = phone();
  await p.dial({ number: '+1', objective: 'x', webhook: 'https://tunnel/hook?k=abc', secret: 's3cret' });
  const tool = JSON.stringify(calls[0].body).includes('ask_my_boss');
  assert.ok(tool, 'the ask_my_boss tool was not sent');
  const body = calls[0].body;
  const fn = findTool(body);
  assert.equal(fn.url, 'https://tunnel/hook?k=abc');
  assert.equal(fn.speak_during_execution, true);
  assert.equal(fn.timeout_ms, TOOL_TIMEOUT_MS);
  assert.equal(body.metadata.secret, 's3cret');
});

test('a hold longer than the provider will wait is refused before dialing', async () => {
  // The invariant: if the provider gives up first, the agent improvises an
  // answer nobody sanctioned. Better to refuse than to find out on a call.
  const { p, calls } = phone({ holdMs: TOOL_TIMEOUT_MS + 1 });
  await assert.rejects(
    () => p.dial({ number: '+1', objective: 'x', webhook: 'https://x/y', secret: 's' }),
    /hold/i,
  );
  assert.equal(calls.length, 0, 'it dialed anyway');
});

test('a provider error is an error, not a silent failure', async () => {
  const { p } = phone({ status: 401, reply: { message: 'bad key' } });
  await assert.rejects(
    () => p.dial({ number: '+1', objective: 'x', webhook: 'https://x/y', secret: 's' }),
    /401|bad key/,
  );
});

test('hanging up asks the provider to end the call', async () => {
  const { p, calls } = phone();
  await p.hangup('call_1');
  assert.match(calls[0].url, /call_1/);
});

test('hanging up a call the provider has already dropped is not an error', async () => {
  // It races: the far end hangs up as we decide to. Both mean the same thing.
  const { p } = phone({ status: 404, reply: { message: 'not found' } });
  await p.hangup('call_1');
});

/** Digs the custom function out of whatever shape the agent config takes. */
function findTool(body) {
  const seen = JSON.stringify(body);
  assert.ok(seen.includes('ask_my_boss'));
  const tools = body.agent?.response_engine?.tools || body.tools || [];
  const found = tools.find((t) => t.name === 'ask_my_boss');
  assert.ok(found, 'ask_my_boss is not in the tools array');
  return found;
}
