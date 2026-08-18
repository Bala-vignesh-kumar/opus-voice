import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Todos } from '../src/todos.mjs';
import { parseTodo, toNumber } from '../src/todo-commands.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opus-todos-'));

// ------------------------------------------------------------------ the store

test('items survive being reloaded from disk', () => {
  const dir = tmp();
  const first = new Todos(dir);
  first.add('ship the redis fix');
  first.add('write the migration');

  const second = new Todos(dir);
  assert.equal(second.open.length, 2);
  assert.equal(second.open[0].text, 'ship the redis fix');
});

test('ordinals count open items, so a spoken number stays meaningful', () => {
  const dir = tmp();
  const todos = new Todos(dir);
  const a = todos.add('one');
  todos.add('two');
  todos.add('three');

  assert.equal(todos.byOrdinal(2).text, 'two');
  todos.complete(a.id);
  // With the first one done, "todo one" now means what was second.
  assert.equal(todos.byOrdinal(1).text, 'two');
  assert.equal(todos.byOrdinal(2).text, 'three');
  assert.equal(todos.byOrdinal(9), null);
  assert.equal(todos.byOrdinal(0), null);
});

test('completing and removing do what they say', () => {
  const dir = tmp();
  const todos = new Todos(dir);
  const a = todos.add('a');
  const b = todos.add('b');

  assert.equal(todos.complete(a.id).done, true);
  assert.equal(todos.complete(a.id), null, 'completing twice is not an action');
  assert.equal(todos.open.length, 1);

  assert.equal(todos.remove(b.id).text, 'b');
  assert.equal(todos.open.length, 0);
  assert.equal(todos.items.length, 1, 'a completed item is kept as a record');
});

test('an empty or whitespace to-do is refused', () => {
  const todos = new Todos(tmp());
  assert.equal(todos.add('   '), null);
  assert.equal(todos.items.length, 0);
});

test('a corrupt file starts clean instead of taking the app down', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'todos.json'), '{ this is not json');
  const todos = new Todos(dir);
  assert.deepEqual(todos.items, []);
  assert.equal(todos.add('still works').id, 1);
});

test('the spoken list is numbered and capped', () => {
  const todos = new Todos(tmp());
  assert.match(todos.spoken(), /empty/i);

  todos.add('alpha');
  assert.match(todos.spoken(), /one to-do/);

  for (const t of ['b', 'c', 'd', 'e', 'f', 'g']) todos.add(t);
  const spoken = todos.spoken(5);
  assert.match(spoken, /7 to-dos/);
  assert.match(spoken, /1\. alpha/);
  assert.match(spoken, /And 2 more\./);
  assert.ok(!spoken.includes('6. '), 'the tail is summarized, not read out');
});

// ------------------------------------------------------------ the spoken form

test('spoken numbers become real ones', () => {
  assert.equal(toNumber('two'), 2);
  assert.equal(toNumber('2'), 2);
  assert.equal(toNumber('TWELVE'), 12);
  // "to" and "too" are what dictation gives back for "two".
  assert.equal(toNumber('to'), 2);
  assert.equal(toNumber('banana'), null);
  assert.equal(toNumber(''), null);
});

test('adding is recognised in the ways people actually say it', () => {
  for (const said of [
    'add a todo to ship the redis fix',
    'add todo ship the redis fix',
    'create a task to ship the redis fix',
    'new todo ship the redis fix',
    'remind me to ship the redis fix',
    'add a to-do that ship the redis fix',
  ]) {
    const parsed = parseTodo(said);
    assert.equal(parsed?.action, 'add', `not parsed: ${said}`);
    assert.match(parsed.text, /ship the redis fix/, `wrong text from: ${said}`);
  }
});

test('completing, removing and listing are recognised', () => {
  assert.deepEqual(parseTodo('todo two is done'), { action: 'done', index: 2, text: '' });
  assert.deepEqual(parseTodo('mark task 3 as complete'), { action: 'done', index: 3, text: '' });
  assert.deepEqual(parseTodo('finish todo one'), { action: 'done', index: 1, text: '' });
  assert.deepEqual(parseTodo('delete todo four'), { action: 'remove', index: 4, text: '' });

  for (const said of ['what are my todos', 'list my todos', 'read my to-do list', "what's on my list"]) {
    assert.equal(parseTodo(said)?.action, 'list', `not parsed: ${said}`);
  }
});

test('converting to a github issue is recognised', () => {
  for (const said of [
    'make todo two a github issue',
    'turn todo 2 into an issue',
    'file task two as an issue',
    'raise an issue for todo two',
  ]) {
    const parsed = parseTodo(said);
    assert.equal(parsed?.action, 'issue', `not parsed: ${said}`);
    assert.equal(parsed.index, 2, `wrong item from: ${said}`);
  }
});

test('ordinary conversation is not a to-do command', () => {
  // The cost of a false positive here is a swallowed question, so the parser
  // has to stay quiet unless the list is named.
  for (const said of [
    'delete the feature branch',
    'what are we shipping this week',
    'can you finish the migration',
    'mark the release as done',
    'add a column to the table',
    'why is my build slow',
    'list the files in src',
  ]) {
    assert.equal(parseTodo(said), null, `false positive on: ${said}`);
  }
});

test('an item that names no number is not acted on', () => {
  // Better to hand "mark todo banana done" to Claude than to guess at an item.
  assert.equal(parseTodo('mark todo banana done'), null);
  assert.equal(parseTodo('delete todo whatever'), null);
});
