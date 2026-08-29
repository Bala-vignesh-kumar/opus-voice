// test/stubs/whisper_server.mjs
// Stands in for scripts/whisper_server.py. Behaviour is chosen by env var so
// one stub covers every path the supervisor has to survive.
import readline from 'node:readline';

const mode = process.env.STUB_WHISPER_MODE || 'ok';
if (mode === 'crash') process.exit(3);

process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);

// 'echo' answers each request with text derived from its own audio, and answers
// the second request before the first. Identical answers could not tell a
// correctly routed reply from a crossed one, so the concurrency test needs
// replies that differ and arrive out of order.
const waiting = [];
function echo(message) {
  const pcm = Buffer.from(String(message.pcm), 'base64');
  const first = pcm.length >= 4 ? pcm.readFloatLE(0) : 0;
  waiting.push({ id: message.id, text: `heard ${Math.round(first)}` });
  if (waiting.length < 2) return;
  const batch = waiting.splice(0).reverse();
  for (const reply of batch) {
    process.stdout.write(`${JSON.stringify({ type: 'text', ...reply })}\n`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.cmd === 'quit') process.exit(0);
  if (mode === 'hang') return;                       // never answers
  if (mode === 'error') {
    process.stdout.write(`${JSON.stringify({ type: 'error', id: message.id, message: 'model exploded' })}\n`);
    return;
  }
  if (mode === 'empty') {
    process.stdout.write(`${JSON.stringify({ type: 'text', id: message.id, text: '' })}\n`);
    return;
  }
  if (mode === 'echo') { echo(message); return; }
  process.stdout.write(`${JSON.stringify({ type: 'text', id: message.id, text: 'what files are in this project' })}\n`);
});
