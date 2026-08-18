#!/usr/bin/env node
// Stand-in for the claude CLI in --output-format stream-json mode. Answers
// every turn with a fixed sentence so the test can assert on routing —
// whether a turn was sent at all — rather than on model output.
import readline from 'node:readline';
import fs from 'node:fs';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const REPLY = 'This is the stub answer.';

// A summary request has to come back in the shape the note writer parses, or the
// test would prove only that a turn happened, not that notes land on disk right.
const SUMMARY = [
  'TITLE: redis lock for pending records',
  '',
  '## References',
  '',
  '- #421 — Catch block marks failures as processed (open)',
  '',
  'The job claims each row in Redis before sending.',
  '',
  'ACTION: add a TTL to the redis lock keys',
  'ACTION: rework the catch block so a failure is marked failed',
  '',
  'SPOKEN: Notes saved. It was about the Redis lock.',
].join('\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;

  const asked = message.message?.content?.[0]?.text ?? '';
  // Logged to a file rather than stderr so the test can prove exactly which
  // turns reached Claude without depending on how the app surfaces stderr.
  // JSON per line because a summary prompt is many lines long.
  if (process.env.STUB_CLAUDE_LOG) {
    fs.appendFileSync(process.env.STUB_CLAUDE_LOG, `${JSON.stringify(asked)}\n`);
  }

  const reply = asked.includes('Transcript:') ? SUMMARY : REPLY;
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'result', is_error: false, result: reply });
});
