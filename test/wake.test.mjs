import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWake, parseCommand } from '../src/wake.mjs';

test('bare wake word wakes without a command', () => {
  assert.deepEqual(parseWake('Jarvis'), { wake: true, command: null, rest: '' });
  assert.deepEqual(parseWake('jarvis.'), { wake: true, command: null, rest: '' });
});

test('recognises the note and chat modes', () => {
  assert.equal(parseWake('Jarvis listen').command, 'note');
  assert.equal(parseWake('Jarvis, take notes').command, 'note');
  assert.equal(parseWake("Jarvis let's discuss").command, 'chat');
  assert.equal(parseWake('jarvis lets discuss this').command, 'chat');
});

test('recognises stop and summarize', () => {
  assert.equal(parseWake('Jarvis stop').command, 'stop');
  assert.equal(parseWake('jarvis go to sleep').command, 'stop');
  assert.equal(parseWake('Jarvis summarize').command, 'summarize');
});

test('survives the way recognition mangles the name', () => {
  for (const heard of ['Jervis listen', "Java's listen", 'Jarvis listen', 'jarvez listen', 'service listen']) {
    assert.equal(parseWake(heard).command, 'note', `failed on: ${heard}`);
  }
});

test('wake word plus a question is treated as a question', () => {
  const result = parseWake('Jarvis, why is my build slow?');
  assert.equal(result.wake, true);
  assert.equal(result.command, 'ask');
  assert.equal(result.rest, 'why is my build slow');
});

test('ignores speech with no wake word', () => {
  const result = parseWake('so anyway the deploy failed again');
  assert.equal(result.wake, false);
  assert.equal(result.command, null);
});

test('ambiguous aliases only count as the first word', () => {
  // "the service is down" must not wake it mid-conversation.
  assert.equal(parseWake('the service is down').wake, false);
  assert.equal(parseWake('java is slow today').wake, false);
});

test('does not trigger on the name mid-sentence', () => {
  // Otherwise ordinary conversation about it would keep flipping modes.
  assert.equal(parseWake('I was telling Sarah that Jarvis should stop').wake, false);
});

test('stop wins over note when both words appear', () => {
  assert.equal(parseWake('Jarvis stop taking notes').command, 'stop');
});

test('bare commands work without the name', () => {
  assert.equal(parseCommand('Go to sleep'), 'stop');
  assert.equal(parseCommand('stop'), 'stop');
  assert.equal(parseCommand("okay, that's all"), 'stop');
  assert.equal(parseCommand("let's discuss"), 'chat');
});

test('a bare command must be the whole utterance', () => {
  // Otherwise ordinary questions would trip the mode machinery.
  assert.equal(parseCommand('how do I stop the dev server'), null);
  assert.equal(parseCommand('can you take notes on this file for me'), null);
  assert.equal(parseCommand('what did we decide'), null);
});
