// One long-lived Claude Code process for the whole conversation.
//
// Spawning `claude -p` per turn costs process startup on every question. Kept
// alive in streaming-JSON mode instead, that cost is paid once at launch and
// conversation history is retained by the session itself, so nothing here has
// to reconstruct a transcript.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { SYSTEM_PROMPT } from './style.mjs';

/**
 * Places the claude CLI ends up, tried in order when PATH does not have it.
 *
 * Started from the menu bar app or at login, this process inherits launchd's
 * PATH — /usr/bin:/bin:/usr/sbin:/sbin — and Homebrew is not on it. node is
 * already handled this way on the Swift side (NODE_FALLBACKS); the CLI it goes
 * on to spawn was not, so the app came up, listened, and answered nothing.
 */
export const CLAUDE_FALLBACKS = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  `${process.env.HOME || ''}/.local/bin/claude`,
  `${process.env.HOME || ''}/.claude/local/claude`,
];

/**
 * An absolute path to the CLI: the configured one, else the first hit on PATH,
 * else a known install location.
 *
 * Falls back to the bare name when none of them exist, so the spawn fails with
 * a message that names what is missing rather than a path nobody chose.
 */
export function resolveClaudeBin(explicit, { env = process.env, fallbacks = CLAUDE_FALLBACKS } = {}) {
  const runnable = (file) => {
    try {
      return fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111) !== 0;
    } catch {
      return false;   // missing, or a directory we may not stat into
    }
  };

  if (explicit) return explicit;
  const onPath = (env.PATH || '').split(path.delimiter).filter(Boolean)
    .map((dir) => path.join(dir, 'claude'));
  return [...onPath, ...fallbacks].find(runnable) || 'claude';
}

/**
 * Emits: 'delta' (spoken text), 'thinking' (private reasoning, never spoken),
 * 'tool' (tool name, for spoken narration), 'turn-end', 'error', 'exit'.
 */
export class ClaudeSession extends EventEmitter {
  constructor({
    model = 'opus',
    effort = 'medium',
    cwd = process.cwd(),
    permissionMode = 'bypassPermissions',
    bin = process.env.FALCON_CLAUDE_BIN,
  } = {}) {
    super();
    this.busy = false;
    this.blocks = new Map();   // stream index -> content block type
    // Resolved once, not per spawn: if the CLI is going to be missing it should
    // be missing the same way after a restart as it was the first time.
    this.bin = resolveClaudeBin(bin);
    this.options = { model, effort, cwd, permissionMode };
    // The last thing it said before dying. A session that exits takes the
    // reason with it unless somebody kept it: the CLI reports rate limits,
    // expired auth and bad flags on stderr and then simply stops.
    this.lastError = '';
    this.#spawn();
  }

  #spawn() {
    const { model, effort, cwd, permissionMode } = this.options;
    // Overridable so an end-to-end test can run without a real Claude session.
    this.child = spawn(this.bin, [
      '--print',
      '--model', model,
      '--effort', effort,
      '--safe-mode',              // no CLAUDE.md, skills, or hooks fighting the voice persona
      '--no-session-persistence',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',                // required alongside stream-json output
      '--append-system-prompt', SYSTEM_PROMPT,
      // Anything that stops to ask becomes an unexplained silence with no way to
      // answer by voice, so permissions are resolved up front rather than mid-turn.
      '--permission-mode', permissionMode,
    ], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    // A spawn that never happened emits 'error' and then 'close' — never
    // 'exit'. Left there, the turn that triggered it holds `busy` for the life
    // of the process: the first question hangs on "thinking" and every question
    // after it is dropped in silence. So it is reported as an exit, which is
    // what it is, and the restart policy upstream gets to decide about it.
    this.child.on('error', (err) => {
      this.busy = false;
      this.lastError = err.message;
      this.emit('error', err);
      this.emit('exit', null, err.message);
    });
    // Same reason as the child's own error handler: an unlistened pipe throws
    // at the process. A session that dies mid-answer must not take the app.
    this.child.stdin.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => {
      // A turn that was in flight is never coming back. Left set, this wedges
      // every later question behind a `busy` that nothing will ever clear.
      this.busy = false;
      this.emit('exit', code, this.lastError);
    });
    this.child.stderr.on('data', (data) => {
      const text = String(data).trim();
      if (!text) return;
      this.lastError = text.split('\n').slice(-3).join(' ').slice(0, 400);
      this.emit('stderr', text);
    });

    readline.createInterface({ input: this.child.stdout })
      .on('line', (line) => this.#onLine(line));
  }

  /**
   * Replaces a session that has exited.
   *
   * The conversation so far is lost with it — history lived in that process —
   * so this is a fresh start, not a resume. That is still far better than the
   * alternative, which was taking the whole app down with it.
   */
  restart() {
    this.child?.removeAllListeners();
    try {
      this.child?.kill();
    } catch {
      // Already dead is the case this exists for.
    }
    this.busy = false;
    this.blocks.clear();
    this.lastError = '';
    this.#spawn();
  }

  /** Sends a user turn. Ignored while a turn is already in flight. */
  send(text) {
    if (this.busy) return false;
    this.busy = true;
    try {
      this.child.stdin.write(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })}\n`);
    } catch {
      // Raced the session's exit. The exit handler clears `busy`.
    }
    return true;
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.type === 'stream_event') {
      const event = message.event;

      if (event?.type === 'content_block_start') {
        this.blocks.set(event.index, event.content_block?.type);
        // A tool call is about to run, which means a silence. Announce the name
        // so the orchestrator can say what's happening instead of going quiet.
        if (event.content_block?.type === 'tool_use') this.emit('tool', event.content_block.name);
        return;
      }

      // Each text block is a complete utterance. Saying so lets the chunker
      // flush, rather than gluing the last sentence before a tool call onto the
      // first sentence after it.
      if (event?.type === 'content_block_stop') {
        if (this.blocks.get(event.index) === 'text') this.emit('text-end');
        this.blocks.delete(event.index);
        return;
      }

      const delta = event?.delta;
      // Thinking arrives as its own block type. It is surfaced for the terminal
      // display and deliberately never routed to the synthesizer.
      if (delta?.type === 'text_delta' && delta.text) this.emit('delta', delta.text);
      else if (delta?.type === 'thinking_delta' && delta.thinking) this.emit('thinking', delta.thinking);
      return;
    }

    if (message.type === 'result') {
      this.busy = false;
      if (message.is_error) this.emit('error', new Error(message.result || 'turn failed'));
      this.emit('turn-end', message);
    }
  }
}
