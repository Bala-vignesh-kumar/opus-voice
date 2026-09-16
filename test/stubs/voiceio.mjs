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

// Playback, modelled closely enough to reproduce two real failures.
//
// STUB_VOICE_SPEECH_MS is how long a line takes to play; lines queue behind
// one another as they do in the daemon, which is what let "going to sleep."
// start after the microphone had already been handed back. STUB_VOICE_MUTE=1
// wedges the player the way a fresh session's did on 16 Sep 2026: a line
// starts, no output level is ever reported, and it never ends — until a
// standby cycle resets it, which is what fixed the real one.
const SPEECH_MS = Number(process.env.STUB_VOICE_SPEECH_MS || 0);
let muted = process.env.STUB_VOICE_MUTE === '1';
// A line has stalled on the wedged player. The real one only came right after
// a standby cycle *following* the stall — the first wake from asleep is a cycle
// too, and it did not help, so a cycle before any stall must not either.
let wedged = false;
let speaking = false;
const queue = [];

function record(text) {
  if (!process.env.STUB_VOICE_SPOKEN) return;
  const mark = standby ? '(into standby) ' : muted ? '(silent) ' : '';
  fs.appendFileSync(process.env.STUB_VOICE_SPOKEN, `${mark}${text}\n`);
}

function playNext() {
  if (speaking || queue.length === 0) return;
  const text = queue.shift();
  speaking = true;
  record(text);
  emit({ type: 'speech_start', text });
  if (muted) wedged = true;
  if (standby || muted) return;          // starts, and never ends
  emit({ type: 'level', source: 'out', rms: 0.2 });
  const finish = () => {
    if (!speaking) return;
    speaking = false;
    emit({ type: 'speech_end', interrupted: false });
    playNext();
  };
  if (SPEECH_MS > 0) setTimeout(finish, SPEECH_MS);
  else finish();
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.cmd === 'speak') {
    queue.push(command.text);
    playNext();
  }
  if (command.cmd === 'stop') {
    queue.length = 0;
    if (speaking) {
      speaking = false;
      emit({ type: 'speech_end', interrupted: true });
    }
  }
  if (command.cmd === 'standby') {
    standby = Boolean(command.on);
    if (!standby && wedged) muted = false;   // the cycle is what un-wedges it
    emit({ type: 'standby', on: standby });
  }
  if (command.cmd === 'pcm_start') emit({ type: 'speech_start', text: command.text });
  if (command.cmd === 'pcm_end') emit({ type: 'speech_end', interrupted: false });
  // Lets the test inject a recognized utterance as though it had been spoken.
  if (command.cmd === 'test_final') emit({ type: 'final', text: command.text });
});
