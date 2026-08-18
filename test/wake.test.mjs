import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWake, parseCommand } from '../src/wake.mjs';

test('bare wake word wakes without a command', () => {
  assert.deepEqual(parseWake('Falcon'), { wake: true, command: null, rest: '' });
  assert.deepEqual(parseWake('falcon.'), { wake: true, command: null, rest: '' });
});

test('recognises the note and chat modes', () => {
  assert.equal(parseWake('Falcon listen').command, 'note');
  assert.equal(parseWake('Falcon, take notes').command, 'note');
  assert.equal(parseWake("Falcon let's discuss").command, 'chat');
  assert.equal(parseWake('falcon lets discuss this').command, 'chat');
});

test('recognises stop and summarize', () => {
  assert.equal(parseWake('Falcon stop').command, 'stop');
  assert.equal(parseWake('falcon go to sleep').command, 'stop');
  assert.equal(parseWake('Falcon summarize').command, 'summarize');
});

test('survives the way recognition mangles the name', () => {
  for (const heard of ['Falcon listen', 'Falcons listen', "Falcon's listen", 'Falken listen', 'Vulcan listen']) {
    assert.equal(parseWake(heard).command, 'note', `failed on: ${heard}`);
  }
});

test('does not wake on ordinary words inside the fuzz radius', () => {
  // These all sit within two edits of the name but are never a way of
  // addressing it, so the blocklist has to beat the edit-distance match.
  for (const heard of ['fallen listen', 'salmon listen', 'bacon listen', 'salon listen', 'talon listen', 'felon listen']) {
    assert.equal(parseWake(heard).wake, false, `false wake on: ${heard}`);
  }
});

test('wake word plus a question is treated as a question', () => {
  const result = parseWake('Falcon, why is my build slow?');
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
  // An alias buried mid-sentence must not wake it.
  assert.equal(parseWake('the vulcan cluster is down').wake, false);
  assert.equal(parseWake('we had salmon for lunch').wake, false);
});

test('does not trigger on the name mid-sentence', () => {
  // Otherwise ordinary conversation about it would keep flipping modes.
  assert.equal(parseWake('I was telling Sarah that Falcon should stop').wake, false);
});

test('stop wins over note when both words appear', () => {
  assert.equal(parseWake('Falcon stop taking notes').command, 'stop');
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
