// Local server for the desktop window.
//
// Server-sent events rather than a WebSocket: the traffic is almost entirely one
// direction — a stream of conversation events out — and SSE is built into both
// Node and the browser, so the app keeps its zero-dependency install. Commands
// coming back are rare enough to be ordinary POSTs.
//
// It binds to the loopback interface and requires a token generated at startup.
// Without the token any page you happened to have open could POST commands to a
// process that is allowed to edit files and run shell commands.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Serves the window and streams the conversation to it.
 *
 * @param {import('./bus.mjs').Conversation} conversation
 * @param {(command: object) => void} onCommand  what the window asks for
 */
export class UiServer {
  constructor(conversation, onCommand, { port = 4477 } = {}) {
    this.conversation = conversation;
    this.onCommand = onCommand;
    this.wanted = port;
    this.token = crypto.randomBytes(16).toString('hex');
    this.clients = new Set();
    this.server = http.createServer((req, res) => this.#route(req, res));

    // One listener for the process, fanned out to however many windows are open.
    this.conversation.on('change', (patch) => this.#broadcast(patch));
  }

  /** @returns {Promise<string>} the URL to open, token included. */
  listen() {
    return new Promise((resolve, reject) => {
      const attempt = (port, tries) => {
        this.server.once('error', (err) => {
          // A stale window from a previous run may still hold the port; stepping
          // to the next one beats refusing to start.
          if (err.code === 'EADDRINUSE' && tries > 0) return attempt(port + 1, tries - 1);
          reject(err);
        });
        this.server.listen(port, '127.0.0.1', () => {
          this.port = port;
          resolve(this.url);
        });
      };
      attempt(this.wanted, 12);
    });
  }

  get url() {
    return `http://127.0.0.1:${this.port}/?k=${this.token}`;
  }

  #authorized(req, url) {
    if (url.searchParams.get('k') === this.token) return true;
    // The page itself carries the token in its query string, so its fetches can
    // also present it in a header.
    return req.headers['x-opus-token'] === this.token;
  }

  #route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/events') {
      if (!this.#authorized(req, url)) return this.#deny(req, res);
      return this.#stream(req, res);
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      if (!this.#authorized(req, url)) return this.#deny(req, res);
      return this.#command(req, res);
    }

    return this.#static(url.pathname, req, res);
  }

  // Replying without reading the body leaves unread bytes in the socket, and on
  // a keep-alive connection that surfaces as the *next* request being reset. So
  // every early exit drains first.
  #deny(req, res) {
    req.resume();
    res.writeHead(403).end('forbidden');
  }

  #static(pathname, req, res) {
    req.resume();
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(UI, rel);
    // Never serve outside ui/, whatever the request says.
    if (!file.startsWith(UI) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.writeHead(404).end('not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }

  #stream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    // The current state first, so a window that opens mid-conversation shows
    // what has already been said instead of an empty room.
    res.write(`data: ${JSON.stringify(this.conversation.snapshot())}\n\n`);

    this.clients.add(res);
    // Comment frames keep proxies and idle timers from closing a quiet stream.
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    beat.unref?.();
    req.on('close', () => {
      clearInterval(beat);
      this.clients.delete(res);
    });
  }

  #command(req, res) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // A command is a few hundred bytes; anything larger is not one.
      if (body.length > 64_000) req.destroy();
    });
    req.on('end', () => {
      try {
        this.onCommand(JSON.parse(body));
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400).end(err.message);
      }
    });
  }

  #broadcast(patch) {
    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify(patch)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  close() {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server.close();
  }
}
