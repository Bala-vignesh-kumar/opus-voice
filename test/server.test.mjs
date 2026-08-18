import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../src/bus.mjs';
import { UiServer } from '../src/server.mjs';

// Each test gets its own port. Reusing one would let fetch's connection pool
// hold a socket to a server that has since closed, and the reconnect to a new
// server on that port comes back as ECONNRESET.
let nextPort = 18400;

/** Starts a server on an unused port and hands back everything to poke at it. */
async function start() {
  const conversation = new Conversation();
  const commands = [];
  // A high port keeps a test run from colliding with a real session.
  const server = new UiServer(conversation, (c) => commands.push(c), { port: nextPort++ });
  const url = await server.listen();
  const base = `http://127.0.0.1:${server.port}`;
  return { conversation, commands, server, url, base, token: server.token };
}

test('the window is served and the token is in its url', async () => {
  const { server, base, url, token } = await start();
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /opus voice/);
    assert.ok(url.includes(token));
  } finally {
    server.close();
  }
});

test('commands without the token are refused', async () => {
  // This process can edit files and run shell commands. Any page you have open
  // could POST to loopback, so the token is the only thing standing in the way.
  const { server, base, commands } = await start();
  try {
    const denied = await fetch(`${base}/command`, {
      method: 'POST',
      body: JSON.stringify({ cmd: 'say', text: 'delete everything' }),
    });
    assert.equal(denied.status, 403);
    assert.equal(commands.length, 0);

    const wrong = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'x-opus-token': 'not-the-token' },
      body: JSON.stringify({ cmd: 'say', text: 'nope' }),
    });
    assert.equal(wrong.status, 403);
    assert.equal(commands.length, 0);
  } finally {
    server.close();
  }
});

test('commands with the token arrive intact', async () => {
  const { server, base, commands, token } = await start();
  try {
    const response = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'x-opus-token': token },
      body: JSON.stringify({ cmd: 'say', text: 'why is the build slow' }),
    });
    assert.equal(response.status, 204);
    assert.deepEqual(commands, [{ cmd: 'say', text: 'why is the build slow' }]);
  } finally {
    server.close();
  }
});

test('the event stream opens with a snapshot and then follows changes', async () => {
  const { server, base, token, conversation } = await start();
  const controller = new AbortController();
  try {
    conversation.you('what happened');

    const response = await fetch(`${base}/events?k=${token}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /event-stream/);

    const reader = response.body.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);

    // A window that opens mid-conversation must see what was already said.
    const first = JSON.parse(read__frame(await read()));
    assert.equal(first.type, 'snapshot');
    assert.equal(first.entries[0].text, 'what happened');

    conversation.setMode('chat');
    const second = JSON.parse(read__frame(await read()));
    assert.deepEqual(second, { type: 'mode', mode: 'chat' });
  } finally {
    controller.abort();
    server.close();
  }
});

test('paths outside the ui directory are not served', async () => {
  const { server, base } = await start();
  try {
    const escape = await fetch(`${base}/../config.json`, { redirect: 'manual' });
    assert.notEqual(escape.status, 200);
  } finally {
    server.close();
  }
});

/** Strips the `data: ` framing off one server-sent event. */
function read__frame(chunk) {
  return chunk.replace(/^data: /, '').trim();
}
