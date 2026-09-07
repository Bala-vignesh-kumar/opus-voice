// A turn answered by an OpenAI-compatible HTTP gateway instead of the CLI.
//
// Same events and the same four methods as ClaudeSession, so src/index.mjs
// cannot tell them apart. Two things genuinely differ, and both are here rather
// than upstream:
//
// There is no child process. Nothing can die, so 'exit' is never emitted at all
// and the give-up policy upstream — three deaths in a minute and it stops —
// simply never fires. A failed turn is reported and the next one is tried.
// restart() is a memory wipe rather than a respawn.
//
// There is no session holding the conversation. The CLI kept history inside its
// own process, which is why claude.mjs never builds a transcript; a chat
// completion is stateless and forgets everything the moment it answers, so the
// transcript is assembled here, on every request.
//
// NOTE: unlike every other backend in this app, this one sends what you say off
// the machine. See the hard rules in CLAUDE.md — it is opt-in for that reason.

import { EventEmitter } from 'node:events';

/** Past turns kept before the oldest are dropped. Each turn is two messages. */
export const DEFAULT_MAX_TURNS = 20;

/**
 * Splits an SSE byte stream into decoded `data:` payloads.
 *
 * Chunk boundaries are not frame boundaries — a frame arrives cut in half often
 * enough that treating chunks as records loses words mid-sentence — so an
 * incomplete tail is held back until the rest of it turns up.
 */
export function sseFrames() {
  const decoder = new TextDecoder();
  let buffer = '';
  return (bytes) => {
    buffer += typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true });
    const frames = [];
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) frames.push(line.slice(5).trim());
      }
    }
    return frames;
  };
}

/**
 * Emits: 'delta' (spoken text), 'thinking' (private reasoning, never spoken),
 * 'tool' (never — the gateway has no tools), 'text-end', 'turn-end', 'error',
 * 'exit'.
 */
export class GatewaySession extends EventEmitter {
  constructor({
    url = 'https://api.experientiallabs.ai/v1',
    model = 'gpt-6-astra',
    apiKey = process.env.EXPLABS_API_KEY || '',
    systemPrompt = '',
    maxTurns = DEFAULT_MAX_TURNS,
    fetch: fetchImpl = globalThis.fetch,
  } = {}) {
    super();
    this.busy = false;
    this.options = { url: url.replace(/\/$/, ''), model, apiKey, systemPrompt, maxTurns };
    this.fetch = fetchImpl;
    this.lastError = '';
    this.closed = false;
    this.controller = null;
    // Completed turns, oldest first. The persona is prepended at send time
    // rather than stored, so restart() cannot lose it.
    this.history = [];
  }

  /** The transcript as the gateway wants it, persona first. */
  #messages() {
    const { systemPrompt } = this.options;
    return systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...this.history]
      : [...this.history];
  }

  /**
   * Drops whole turns off the front until the transcript fits.
   *
   * In pairs, always: half a turn at the front leaves an assistant message with
   * no question before it, and a transcript that starts mid-answer reads as the
   * model having said something nobody asked for.
   */
  #trim() {
    const limit = this.options.maxTurns * 2 + 1;
    while (this.history.length > limit) this.history.splice(0, 2);
  }

  /** Sends a user turn. Ignored while a turn is already in flight. */
  send(text) {
    if (this.busy) return false;
    this.busy = true;
    this.history.push({ role: 'user', content: text });
    this.#trim();
    this.#turn().catch((err) => this.#fail(err));
    return true;
  }

  async #turn() {
    const { url, model, apiKey } = this.options;
    this.controller = new AbortController();

    const response = await this.fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages: this.#messages(), stream: true }),
      signal: this.controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`gateway refused the turn (${response.status}) ${detail}`.trim());
    }

    let spoken = '';
    let sawText = false;
    const frames = sseFrames();

    for await (const bytes of iterate(response.body)) {
      for (const payload of frames(bytes)) {
        if (payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;   // a keepalive or a comment, not a token
        }
        const delta = event.choices?.[0]?.delta;
        // Reasoning models put their private working here. It is surfaced for
        // the display and deliberately never routed to the synthesizer.
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) this.emit('thinking', reasoning);
        if (delta?.content) {
          spoken += delta.content;
          sawText = true;
          this.emit('delta', delta.content);
        }
      }
    }

    this.history.push({ role: 'assistant', content: spoken });
    this.busy = false;
    // Each answer is one complete utterance. Saying so lets the chunker flush
    // rather than gluing this last sentence onto the next answer's first.
    if (sawText) this.emit('text-end');
    this.emit('turn-end', { spoken });
  }

  /**
   * Ends a turn that will not finish.
   *
   * The question is taken back out of the history: left there it is a user
   * message with no answer after it, so the next turn sends two questions in a
   * row, which some models refuse outright and others answer for the wrong one.
   */
  #fail(err) {
    if (this.history.at(-1)?.role === 'user') this.history.pop();
    this.busy = false;
    this.lastError = err.message;
    // A close() mid-turn aborts the request. That is not a failure worth
    // reporting, and 'error' with nobody listening throws at the process.
    if (!this.closed && err.name !== 'AbortError') this.emit('error', err);
    this.emit('turn-end', { spoken: '', error: err.message });
  }

  /** Forgets the conversation. The persona is not stored, so it survives. */
  restart() {
    this.history = [];
    this.busy = false;
    this.lastError = '';
    this.closed = false;
  }

  close() {
    this.closed = true;
    this.busy = false;
    try {
      this.controller?.abort();
    } catch {
      // Already finished is the case this exists for.
    }
  }
}

/** Both shapes a response body arrives in: a web stream, or already iterable. */
function iterate(body) {
  if (!body) return (async function* () {})();
  if (typeof body[Symbol.asyncIterator] === 'function') return body;
  return (async function* () {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  })();
}
