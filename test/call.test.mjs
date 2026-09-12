// test/call.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Call, STATE, CALL_BACK_INSTRUCTION } from '../src/call.mjs';

function dialed(options = {}) {
  const call = new Call({ objective: 'a table for three at seven', number: '+15107096913', ...options });
  call.dial(1000);
  call.connected(2000);
  return call;
}

test('a fresh call has not gone anywhere', () => {
  const call = new Call({ objective: 'x', number: '+1' });
  assert.equal(call.state, STATE.IDLE);
  assert.equal(call.live, false);
});

test('dialing then connecting reaches the conversation', () => {
  const call = new Call({ objective: 'x', number: '+1' });
  assert.deepEqual(call.dial(1000), [{ type: 'state', state: STATE.DIALING }]);
  assert.equal(call.live, true);
  assert.deepEqual(call.connected(2000), [{ type: 'state', state: STATE.TALKING }]);
});

test('dialing twice is refused rather than starting a second call', () => {
  const call = dialed();
  assert.throws(() => call.dial(3000), /already/i);
});

test('a consult asks you out loud and holds the line', () => {
  const call = dialed();
  const effects = call.consult({ id: 't1', question: 'They offer 8pm. Accept?' }, 3000);
  assert.equal(call.state, STATE.CONSULTING);
  assert.deepEqual(effects, [
    { type: 'state', state: STATE.CONSULTING },
    { type: 'ask', id: 't1', question: 'They offer 8pm. Accept?' },
  ]);
  // index.mjs arms the timer; the machine only says when it should fire.
  assert.equal(call.holdDeadline, 3000 + 20000);
});

test('your answer resolves the pending tool and the call carries on', () => {
  const call = dialed();
  call.consult({ id: 't1', question: 'They offer 8pm. Accept?' }, 3000);
  const effects = call.answer('yes, book it', 5000);
  assert.deepEqual(effects, [
    { type: 'resolve', id: 't1', answer: 'yes, book it' },
    { type: 'state', state: STATE.TALKING },
  ]);
  assert.equal(call.state, STATE.TALKING);
  assert.equal(call.holdDeadline, null);
});

test('an answer when nothing was asked is ignored', () => {
  // Otherwise anything you happened to say during a call would be posted to the
  // far end as a decision.
  const call = dialed();
  assert.deepEqual(call.answer('what time is it', 3000), []);
  assert.equal(call.state, STATE.TALKING);
});

test('a hold that runs out promises a call back instead of stranding them', () => {
  const call = dialed();
  call.consult({ id: 't1', question: 'They offer 8pm. Accept?' }, 3000);
  const effects = call.expireHold(23000);
  assert.deepEqual(effects, [
    { type: 'resolve', id: 't1', answer: CALL_BACK_INSTRUCTION },
    { type: 'state', state: STATE.WRAPPING },
    { type: 'say', text: 'I left it open — I said we would call back to confirm.' },
  ]);
  // The point of the whole exercise survives, so a second call can finish it.
  assert.equal(call.objective, 'a table for three at seven');
  assert.equal(call.unfinished, true);
});

test('a hold that has already been answered cannot expire underneath it', () => {
  const call = dialed();
  call.consult({ id: 't1', question: 'q' }, 3000);
  call.answer('yes', 5000);
  assert.deepEqual(call.expireHold(23000), []);
  assert.equal(call.state, STATE.TALKING);
});

test('the far end hanging up mid-consult ends the call honestly', () => {
  const call = dialed();
  call.consult({ id: 't1', question: 'q' }, 3000);
  const effects = call.remoteEnd('hangup', 6000);
  assert.equal(call.state, STATE.ENDED);
  assert.equal(call.unfinished, true);
  assert.deepEqual(effects, [
    { type: 'state', state: STATE.ENDED },
    { type: 'report', outcome: 'hangup', unfinished: true, transcript: [] },
  ]);
});

test('a call that met its objective reports as finished', () => {
  const call = dialed();
  call.settled('the 8pm table is booked', 6000);
  const effects = call.remoteEnd('completed', 7000);
  assert.equal(call.unfinished, false);
  assert.deepEqual(effects.at(-1), {
    type: 'report',
    outcome: 'the 8pm table is booked',
    unfinished: false,
    transcript: [],
  });
});

test('what was said is kept, in order, for the report', () => {
  const call = dialed();
  call.heard('them', 'seven is fully booked');
  call.heard('us', 'can you do eight');
  assert.deepEqual(call.transcript, [
    { who: 'them', text: 'seven is fully booked' },
    { who: 'us', text: 'can you do eight' },
  ]);
});

test('nobody answering is a failure, not an ending', () => {
  const call = new Call({ objective: 'x', number: '+1' });
  call.dial(1000);
  const effects = call.failed('no answer', 30000);
  assert.equal(call.state, STATE.FAILED);
  assert.equal(call.live, false);
  assert.deepEqual(effects, [
    { type: 'state', state: STATE.FAILED },
    { type: 'report', outcome: 'no answer', unfinished: true, transcript: [] },
  ]);
});

test('a call that overruns its cap is cut', () => {
  const call = dialed({ maxSeconds: 60 });
  assert.equal(call.overrun(2000 + 59_000), false);
  assert.equal(call.overrun(2000 + 61_000), true);
});

test('an ended call is not live and accepts nothing further', () => {
  const call = dialed();
  call.remoteEnd('completed', 5000);
  assert.equal(call.live, false);
  assert.deepEqual(call.consult({ id: 't2', question: 'q' }, 6000), []);
  assert.deepEqual(call.remoteEnd('hangup', 7000), []);
});
