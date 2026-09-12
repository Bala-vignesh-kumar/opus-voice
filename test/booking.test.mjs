// test/booking.test.mjs — the whole path, without a telephone.
//
// The driver, the webhook route, the state machine and the hold, wired together
// the way index.mjs wires them, against a provider stub scripted as the
// restaurant in the demo: asked for seven, it offers eight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UiServer } from '../src/server.mjs';
import { Conversation } from '../src/bus.mjs';
import { Phone } from '../src/phone.mjs';
import { Call, STATE, CALL_BACK_INSTRUCTION } from '../src/call.mjs';
import { startProvider } from './stubs/retell.mjs';

let nextPort = 18700;

/**
 * Everything index.mjs does to place a call, minus the speaking.
 *
 * `decide` stands in for you: it is handed the question the call asked and
 * returns what Falcon should answer, or null to let the hold run out.
 */
async function place({ decide, holdMs = 20_000 }) {
  const provider = await startProvider();
  const server = new UiServer(new Conversation(), () => {}, {
    port: nextPort++,
    sessionFile: null,
  });
  await server.listen();

  const spoken = [];
  const phone = new Phone({
    apiKey: 'k_test',
    fromNumber: '+15550000000',
    baseUrl: provider.url,
    holdMs,
  });
  const call = new Call({ objective: 'a table for three at seven', number: '+15107096913', holdMs });

  const effects = [];
  let holdTimer = null;
  let resolveConsult = null;
  const apply = (list) => {
    for (const effect of list) {
      effects.push(effect);
      if (effect.type === 'ask') {
        spoken.push(effect.question);
        holdTimer = setTimeout(() => apply(call.expireHold(Date.now())), holdMs);
        const answer = decide(effect.question);
        if (answer !== null) apply(call.answer(answer, Date.now()));
      }
      if (effect.type === 'resolve') {
        clearTimeout(holdTimer);
        resolveConsult?.(effect.answer);
        resolveConsult = null;
      }
    }
  };

  apply(call.dial(Date.now()));
  const callId = await phone.dial({
    number: call.number,
    objective: call.objective,
    callerName: 'Vignesh',
    webhook: `http://127.0.0.1:${server.port}/consult?k=${server.token}`,
    secret: 'sec',
  });
  call.id = callId;
  apply(call.connected(Date.now()));

  server.expectConsult({
    secret: 'sec',
    callId,
    handler: (question) => new Promise((resolve) => {
      resolveConsult = resolve;
      apply(call.consult({ id: callId, question }, Date.now()));
    }),
  });

  return {
    provider, server, phone, call, spoken, effects,
    finish: async () => {
      clearTimeout(holdTimer);
      server.close();
      await provider.close();
    },
  };
}

/** Waits for the stub to record an event, rather than sleeping a fixed time. */
async function until(log, event, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (log.some((e) => e.event === event)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`the provider never got as far as "${event}": ${JSON.stringify(log)}`);
}

test('the call asks you about eight o\'clock and books it when you say yes', async () => {
  const run = await place({ decide: () => 'Yes, take the eight o\'clock.' });
  try {
    await until(run.provider.log, 'told');

    // It asked you, out loud, in your own room.
    assert.deepEqual(run.spoken, ['Seven is fully booked. They can do eight. Accept?']);
    // And your decision is what went back down the phone.
    assert.equal(run.provider.answer, 'Yes, take the eight o\'clock.');
    // The line was never dropped: it is still the same call.
    assert.equal(run.call.state, STATE.TALKING);
  } finally { await run.finish(); }
});

test('the disclosure reaches the provider on the real wire', async () => {
  const run = await place({ decide: () => 'yes' });
  try {
    // Let the consult finish before tearing down, or the stub is left calling
    // a server that has gone.
    await until(run.provider.log, 'told');
    const dialed = run.provider.log.find((e) => e.event === 'dialed');
    assert.match(dialed.prompt, /AI assistant calling on behalf of/);
    assert.match(dialed.prompt, /Vignesh/);
    assert.equal(dialed.to, '+15107096913');
  } finally { await run.finish(); }
});

test('nobody is left holding when you never answer', async () => {
  // The hold runs out, the far end is told it will get a call back, and the
  // objective survives so a second call can finish the job.
  const run = await place({ decide: () => null, holdMs: 60 });
  try {
    await until(run.provider.log, 'told');
    assert.equal(run.provider.answer, CALL_BACK_INSTRUCTION);
    assert.equal(run.call.state, STATE.WRAPPING);
    assert.equal(run.call.unfinished, true);
    assert.equal(run.call.objective, 'a table for three at seven');
  } finally { await run.finish(); }
});

test('a second call while one is live is refused', async () => {
  const run = await place({ decide: () => 'yes' });
  try {
    await until(run.provider.log, 'told');
    assert.throws(() => run.call.dial(Date.now()), /already/i);
  } finally { await run.finish(); }
});

test('hanging up tells the provider, and the door closes behind it', async () => {
  const run = await place({ decide: () => 'yes' });
  try {
    await until(run.provider.log, 'told');
    await run.phone.hangup(run.call.id);
    run.server.clearConsult();
    assert.ok(run.provider.log.some((e) => e.event === 'hungup'));

    // The tunnel would be gone too; what we can check here is that the route
    // it pointed at no longer answers.
    const res = await fetch(`http://127.0.0.1:${run.server.port}/consult?k=${run.server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call_id: run.call.id, metadata: { secret: 'sec' }, args: { question: 'again?' } }),
    });
    assert.equal(res.status, 404);
  } finally { await run.finish(); }
});
