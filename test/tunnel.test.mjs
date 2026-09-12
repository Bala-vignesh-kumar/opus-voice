// test/tunnel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tunnel } from '../src/tunnel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = path.join(ROOT, 'test', 'stubs', 'cloudflared.mjs');

function tunnel(mode = 'ok', options = {}) {
  return new Tunnel({
    port: 4477,
    bin: process.execPath,
    args: [STUB],
    env: { STUB_TUNNEL_MODE: mode },
    timeoutMs: 2000,
    ...options,
  });
}

test('opening yields the public URL cloudflared printed', async () => {
  const t = tunnel();
  try {
    assert.equal(await t.open(), 'https://stub-tunnel.trycloudflare.com');
    assert.equal(t.url, 'https://stub-tunnel.trycloudflare.com');
  } finally { await t.close(); }
});

test('a tunnel that never announces a URL gives up rather than hanging', async () => {
  const t = tunnel('silent', { timeoutMs: 200 });
  try {
    await assert.rejects(() => t.open(), /no url|timed out/i);
  } finally { await t.close(); }
});

test('a tunnel that dies on startup is an error, not a hang', async () => {
  const t = tunnel('die');
  try {
    await assert.rejects(() => t.open(), /exit|died/i);
  } finally { await t.close(); }
});

test('closing twice is safe', async () => {
  // shutdown() calls this on a path where anything thrown strands the app, so
  // it has to survive being called after the child is already gone.
  const t = tunnel();
  await t.open();
  await t.close();
  await t.close();
  assert.equal(t.url, '');
});

test('closing one that never opened is safe', async () => {
  const t = tunnel();
  await t.close();
});

test('a tunnel dying mid-call is announced, not thrown at the process', async () => {
  // An unlistened child pipe throws at the process, and this app has died that
  // way twice. A dead tunnel must fail the call, not the app.
  const t = tunnel();
  await t.open();
  const died = new Promise((resolve) => t.once('died', resolve));
  t.child.kill('SIGKILL');
  await died;
  assert.equal(t.url, '');
  await t.close();
});
