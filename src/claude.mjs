// One long-lived Claude Code process for the whole conversation.
//
// Spawning `claude -p` per turn costs process startup on every question. Kept
// alive in streaming-JSON mode instead, that cost is paid once at launch and
// conversation history is retained by the session itself, so nothing here has
// to reconstruct a transcript.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { SYSTEM_PROMPT } from './style.mjs';

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
  } = {}) {
    super();
    this.busy = false;
    this.blocks = new Map();   // stream index -> content block type

    // Overridable so an end-to-end test can run without a real Claude session.
    this.child = spawn(process.env.OPUS_VOICE_CLAUDE_BIN || 'claude', [
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

    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => this.emit('exit', code));
    this.child.stderr.on('data', (data) => {
      const text = String(data).trim();
      if (text) this.emit('stderr', text);
    });

    readline.createInterface({ input: this.child.stdout })
      .on('line', (line) => this.#onLine(line));
  }

  /** Sends a user turn. Ignored while a turn is already in flight. */
  send(text) {
    if (this.busy) return false;
    this.busy = true;
    this.child.stdin.write(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })}\n`);
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
