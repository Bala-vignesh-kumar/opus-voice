// Places a phone call through Retell, and knows nothing else.
//
// A device driver in the same sense as piper.mjs and whisper.mjs: it turns a
// request into HTTP and an HTTP reply into a value. Whether a call is allowed,
// what Falcon says about it, and what your answer means are all decided in
// index.mjs.
//
// NOTE: this is the second path off the machine, and the worse of the two. The
// gateway sends what *you* said. A call sends the voice of whoever answers the
// phone, who never agreed to anything. See the hard rules in CLAUDE.md — it is
// off unless configured, refuses to start without RETELL_API_KEY, and says so
// out loud at startup, for that reason.

const BASE_URL = 'https://api.retellai.com';

/**
 * How long the provider will leave the consult tool pending before giving up.
 *
 * The hold budget must sit strictly under this. If the provider times out
 * first, the agent is left holding a question with no answer and will improvise
 * one — on a live call, to a stranger, on your behalf. dial() refuses rather
 * than let that happen.
 */
export const TOOL_TIMEOUT_MS = 30_000;

/**
 * Said in the first breath of every call. Not configurable.
 *
 * Somebody picks up a phone expecting a person. The demo this feature is
 * modelled on gets this right and it costs nothing to keep.
 */
export const DISCLOSURE = 'this is Falcon, an AI assistant calling on behalf of';

/** True when a call could actually be placed. */
export function available(env = process.env) {
  return Boolean(env.RETELL_API_KEY);
}

/**
 * What the agent is told before it dials.
 *
 * Two rules do the real work: identify yourself, and never agree to anything
 * without asking. The second is what makes this feature safe to own — the
 * agent's only route to a commitment is through you.
 */
export function callPrompt({ objective, callerName }) {
  const who = callerName || 'my owner';
  return [
    `You are Falcon, a voice assistant placing a phone call for ${who}.`,
    '',
    `Open the call with: "Hi, ${DISCLOSURE} ${who}." Then say why you are calling.`,
    'Speak plainly and briefly. You are talking to a busy person, not writing.',
    '',
    `What you are calling to do: ${objective}`,
    '',
    'You may ask questions and gather options freely.',
    '',
    'You must NEVER agree to anything, book anything, cancel anything, give a',
    'card number, or promise anything on your own. The moment the call reaches',
    `a choice — a different time, a different price, anything other than what`,
    `${who} asked for — call the ask_my_boss function with a one-sentence`,
    'summary of the choice, and wait. Do not agree first and check afterwards.',
    '',
    'While ask_my_boss is running, tell them you are checking and ask them to',
    'hold for a moment.',
    '',
    'When the call is done, thank them and end it.',
  ].join('\n');
}

export class Phone {
  constructor({
    apiKey = process.env.RETELL_API_KEY || '',
    fromNumber = '',
    agentId = '',
    baseUrl = BASE_URL,
    holdMs = 20_000,
    fetch: fetchImpl = globalThis.fetch,
  } = {}) {
    this.options = { apiKey, fromNumber, agentId, baseUrl: baseUrl.replace(/\/$/, ''), holdMs };
    this.fetch = fetchImpl;
  }

  #headers() {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'content-type': 'application/json',
    };
  }

  /**
   * Place the call. Resolves to the provider's call id.
   *
   * `webhook` is where the consult tool calls back; `secret` is carried in the
   * call's metadata and echoed back to us, so a callback can be tied to this
   * call rather than merely to a URL somebody found.
   */
  async dial({ number, objective, webhook, secret, callerName = '' }) {
    if (this.options.holdMs >= TOOL_TIMEOUT_MS) {
      throw new Error(
        `hold budget ${this.options.holdMs}ms must be under the provider's `
        + `${TOOL_TIMEOUT_MS}ms tool timeout, or the agent answers for you`,
      );
    }

    const body = {
      from_number: this.options.fromNumber,
      to_number: number,
      metadata: { secret, objective },
      agent: {
        agent_id: this.options.agentId || undefined,
        response_engine: {
          type: 'retell-llm',
          general_prompt: callPrompt({ objective, callerName }),
          tools: [
            {
              type: 'custom',
              name: 'ask_my_boss',
              description:
                'Ask the owner what to do when the call reaches a choice you are '
                + 'not allowed to make. Returns their decision.',
              url: webhook,
              // The far end hears the agent narrate the wait rather than dead
              // air. Silence is what makes a held human hang up.
              speak_during_execution: true,
              timeout_ms: TOOL_TIMEOUT_MS,
              parameters: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string',
                    description: 'One sentence: the choice, and what you need decided.',
                  },
                },
                required: ['question'],
              },
            },
          ],
        },
      },
    };

    const reply = await this.#post('/v2/create-phone-call', body);
    return reply.call_id;
  }

  /**
   * End the call.
   *
   * A 404 is success: the far end hung up while we were deciding to, which is a
   * race we lose often enough that treating it as a failure would report a
   * fault on every second call.
   */
  async hangup(callId) {
    try {
      await this.#post(`/v2/end-call/${encodeURIComponent(callId)}`, {});
    } catch (err) {
      if (!/\b404\b/.test(err.message)) throw err;
    }
  }

  async #post(route, body) {
    const response = await this.fetch(`${this.options.baseUrl}${route}`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`phone provider said ${response.status}: ${detail.slice(0, 200)}`);
    }
    return response.json().catch(() => ({}));
  }
}
