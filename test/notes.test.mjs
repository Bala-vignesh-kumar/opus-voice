import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Notes, SUMMARY_PROMPT, splitSummary, slug } from '../src/notes.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opus-notes-'));

test('the summary marker lines are stripped from the written notes', () => {
  const reply = [
    'TITLE: redis lock for pending records',
    '',
    'The job claims each row in Redis before sending.',
    '',
    'SPOKEN: Notes saved. It was about the Redis lock.',
  ].join('\n');

  const { title, written, spoken } = splitSummary(reply);
  assert.equal(title, 'redis lock for pending records');
  assert.equal(written, 'The job claims each row in Redis before sending.');
  assert.equal(spoken, 'Notes saved. It was about the Redis lock.');
  assert.ok(!written.includes('TITLE:'));
  assert.ok(!written.includes('SPOKEN:'));
});

test('a reply with no markers still yields usable notes', () => {
  const { title, written, spoken } = splitSummary('Just the notes, nothing else.');
  assert.equal(title, '');
  assert.equal(written, 'Just the notes, nothing else.');
  assert.equal(spoken, '');
});

test('titles become tame filenames', () => {
  assert.equal(slug('Redis lock for pending records'), 'redis-lock-for-pending-records');
  assert.equal(slug('  Fix #421: the *catch* block!  '), 'fix-421-the-catch-block');
  assert.equal(slug("Rahul's plan"), 'rahuls-plan');
  // A title long enough to be a paragraph must not become a filename that long.
  assert.ok(slug('a'.repeat(200)).length <= 60);
  assert.equal(slug('!!!'), '');
});

test('notes are saved under a date folder, titled, with no transcript', () => {
  const dir = tmp();
  const notes = new Notes();
  notes.start();
  notes.add('the catch block marks it processed even when it threw');
  notes.add('we should give the redis key a ttl');

  const file = notes.save(dir, 'The catch block swallows failures.', 'Redis lock for pending records');
  const body = fs.readFileSync(file, 'utf8');

  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal(path.basename(path.dirname(file)), day, 'the folder is the date');
  assert.equal(path.basename(file), 'redis-lock-for-pending-records.md');

  assert.match(body, /^# Redis lock for pending records/);
  assert.ok(body.includes('The catch block swallows failures.'));
  // The whole point of the change: raw speech does not go in the file.
  assert.ok(!body.includes('## Transcript'));
  assert.ok(!body.includes('the catch block marks it processed even when it threw'));
});

test('an untitled discussion still gets a file rather than being lost', () => {
  const dir = tmp();
  const notes = new Notes();
  notes.start();
  notes.add('something');
  const file = notes.save(dir, 'Summary.', '');
  assert.match(path.basename(file), /^discussion-\d{4}\.md$/);
});

test('two discussions with the same title do not overwrite each other', () => {
  const dir = tmp();
  const first = new Notes();
  first.start();
  first.add('one');
  const a = first.save(dir, 'First.', 'Standup');

  const second = new Notes();
  second.start();
  second.add('two');
  const b = second.save(dir, 'Second.', 'Standup');

  assert.notEqual(a, b);
  assert.equal(path.basename(b), 'standup-2.md');
  assert.ok(fs.readFileSync(a, 'utf8').includes('First.'));
  assert.ok(fs.readFileSync(b, 'utf8').includes('Second.'));
});

test('the prompt asks for a title, for lookups, and for no transcript', () => {
  // These three instructions are the feature; a prompt that loses one of them
  // silently changes what lands on disk.
  assert.match(SUMMARY_PROMPT, /TITLE:/);
  assert.match(SUMMARY_PROMPT, /SPOKEN:/);
  assert.match(SUMMARY_PROMPT, /gh issue view/);
  assert.match(SUMMARY_PROMPT, /## References/);
  assert.match(SUMMARY_PROMPT, /Do not reproduce the transcript/);
});
