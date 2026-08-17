#!/usr/bin/env node
// Diagnostic: is the mic delivering audio, and is recognition producing words?
//
// Separates the two failure modes. A moving bar with no transcript means audio
// is fine and recognition is broken; a flat bar means the mic itself is wrong.

import { VoiceIO } from '../src/voice.mjs';
import { loadConfig } from '../src/config.mjs';

const SECONDS = 20;
const config = loadConfig();
const voice = new VoiceIO({ locale: config.locale });

let peak = 0;
let frames = 0;
let heard = 0;
const errors = new Map();

voice.on('ready', (event) => {
  console.log(`\nrecognition: ${event.onDevice ? 'on-device' : 'server-based'}   listening for: ${event.locale}`);
  console.log(`\nSay something for ${SECONDS} seconds. Watch the bar move.\n`);
});

voice.on('level', (rms) => {
  frames += 1;
  peak = Math.max(peak, rms);
  // rms is linear and tiny; log scale makes speech visible next to room tone.
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  const filled = Math.max(0, Math.min(40, Math.round((db + 60) / 60 * 40)));
  const bar = '█'.repeat(filled).padEnd(40, '·');
  process.stdout.write(`\r  mic [${bar}] ${db.toFixed(0).padStart(4)} dB `);
});

voice.on('partial', (text) => {
  heard += 1;
  process.stdout.write(`\r\x1b[2K  heard: ${text}\n`);
});

voice.on('recog-error', (event) => {
  errors.set(`${event.domain} ${event.code}: ${event.message}`, (errors.get(event.message) || 0) + 1);
});

voice.on('warn', (message) => process.stdout.write(`\r\x1b[2K  ! ${message}\n`));
voice.on('error', (err) => process.stdout.write(`\r\x1b[2K  ✗ ${err.message}\n`));

setTimeout(() => {
  process.stdout.write('\r\x1b[2K');
  console.log('\n─── result ───');
  console.log(`audio frames:    ${frames}`);
  console.log(`peak level:      ${(20 * Math.log10(Math.max(peak, 1e-6))).toFixed(1)} dB`);
  console.log(`transcripts:     ${heard}`);

  if (frames === 0) {
    console.log('\nNo audio at all. The tap never fired — check mic permission for your terminal.');
  } else if (peak < 0.005) {
    console.log('\nAudio is arriving but essentially silent. Wrong input device, or the mic is muted.');
    console.log('Check System Settings › Sound › Input and confirm the level meter moves when you talk.');
  } else if (heard === 0) {
    console.log('\nThe mic works, but recognition produced nothing. This is almost always Dictation:');
    console.log('  System Settings › Keyboard › Dictation → turn ON, and let the language download finish.');
    console.log('That download is what supplies the on-device speech model.');
  } else {
    console.log('\nWorking. Both mic and recognition are fine.');
  }

  if (errors.size) {
    console.log('\nrecognition errors:');
    for (const [message, count] of errors) console.log(`  ${count}×  ${message}`);
  }

  voice.close();
  process.exit(0);
}, SECONDS * 1000);
