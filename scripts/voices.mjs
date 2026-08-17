#!/usr/bin/env node
// Lists the English voices installed on this Mac, best quality first.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/voiceio');
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const RANK = { premium: 0, enhanced: 1, default: 2 };

child.stdin.write('{"cmd":"voices"}\n');

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type !== 'voices') return;

  const voices = event.voices.sort(
    (a, b) => RANK[a.quality] - RANK[b.quality] || a.name.localeCompare(b.name),
  );
  for (const voice of voices) {
    console.log(`${voice.quality.padEnd(9)} ${voice.name.padEnd(12)} ${voice.language}`);
  }

  const best = voices[0]?.quality;
  if (best === 'default') {
    console.log('\nOnly default-quality voices are installed — these sound robotic.');
    console.log('Install better ones: System Settings › Accessibility › Spoken Content ›');
    console.log('System Voice › Manage Voices, then download an Enhanced or Premium English voice.');
    console.log('Then set it in config.json, e.g. { "voice": "Ava" }');
  }
  child.kill();
  process.exit(0);
});

setTimeout(() => {
  console.error('timed out waiting for voiceio — run ./build.sh first');
  child.kill();
  process.exit(1);
}, 10000);
