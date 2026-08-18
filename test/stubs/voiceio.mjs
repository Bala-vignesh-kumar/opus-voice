#!/usr/bin/env node
// Stand-in for bin/voiceio. Speaks the same newline-JSON protocol but owns no
// audio hardware, so the end-to-end test can run anywhere.
//
// Speech is acknowledged rather than synthesized: the orchestrator waits for
// speech_end before it considers a turn finished, so a stub that never sent it
// would hang the app rather than test it.
import readline from 'node:readline';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

emit({
  type: 'ready',
  voice: 'Stub',
  voiceId: 'stub',
  onDevice: true,
  locale: process.argv[process.argv.indexOf('--locale') + 1] || 'en-US',
  recognizer: 'SpeechTranscriber',
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.cmd === 'speak') {
    emit({ type: 'speech_start', text: command.text });
    emit({ type: 'speech_end', interrupted: false });
  }
  if (command.cmd === 'pcm_start') emit({ type: 'speech_start', text: command.text });
  if (command.cmd === 'pcm_end') emit({ type: 'speech_end', interrupted: false });
  // Lets the test inject a recognized utterance as though it had been spoken.
  if (command.cmd === 'test_final') emit({ type: 'final', text: command.text });
});
