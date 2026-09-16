#!/usr/bin/env node
// Stand-in for bin/voiceio. Speaks the same newline-JSON protocol but owns no
// audio hardware, so the end-to-end test can run anywhere.
//
// Speech is acknowledged rather than synthesized: the orchestrator waits for
// speech_end before it considers a turn finished, so a stub that never sent it
// would hang the app rather than test it.
import readline from 'node:readline';
import fs from 'node:fs';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

emit({
  type: 'ready',
  voice: 'Stub',
  voiceId: 'stub',
  onDevice: true,
  locale: process.argv[process.argv.indexOf('--locale') + 1] || 'en-US',
  recognizer: 'SpeechTranscriber',
});

// Test-only injection channel: a file the test appends utterances to, which
// this emits as `final` events. Speech has to enter the app through the daemon
// the way a microphone would — sending it on the app's stdin would make it
// typed input, which follows different rules.
const INJECT = process.env.STUB_VOICE_INJECT;
if (INJECT) {
  let consumed = 0;
  setInterval(() => {
    let lines;
    try {
      lines = fs.readFileSync(INJECT, 'utf8').split('\n').filter(Boolean);
    } catch {
      return;
    }
    for (const text of lines.slice(consumed)) {
      // Real speech carries its audio: voiceio emits `utterance` just before
      // the `final` it belongs to, so the orchestrator can hand it to the
      // second recognizer without holding the turn open.
      emit({
        type: 'utterance',
        pcm: Buffer.from(new Float32Array([0.5, -0.5, 0.4]).buffer).toString('base64'),
        sampleRate: 16000,
        peak: 0.5,
      });
      emit({ type: 'final', text });
    }
    consumed = lines.length;
  }, 40).unref?.();
}

// Whether the microphone has been handed back. The real daemon stops its audio
// engine in standby, so anything sent to it then starts and never ends — that is
// how a "notes saved" announcement once left the window on "speaking" forever.
let standby = false;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.cmd === 'speak') {
    // Recorded so tests can assert on what was said aloud, which is otherwise
    // invisible: the terminal view prints a spinner, not the words. A line sent
    // into standby is recorded as such: nobody heard it.
    if (process.env.STUB_VOICE_SPOKEN) {
      const text = standby ? `(into standby) ${command.text}` : command.text;
      fs.appendFileSync(process.env.STUB_VOICE_SPOKEN, `${text}\n`);
    }
    emit({ type: 'speech_start', text: command.text });
    if (!standby) emit({ type: 'speech_end', interrupted: false });
  }
  if (command.cmd === 'standby') {
    standby = Boolean(command.on);
    emit({ type: 'standby', on: standby });
  }
  if (command.cmd === 'pcm_start') emit({ type: 'speech_start', text: command.text });
  if (command.cmd === 'pcm_end') emit({ type: 'speech_end', interrupted: false });
  // Lets the test inject a recognized utterance as though it had been spoken.
  if (command.cmd === 'test_final') emit({ type: 'final', text: command.text });
});
