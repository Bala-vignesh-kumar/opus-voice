// A public door to the loopback server, open only while a call is running.
//
// src/server.mjs binds to 127.0.0.1 on purpose. The consult tool has to reach
// it from the internet, so for the length of one call — and not a second
// longer — a cloudflared quick tunnel forwards to it. No account, no permanent
// hostname, nothing left listening afterwards.
//
// Quick tunnels take a couple of seconds to come up, which is why index.mjs
// opens this before it dials rather than in parallel: a webhook URL that is not
// live yet is a call that reaches a stranger and then cannot ask you anything.
//
// This is a child process, so the two rules that have cost this project the
// most apply here. Every pipe gets an error listener, because an unlistened one
// throws at the process. And its death fails the call, never the app.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Long enough for a quick tunnel on a slow connection, short enough to notice. */
const DEFAULT_TIMEOUT_MS = 15_000;

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Emits 'died' when the tunnel goes away underneath a running call. */
export class Tunnel extends EventEmitter {
  constructor({
    port,
    bin = 'cloudflared',
    args = null,
    env = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    super();
    this.options = { port, bin, args, env, timeoutMs };
    this.child = null;
    this.url = '';
    this.closing = false;
  }

  /** @returns {Promise<string>} the public URL forwarding to the loopback port. */
  open() {
    if (this.url) return Promise.resolve(this.url);

    const { port, bin, args, env, timeoutMs } = this.options;
    const argv = args
      ? [...args]
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];

    this.closing = false;
    this.child = spawn(bin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(url);
      };

      const timer = setTimeout(() => {
        finish(new Error(`the tunnel printed no url in ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      // cloudflared announces the hostname on stderr, inside a banner. Both
      // pipes are read anyway: which one carries it has changed between
      // versions, and a full pipe nobody drains stalls the child.
      const watch = (stream) => {
        if (!stream) return;
        stream.setEncoding('utf8');
        stream.on('error', () => {});
        stream.on('data', (text) => {
          const found = URL_PATTERN.exec(text);
          if (found && !this.url) {
            this.url = found[0];
            finish(null, this.url);
          }
        });
      };
      watch(this.child.stdout);
      watch(this.child.stderr);

      // An unlistened child pipe throws at the process. See CLAUDE.md rule 4.
      this.child.on('error', (err) => {
        this.url = '';
        finish(new Error(`the tunnel could not start: ${err.message}`));
      });

      this.child.on('exit', (code, signal) => {
        this.url = '';
        this.child = null;
        finish(new Error(`the tunnel exited (${signal || `code ${code}`}) before it was ready`));
        // Only interesting if it happened on its own. A tunnel we killed is
        // just a call that ended.
        if (!this.closing) this.emit('died', { code, signal });
      });
    });
  }

  /**
   * Take the door away.
   *
   * Called from shutdown(), where anything thrown strands the app before it
   * restores the microphone, so this resolves rather than throws — including
   * when there was never a tunnel, or it is already gone.
   */
  async close() {
    this.closing = true;
    this.url = '';
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    this.child = null;
    await new Promise((resolve) => {
      const done = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 2000);
      done.unref?.();
      child.once('exit', () => { clearTimeout(done); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(done); resolve(); }
    });
  }
}
