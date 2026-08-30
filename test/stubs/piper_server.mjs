#!/usr/bin/env node
// Stand-in for scripts/piper_server.py. STUB_PIPER_MODE=die exits at once, so a
// test can write to a child that is already gone.
if (process.env.STUB_PIPER_MODE === 'die') process.exit(0);
process.stdout.write(`${JSON.stringify({ type: 'ready', sampleRate: 22050 })}\n`);
process.stdin.resume();
