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

  // Dies mid-turn, the way the real CLI does when a rate limit runs out: the
  // question is accepted, nothing is answered, and the process is gone.
  if (asked.includes('make it die')) {
    process.stderr.write('5-hour limit reached\n');
    process.exit(1);
  }

  // Out of budget rather than out of session: the turn is accepted, the limit
  // goes to stderr, nothing is answered, and the process stays up to be asked
  // again. This is what an account over its monthly spend limit actually does.
  if (asked.includes('hit the limit')) {
    process.stderr.write("You've hit your monthly spend limit · your session limit resets 3:10am\n");
    // The turn still ends, or `busy` would never clear and the next question
    // would queue behind it forever rather than failing the same way.
    emit({ type: 'result', is_error: true, result: 'usage limit' });
    return;
  }

  const reply = asked.includes('Transcript:') ? SUMMARY : REPLY;
  const answer = () => {
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    emit({ type: 'result', is_error: false, result: reply });
  };

  // Answers slowly, so a test can do something else while a turn is genuinely
  // still in flight. Everything about queueing is invisible when every turn
  // finishes before the next line of the test runs.
  if (asked.includes('take your time')) setTimeout(answer, 1500);
  else answer();
});
